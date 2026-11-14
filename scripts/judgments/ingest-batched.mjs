import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {walk,parseSourcePath,checksum,validateShape} from './source.mjs';
import {parseJudgment,PARSER_VERSION} from './parse.mjs';
import {clearManagedLinks} from './legislation-links.mjs';
const key=r=>[r.court.toUpperCase(),r.year,Number(r.number),r.language.toLowerCase()].join('|');
/** Import bounded batches with independent transactions and pooled connections. The coordinator holds the source-root lock for the complete run. */
export async function importBatched({client,root,apply=false,limit=Infinity,databaseUrl=process.env.JUDGMENT_DATABASE_URL,concurrency=4,ingestBatchSize=64,onProgress}){
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8||!Number.isSafeInteger(ingestBatchSize)||ingestBatchSize<1||ingestBatchSize>128)throw Error('Invalid import concurrency/batch size');
 root=path.resolve(root);const runId=randomUUID(),outcomes=[],seen=new Set(),jobs=new Set();let fatal;
 const pool=apply?new pg.Pool({connectionString:databaseUrl,max:concurrency,connectionTimeoutMillis:30000}):null;
 let locked=false;
 const record=async rows=>{if(apply&&rows.length)await client.query(`INSERT INTO judgment_import_files(run_id,source_path,source_checksum,status,error) SELECT $1,path,checksum,status,error FROM jsonb_to_recordset($2::jsonb) AS r(path text,checksum text,status text,error text)`,[runId,JSON.stringify(rows.map(r=>({path:r.sourcePath,checksum:r.checksum,status:r.status,error:r.error??null})))]);outcomes.push(...rows);onProgress?.({runId,processed:outcomes.length,imported:outcomes.filter(r=>r.status==='imported').length});};
 // Coordinator queries must never overlap transactions on a worker connection.
 let writes=Promise.resolve();const queueRecord=rows=>{const next=writes.then(()=>record(rows));writes=next.catch(()=>{});return next;};
 async function persist(batch){
  const worker=await pool.connect();
  try{
   await worker.query('BEGIN');
   const ids=batch.map(r=>r.judgmentId).sort((a,b)=>a-b);
   await worker.query('SELECT id FROM "Judgment" WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[ids]);
   const old=(await worker.query('SELECT id,judgment_id,source_path,source_checksum,parser_version FROM judgment_documents WHERE judgment_id=ANY($1::int[]) OR source_path=ANY($2::text[])',[ids,batch.map(r=>r.sourcePath)])).rows;
   const changed=[];const done=[];
   for(const row of batch){
    const matches=old.filter(d=>d.judgment_id===row.judgmentId||d.source_path===row.sourcePath);
    if(matches.some(d=>d.judgment_id!==row.judgmentId||d.source_path!==row.sourcePath))throw Object.assign(Error('Conflicting document identity'),{code:'DOCUMENT_CONFLICT'});
    const previous=matches[0];
    if(previous?.source_checksum===row.checksum&&previous.parser_version===PARSER_VERSION)done.push({...row,status:'unchanged'});
    else{if(previous)await clearManagedLinks(worker,row.judgmentId);changed.push(row);}
   }
   if(changed.length){
    const docs=changed.map(r=>({judgment_id:r.judgmentId,source_path:r.sourcePath,source_checksum:r.checksum,raw_html:r.html,plain_text:r.parsed.plainText,generation:randomUUID()}));
    const inserted=(await worker.query(`INSERT INTO judgment_documents(judgment_id,source_path,source_checksum,raw_html,plain_text,parser_version,generation)
     SELECT judgment_id,source_path,source_checksum,raw_html,plain_text,$2,generation FROM jsonb_to_recordset($1::jsonb) AS d(judgment_id int,source_path text,source_checksum text,raw_html text,plain_text text,generation uuid)
     ON CONFLICT(judgment_id) DO UPDATE SET source_checksum=excluded.source_checksum,raw_html=excluded.raw_html,plain_text=excluded.plain_text,parser_version=excluded.parser_version,generation=excluded.generation,imported_at=now() RETURNING id,judgment_id`,[JSON.stringify(docs),PARSER_VERSION])).rows;
    const byId=new Map(inserted.map(d=>[d.judgment_id,d.id]));
    await worker.query('DELETE FROM judgment_paragraphs WHERE document_id=ANY($1::bigint[])',[inserted.map(d=>d.id)]);
    const blocks=changed.flatMap(r=>r.parsed.blocks.map(b=>({...b,document_id:byId.get(r.judgmentId)})));
    await worker.query(`INSERT INTO judgment_paragraphs(document_id,position,label,anchor,block_type,content,html) SELECT document_id,position,label,anchor,"blockType",content,html FROM jsonb_to_recordset($1::jsonb) AS b(document_id bigint,position int,label text,anchor text,"blockType" text,content text,html text)`,[JSON.stringify(blocks)]);
    done.push(...changed.map(r=>({...r,status:'imported'})));
   }
   await worker.query('COMMIT');return done;
  }catch(error){await worker.query('ROLLBACK').catch(()=>{});throw error;}finally{worker.release();}
 }
 async function save(batch){
  let rows;
  try{rows=await persist(batch);}catch(error){
   // Split data-dependent failures only. Connection/service failures stop the run for safe retry.
   if(!/^(22|23|P0001|DOCUMENT_CONFLICT)/.test(error.code??''))throw error;
   if(batch.length>1){const middle=Math.floor(batch.length/2);await save(batch.slice(0,middle));await save(batch.slice(middle));return;}
   rows=[{...batch[0],status:'quarantined',error:error.message}];
  }
  await queueRecord(rows.map(({sourcePath,checksum,status,error})=>({sourcePath,checksum,status,error})));
 }
 try{
  if(apply){locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[root])).rows[0].acquired;if(!locked)throw Error('Another importer owns this source root');await client.query("UPDATE judgment_import_runs SET status='interrupted',completed_at=now() WHERE root=$1 AND status='running'",[root]);await client.query("INSERT INTO judgment_import_runs(id,root,parser_version,status) VALUES($1,$2,$3,'running')",[runId,root,PARSER_VERSION]);}
  const identities=new Map();
  for(const r of (await client.query('SELECT id,"courtName",year,number,"languageCode" FROM "Judgment"')).rows){const k=key({court:r.courtName,year:r.year,number:r.number,language:r.languageCode});identities.set(k,[...(identities.get(k)??[]),r.id]);}
  const existing=new Map((await client.query('SELECT judgment_id,source_path,source_checksum,parser_version FROM judgment_documents')).rows.map(d=>[d.source_path,d]));
  const existingById=new Map([...existing.values()].map(d=>[d.judgment_id,d]));
  let batch=[],bytes=0,pending=[],files=0;
  const dispatch=async()=>{if(!batch.length)return;const current=batch;batch=[];bytes=0;if(!apply){await queueRecord(current.map(r=>({sourcePath:r.sourcePath,checksum:r.checksum,status:'would-import'})));return;}const job=save(current).catch(error=>{fatal??=error;}).finally(()=>jobs.delete(job));jobs.add(job);if(jobs.size>=concurrency)await Promise.race(jobs);if(fatal)throw fatal;};
  for await(const file of walk(root)){
   if(files++>=limit)break;if(fatal)throw fatal;
   const identity=parseSourcePath(root,file),sourcePath=path.relative(root,file).split(path.sep).join('/');let digest;
   try{
    digest=await checksum(file);
    if(identity?.kind!=='content'){pending.push({sourcePath,checksum:digest,status:'skipped'});}
    else{
     if(!identity.court||!identity.year||!identity.number||!identity.language)throw Error('Incomplete source identity');
     const matches=identities.get(key(identity))??[];if(matches.length!==1)throw Error(matches.length?'Ambiguous judgment identity':'Unmatched judgment identity');
     const judgmentId=matches[0];if(seen.has(judgmentId))throw Error('Duplicate source identity');seen.add(judgmentId);
     const previous=existing.get(sourcePath);
     const byJudgment=existingById.get(judgmentId);
     if((previous&&previous.judgment_id!==judgmentId)||(byJudgment&&byJudgment.source_path!==sourcePath))throw Error('Conflicting document identity');
     if(previous?.judgment_id===judgmentId&&previous.source_checksum===digest&&previous.parser_version===PARSER_VERSION)pending.push({sourcePath,checksum:digest,status:'unchanged'});
     else{const data=JSON.parse(await readFile(file,'utf8'));const invalid=validateShape(data,identity.language);if(invalid)throw Error(invalid);const html=data.html??data.content??data.judgment??data.text;const parsed=parseJudgment(html);batch.push({sourcePath,checksum:digest,judgmentId,html,parsed});bytes+=Buffer.byteLength(html)+Buffer.byteLength(JSON.stringify(parsed));}
    }
   }catch(error){pending.push({sourcePath,checksum:digest??null,status:'quarantined',error:error.message});}
   if(pending.length>=ingestBatchSize){await queueRecord(pending);pending=[];}
   if(batch.length>=ingestBatchSize||bytes>=4*1024*1024)await dispatch();
  }
  await dispatch();await Promise.all(jobs);if(fatal)throw fatal;await queueRecord(pending);await writes;
  if(apply)await client.query("UPDATE judgment_import_runs SET status='completed',completed_at=now() WHERE id=$1",[runId]);return {runId,outcomes};
 }catch(error){await Promise.all(jobs);await writes;if(apply&&locked)await client.query("UPDATE judgment_import_runs SET status='failed',completed_at=now() WHERE id=$1",[runId]).catch(()=>{});throw error;}
 finally{if(pool)await pool.end();if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[root]).catch(()=>{});}
}
