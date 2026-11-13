import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyWriteAccess } from './db.mjs';
import { syncManagedLinks } from './legislation-links.mjs';
import { walk, parseSourcePath, checksum } from './source.mjs';

const VERSION = 'references-2';
const normalize = value => String(value).normalize('NFC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().replace(/^\[(\d{4})\]\s*(HK[A-Z]+)\s*(\d+)$/, '[$1] $2 $3');
/** Normalize supported HKLII aliases to a case path while rejecting non-HTTP links. */
const urlKey = value => {
  try {
    const url = new URL(value, 'https://hklii.hk');
    if(!['http:','https:'].includes(url.protocol)) return null;
    if(['hklii.hk','www.hklii.hk','hklii.org','www.hklii.org'].includes(url.hostname)) {
      return url.pathname.toLowerCase().replace(/^\/eng\/hk\/cases\//,'/en/cases/').replace(/^\/chi\/hk\/cases\//,'/tc/cases/').replace(/\.html?$/,'').replace(/\/$/,'');
    }
    url.hash='';url.searchParams.sort();return url.href;
  }catch{return null;}
};
const neutral = /\[\d{4}\]\s+HK[A-Z]+\s+\d+/gi;
const reported = /(?:\[\d{4}\]|\(\d{4}\))\s+\d+\s+(?:HKLRD|HKCFAR|HKC)\s+\d+/gi;
const foreign = /\[\d{4}\]\s+(?:(?:UKSC|UKHL|UKPC|EWHC|EWCA(?:\s+(?:Civ|Crim))?)\s+\d+|(?:\d+\s+)?(?:AC|WLR|All\s+ER|QB|Ch)\s+\d+)|\(\d{4}\)\s+\d+\s+(?:CLR|FCR)\s+\d+|\b\d+\s+U\.S\.\s+\d+/gi;
const action = /\b[A-Z]{2,8}\s*\d+[A-Z]?\s*\/\s*\d{4}\b/g;
/** Extract citation and link evidence from judgment HTML, excluding non-content elements. */
function inspect(html) {
  const found = [];
  function visit(node, anchor = null) {
    if (['script','style','nav','head'].includes(node.tagName)) return;
    const attrs = Object.fromEntries((node.attrs ?? []).map(_leftValue => [_leftValue.name,_leftValue.value]));
    anchor = attrs.id ?? attrs.name ?? anchor;
    if (node.nodeName === '#text') {
      for (const pattern of [neutral,reported,foreign]) for (const _match of node.value.matchAll(pattern)) found.push({kind:'citation',original:_match[0],anchor,method:'html-text'});
    }
    if (node.tagName === 'a' && attrs.href) {
      const text = _node => _node.value ?? (_node.childNodes ?? []).map(text).join('');
      found.push({kind:'url',original:attrs.href,text:text(node),anchor,method:'html-link'});
    }
    for (const child of node.childNodes ?? []) visit(child,anchor);
  }
  visit(parse(html));
  return found;
}
/** Resolve one decision with a preferred language; retain candidate IDs when identity or language is ambiguous. */
function choose(rows, language) {
  const decisions = new Set(rows.map(_row => normalize(_row.neutralCitation || `${_row.courtName}/${_row.year}/${_row.number}`)));
  if (!rows.length) return {status:'not-in-corpus',target:null,candidates:[]};
  if (decisions.size !== 1) return {status:'ambiguous',target:null,candidates:rows.map(_row2=>_row2.id)};
  const preferred = rows.filter(_row3=>_row3.languageCode===language);
  if (preferred.length > 1) return {status:'ambiguous',target:null,candidates:rows.map(_row4=>_row4.id)};
  return {status:'resolved',target:(preferred[0] ?? [...rows].sort((_leftValue2,_rightValue)=>_leftValue2.id-_rightValue.id)[0]).id,candidates:rows.map(_row5=>_row5.id)};
}
const values = _value => Array.isArray(_value) ? _value.filter(_value2=>typeof _value2==='string') : [];

/** Resolve current-generation evidence per document, retaining ambiguous/pending references and provenance. Apply mode replaces each source transactionally. */
export async function resolveReferences({client,root,limit=Infinity,apply=false,outcomeLimit=1000,batchSize=1,onProgress}) {
  if (!root || !(limit===Infinity || Number.isSafeInteger(limit) && limit>=0)) throw new Error('root and nonnegative integer limit required');
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>128)throw Error('Invalid reference batch size');
  const prepared=[];let pageHtml=new Map(),pageParagraphs=new Map(),documentIndex=0;
  const flushPrepared=async()=>{if(!prepared.length)return;const {writeReferenceBatch}=await import('./references-batched.mjs');await writeReferenceBatch(client,prepared);prepared.length=0;};
  const judgments = (await client.query('SELECT id,"neutralCitation","courtName",year,number,"languageCode",url,"legalrefUrl" FROM "Judgment"')).rows;
  const documents = (await client.query('SELECT id,judgment_id,source_path,source_checksum,generation FROM judgment_documents ORDER BY id')).rows;
  const aliases = (await client.query('SELECT "judgmentId" AS judgment_id,citation AS original FROM "ParallelCitations"')).rows;
  const outcomes = [];
  const counts = {};
  const record = outcome => {counts[outcome.status]=(counts[outcome.status] ?? 0)+1; if(outcomes.length<outcomeLimit) outcomes.push(outcome);};
  const byId = new Map(judgments.map(row=>[row.id,row]));
  const identityKey = (court,year,number,language) => [normalize(court),year,number,normalize(language)].join('|');
  const byIdentity = new Map();
  for (const row of judgments) {
    const key = identityKey(row.courtName,row.year,row.number,row.languageCode);
    byIdentity.set(key,[...(byIdentity.get(key) ?? []),row]);
  }
  for await (const file of walk(root)) {
    const identity = parseSourcePath(root,file);
    if (identity?.kind !== 'sidecar') continue;
    const matches = byIdentity.get(identityKey(identity.court,identity.year,Number(identity.number),identity.language)) ?? [];
    if (matches.length!==1) { record({file,status:'unmatched-or-ambiguous-sidecar'}); continue; }
    try {
      const data=JSON.parse(await readFile(file,'utf8'));
      if(!Array.isArray(data)||data.some(value=>typeof value!=='string'))throw Error('Expected citation array');
      for (const original of data) aliases.push({judgment_id:matches[0].id,original});
    }
    catch(_error) { record({file,status:'invalid-sidecar',error:_error.message}); }
  }
  const caps = (await client.query('SELECT id,"capNumber","languageCode",url,"eLegislationUrl" FROM "LegislationCap"')).rows;
  const sections = (await client.query('SELECT id,"capNumber","sectionNumber","subsectionNumber","languageCode",url,"eLegislationUrl" FROM "LegislationSection"')).rows;
  const caseCandidates=new Map();
  const memberships=(await client.query('SELECT c."caseAct",r."B" AS id FROM "Case" c JOIN "_CaseToJudgment" r ON r."A"=c.id')).rows;
  for(const membership of memberships) {
    const key=normalize(membership.caseAct).replace(/\s/g,'');
    const ids=caseCandidates.get(key)??[];if(!ids.includes(membership.id))ids.push(membership.id);caseCandidates.set(key,ids);
  }
  const citationLookup = new Map();
  const urlLookup = new Map();
  const add = (map,key,row) => { const entries=map.get(key) ?? []; if(!entries.some(existing=>existing.id===row.id)) entries.push(row); map.set(key,entries); };
  const capLookup=new Map(),sectionLookup=new Map(),capUrls=new Map(),sectionUrls=new Map();
  for(const cap of caps) {
    add(capLookup,normalize(cap.capNumber),cap);
    for(const url of [cap.url,cap.eLegislationUrl])if(url)add(capUrls,url,cap);
  }
  for(const section of sections) {
    if(!section.subsectionNumber)add(sectionLookup,[normalize(section.capNumber),normalize(section.sectionNumber)].join('|'),section);
    for(const url of [section.url,section.eLegislationUrl])if(url)add(sectionUrls,url,section);
  }
  for (const row of judgments) {
    add(citationLookup,normalize(row.neutralCitation),row);
    for (const url of [row.url,row.legalrefUrl]) if(url && urlKey(url)) add(urlLookup,urlKey(url),row);
  }
  for (const alias of aliases) if(byId.has(alias.judgment_id)) add(citationLookup,normalize(alias.original),byId.get(alias.judgment_id));
  if(apply) {
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO judgment_citation_aliases(judgment_id,original,normalized,provenance)
        SELECT judgment_id,original,normalized,$2::jsonb FROM jsonb_to_recordset($1::jsonb) AS aliases(judgment_id int,original text,normalized text) ON CONFLICT DO NOTHING`,[JSON.stringify(aliases.map(alias=>({...alias,normalized:normalize(alias.original)}))),JSON.stringify({method:'parallel-or-sidecar',version:VERSION})]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
  }
  for (const metadata of documents.slice(0,limit)) {
    if(batchSize>1 && documentIndex%batchSize===0){
      const ids=documents.slice(documentIndex,Math.min(documentIndex+batchSize,limit)).map(d=>d.id);
      pageHtml=new Map((await client.query('SELECT id,raw_html FROM judgment_documents WHERE id=ANY($1::bigint[])',[ids])).rows.map(r=>[String(r.id),r.raw_html]));
      pageParagraphs=new Map();for(const row of (await client.query('SELECT id,document_id,anchor,html,content FROM judgment_paragraphs WHERE document_id=ANY($1::bigint[]) ORDER BY document_id,position',[ids])).rows){const k=String(row.document_id);const group=pageParagraphs.get(k)??[];group.push(row);pageParagraphs.set(k,group);}
    }
    documentIndex++;
    const doc = {...metadata,...(batchSize>1?{raw_html:pageHtml.get(String(metadata.id))}:(await client.query('SELECT raw_html FROM judgment_documents WHERE id=$1',[metadata.id])).rows[0])};
    const source = byId.get(doc.judgment_id);
    if (!source) continue;
    const sourceFile=path.resolve(root,doc.source_path);
    if(await checksum(sourceFile)!==doc.source_checksum) {record({sourceId:source.id,status:'stale-source'});continue;}
    const data = JSON.parse(await readFile(sourceFile,'utf8'));
    const evidence = [];
    const paragraphs = batchSize>1?pageParagraphs.get(String(doc.id))??[]:(await client.query('SELECT id,anchor,html,content FROM judgment_paragraphs WHERE document_id=$1',[doc.id])).rows;
    for (const paragraph of paragraphs) {
      for (const _referenceEvidence of inspect(paragraph.html ?? '').filter(item=>item.kind==='url')) evidence.push({..._referenceEvidence,paragraph_id:paragraph.id,anchor:paragraph.anchor ?? _referenceEvidence.anchor});
      for (const pattern of [neutral,reported,foreign]) for (const match of paragraph.content.matchAll(pattern)) evidence.push({kind:'citation',original:match[0],paragraph_id:paragraph.id,anchor:paragraph.anchor,offset:match.index,method:'paragraph-text'});
      for(const match of paragraph.content.matchAll(action))evidence.push({kind:'action-number',original:match[0],paragraph_id:paragraph.id,anchor:paragraph.anchor,offset:match.index,method:'paragraph-text'});
    }
    const locatedUrls=new Set(evidence.filter(item=>item.kind==='url').map(item=>item.original));
    for(const item of inspect(doc.raw_html))if(item.kind==='url'&&!locatedUrls.has(item.original))evidence.push(item);
    const notes = data.noteup_links ?? {};
    for (const original of [...values(notes.judgment?.neutral),...values(notes.judgment?.parallel)]) {
      evidence.push({kind:'citation',original,method:'noteup',confirmed:evidence.some(_referenceEvidence2=>normalize(_referenceEvidence2.original)===normalize(original) || normalize(_referenceEvidence2.text ?? '')===normalize(original))});
    }
    for (const original of values(notes.legis)) evidence.push({kind:'url',original,method:'noteup-legislation'});
    if (apply && batchSize===1) await client.query('BEGIN');
    try {
      if (apply && batchSize===1) {
        await client.query('SELECT id FROM "Judgment" WHERE id=$1 FOR UPDATE',[source.id]);
        const current=(await client.query('SELECT generation::text FROM judgment_documents WHERE id=$1',[doc.id])).rows[0];
        if(current?.generation!==String(doc.generation)) {await client.query('ROLLBACK');record({sourceId:source.id,status:'generation-changed'});continue;}
        await client.query('DELETE FROM judgment_references WHERE source_id=$1',[source.id]);
        await client.query('DELETE FROM judgment_legislation_references WHERE source_id=$1',[source.id]);
      }
      let ordinal=0;
      const referenceRows=new Map(),legislationRows=new Map(),occurrenceRows=[];
      const referenceKey=(kind,normalized)=>JSON.stringify([kind,normalized]);
      const priority={resolved:5,self:4,ambiguous:3,'not-in-corpus':2,pending:1};
      for (const _referenceEvidence3 of evidence) {
        const key=normalize(_referenceEvidence3.original);
        const legislation = /(?:elegislation|legislation)\.gov\.hk|\/cap\d|\/(?:en|tc|sc)\/legis\/(?:ord|reg)\//i.test(_referenceEvidence3.original);
        if (legislation) {
          const parsed = _referenceEvidence3.original.match(/\/(?:en|tc|sc)\/legis\/(?:ord|reg)\/([^/]+)(?:\/s([^/#?]+))?/i);
          const exact = sectionUrls.get(_referenceEvidence3.original) ?? (parsed?.[2] ? sectionLookup.get([normalize(parsed[1]),normalize(parsed[2])].join('|')) : []) ?? [];
          const capMatches = capUrls.get(_referenceEvidence3.original) ?? (parsed && !parsed[2] ? capLookup.get(normalize(parsed[1])) : []) ?? [];
          const candidates = exact.length ? exact : capMatches;
          const preferred = candidates.filter(_entry=>_entry.languageCode===source.languageCode);
          const selected = preferred.length===1 ? preferred[0] : candidates.length===1 ? candidates[0] : null;
          const status = selected ? 'resolved' : candidates.length ? 'ambiguous' : 'not-in-corpus';
          const row={source_id:source.id,original:_referenceEvidence3.original,normalized:key,status,cap_id:selected&&!exact.length?selected.id:null,section_id:selected&&exact.length?selected.id:null,candidates:candidates.map(candidate=>candidate.id),provenance:{generation:doc.generation,..._referenceEvidence3}};
          const previous=legislationRows.get(key);
          if(!previous||priority[status]>priority[previous.status])legislationRows.set(key,row);
          record({sourceId:source.id,kind:'legislation',original:_referenceEvidence3.original,status});
          continue;
        }
        const matches = _referenceEvidence3.kind==='url' ? urlLookup.get(urlKey(_referenceEvidence3.original)) ?? [] : citationLookup.get(key) ?? [];
        let result = choose(matches,source.languageCode);
        if(_referenceEvidence3.kind==='action-number')result={status:'pending',target:null,candidates:caseCandidates.get(key.replace(/\s/g,''))??[]};
        if(_referenceEvidence3.method==='noteup' && !_referenceEvidence3.confirmed) result={...result,status:'pending',target:null};
        const sourceCitation=normalize(source.neutralCitation);
        if(result.target===source.id || sourceCitation && result.candidates.length && result.candidates.every(id=>{
          const targetCitation=normalize(byId.get(id)?.neutralCitation);
          return targetCitation && targetCitation===sourceCitation;
        })) result={...result,status:'self',target:null};
        if(_referenceEvidence3.kind==='url' && !matches.length && !/judg|legalref|\/cases\//i.test(_referenceEvidence3.original)) continue;
        if(apply) {
          const identity=referenceKey(_referenceEvidence3.kind,key);
          const previous=referenceRows.get(identity);
          if(!previous||priority[result.status]>priority[previous.status])referenceRows.set(identity,{source_id:source.id,kind:_referenceEvidence3.kind,original:_referenceEvidence3.original,normalized:key,status:result.status,target_id:result.target,candidates:result.candidates,provenance:{sourcePath:doc.source_path,generation:doc.generation,..._referenceEvidence3},resolver_version:VERSION});
          occurrenceRows.push({identity,evidence_key:String(ordinal++),paragraph_id:_referenceEvidence3.paragraph_id??null,anchor:_referenceEvidence3.anchor??null,evidence:_referenceEvidence3});
        }
        record({sourceId:source.id,original:_referenceEvidence3.original,...result});
      }
      if(apply && batchSize>1){prepared.push({sourceId:source.id,documentId:doc.id,generation:doc.generation,references:[...referenceRows.values()],legislation:[...legislationRows.values()],occurrences:occurrenceRows});if(prepared.length>=batchSize)await flushPrepared();}
      if(apply && batchSize===1) {
        if(referenceRows.size) {
          const inserted=await client.query(`INSERT INTO judgment_references(source_id,kind,original,normalized,status,target_id,candidates,provenance,resolver_version)
            SELECT source_id,kind,original,normalized,status,target_id,candidates,provenance,resolver_version FROM jsonb_to_recordset($1::jsonb)
            AS records(source_id int,kind text,original text,normalized text,status text,target_id int,candidates jsonb,provenance jsonb,resolver_version text)
            RETURNING id,kind,normalized`,[JSON.stringify([...referenceRows.values()])]);
          const ids=new Map(inserted.rows.map(row=>[referenceKey(row.kind,row.normalized),row.id]));
          const occurrences=occurrenceRows.map(({identity,...row})=>({...row,reference_id:ids.get(identity)}));
          await client.query(`INSERT INTO judgment_reference_occurrences(reference_id,evidence_key,paragraph_id,anchor,evidence)
            SELECT reference_id,evidence_key,paragraph_id,anchor,evidence FROM jsonb_to_recordset($1::jsonb)
            AS records(reference_id bigint,evidence_key text,paragraph_id bigint,anchor text,evidence jsonb)`,[JSON.stringify(occurrences)]);
        }
        if(legislationRows.size)await client.query(`INSERT INTO judgment_legislation_references(source_id,original,normalized,status,cap_id,section_id,candidates,provenance)
          SELECT source_id,original,normalized,status,cap_id,section_id,candidates,provenance FROM jsonb_to_recordset($1::jsonb)
          AS records(source_id int,original text,normalized text,status text,cap_id int,section_id int,candidates jsonb,provenance jsonb)`,[JSON.stringify([...legislationRows.values()])]);
        await syncManagedLinks(client,source.id);await client.query('COMMIT');
      }
    } catch(_error2) { if(apply && batchSize===1) await client.query('ROLLBACK'); throw _error2; }
    if(documentIndex%batchSize===0)onProgress?.({documents:documentIndex,counts});
  }
  if(apply)await flushPrepared();
  return {apply,version:VERSION,counts,outcomes};
}

/** Read bounded current-generation references and occurrence evidence in the requested direction. */
export async function readReferences(client,judgmentId,{direction='outgoing',limit=20}={}) {
  if(!['incoming','outgoing'].includes(direction) || !Number.isSafeInteger(limit) || limit<0 || limit>200) throw new Error('direction must be incoming/outgoing; limit must be 0..200');
  const references = await client.query(`SELECT r.* FROM judgment_references r JOIN judgment_documents d ON d.judgment_id=r.source_id AND r.provenance->>'generation'=d.generation::text WHERE ${direction==='incoming'?"r.target_id=$1 AND r.status='resolved'":"r.source_id=$1 AND r.status<>'self'"} ORDER BY r.id LIMIT $2`,[judgmentId,limit]);
  const legislation = await client.query('SELECT r.* FROM judgment_legislation_references r JOIN judgment_documents d ON d.judgment_id=r.source_id AND r.provenance->>\'generation\'=d.generation::text WHERE r.source_id=$1 ORDER BY r.id LIMIT $2',[judgmentId,limit]);
  const occurrences = await client.query('SELECT * FROM judgment_reference_occurrences WHERE reference_id=ANY($1::bigint[]) ORDER BY id LIMIT $2',[references.rows.map(_row6=>_row6.id),limit]);
  return {direction,references:references.rows,occurrences:occurrences.rows,legislation:legislation.rows};
}

/** Validate CLI safety flags before opening the database; dry runs use a read-only transaction. */
async function main() {
  const {values:options}=parseArgs({options:{dir:{type:'string'},limit:{type:'string'},apply:{type:'boolean',default:false},'test-database':{type:'boolean',default:false},'ack-backup':{type:'string'},'allow-production':{type:'boolean',default:false},'restore-receipt':{type:'string'},'accept-azure-ai-omission':{type:'boolean',default:false}}});
  if(!options.dir)throw Error('--dir required');
  const connectionString=await verifyWriteAccess({apply:options.apply,testDatabase:options['test-database'],ackBackup:options['ack-backup'],allowProduction:options['allow-production'],restoreReceipt:options['restore-receipt'],acceptAzureAiOmission:options['accept-azure-ai-omission']});
  const {Client}=await import('pg');
  const client=new Client({connectionString});await client.connect();
  try {
    if(!options.apply)await client.query('BEGIN READ ONLY');
    const result=await resolveReferences({client,root:path.resolve(options.dir),limit:options.limit===undefined?Infinity:Number(options.limit),apply:options.apply});
    console.log(JSON.stringify(result,null,2));
  }finally{if(!options.apply)await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
