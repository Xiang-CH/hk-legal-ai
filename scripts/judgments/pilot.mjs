#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { verifyWriteAccess } from './db.mjs';
import { importCorpus } from './ingest.mjs';
import { generateChunks } from './chunks.mjs';
import { resolveReferences } from './references.mjs';
pg.types.setTypeParser(1114,value=>value);

const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);if(index<0||!args[index+1])throw Error(`Required ${name}`);return args[index+1];};
const sourceRoot=path.resolve(option('--source'));
const audit=option('--audit');
const root=path.resolve(option('--output'));
if(root===sourceRoot || !root.startsWith('/tmp/')) throw Error('Pilot copies must use a separate /tmp/ output directory');
const databaseUrl=await verifyWriteAccess({apply:true,testDatabase:true});
const source=new pg.Client({connectionString:process.env.JUDGMENT_AUDIT_DATABASE_URL,connectionTimeoutMillis:10000});
if(!process.env.JUDGMENT_AUDIT_DATABASE_URL)throw Error('Explicit read-only metadata source required');
const target=new pg.Client({connectionString:databaseUrl});
const selected=new Map();
const large=[];
for await(const line of createInterface({input:createReadStream(audit),crlfDelay:Infinity})) {
 const row=JSON.parse(line);
 if(row.status!=='matched')continue;
 const key=[row.court,row.language].join('|');
 if(!selected.has(key))selected.set(key,row);
 if(large.length<4 && (await stat(path.join(sourceRoot,row.path))).size>500000)large.push(row);
}
const rows=[...new Map([...selected.values(),...large].map(row=>[row.path,row])).values()];
await source.connect();await target.connect();
try {
 await source.query('BEGIN READ ONLY');
 const empty=await target.query('SELECT count(*)::int AS count FROM "Judgment"');
 if(empty.rows[0].count)throw Error('Pilot requires an empty migrated disposable database');
 const citations=new Set();const reports=new Set();const capNumbers=new Set();const sectionNumbers=new Set();
 for(const row of rows) {
  const file=path.join(sourceRoot,row.path),destination=path.join(root,row.path);
  await mkdir(path.dirname(destination),{recursive:true});await copyFile(file,destination);
  const data=JSON.parse(await readFile(file,'utf8'));
  for(const value of data.noteup_links?.judgment?.neutral??[])citations.add(value);
  for(const value of data.noteup_links?.judgment?.parallel??[])reports.add(value);
  for(const value of data.noteup_links?.legis??[]) {
   const match=value.match(/\/legis\/(?:ord|reg)\/([^/]+)(?:\/s([^/]+))?/i);
   if(match){capNumbers.add(match[1]);if(match[2])sectionNumbers.add(match[2]);}
  }
  const sidecar=file.replace(/\.json$/i,'_cit.json');
  try{await copyFile(sidecar,destination.replace(/\.json$/i,'_cit.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const judgments=(await source.query(`SELECT * FROM "Judgment" WHERE id=ANY($1::int[]) OR "neutralCitation"=ANY($2::text[]) OR id IN(SELECT "judgmentId" FROM "ParallelCitations" WHERE citation=ANY($3::text[]))`,[rows.map(row=>row.judgmentId),[...citations],[...reports]])).rows;
 const ids=judgments.map(row=>row.id);
 const aliases=(await source.query('SELECT * FROM "ParallelCitations" WHERE "judgmentId"=ANY($1::int[])',[ids])).rows;
 const cases=(await source.query('SELECT * FROM "Case" WHERE id IN(SELECT "A" FROM "_CaseToJudgment" WHERE "B"=ANY($1::int[]))',[ids])).rows;
 const memberships=(await source.query('SELECT * FROM "_CaseToJudgment" WHERE "B"=ANY($1::int[])',[ids])).rows;
 const caps=(await source.query('SELECT * FROM "LegislationCap" WHERE "capNumber"=ANY($1::text[])',[[...capNumbers]])).rows;
 const sections=(await source.query('SELECT * FROM "LegislationSection" WHERE "capNumber"=ANY($1::text[]) AND "sectionNumber"=ANY($2::text[])',[[...capNumbers],[...sectionNumbers]])).rows;
 await source.query('ROLLBACK');
 await target.query('BEGIN');
 try {
  for(const [table,data] of [['Judgment',judgments],['ParallelCitations',aliases],['Case',cases],['_CaseToJudgment',memberships],['LegislationCap',caps],['LegislationSection',sections]]) {
   if(data.length)await target.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`,[JSON.stringify(data)]);
  }
  await target.query('COMMIT');
 }catch(error){await target.query('ROLLBACK');throw error;}
 const imported=await importCorpus({client:target,root,apply:true,databaseUrl,testDatabase:true});
 const repeated=await importCorpus({client:target,root,apply:true,databaseUrl,testDatabase:true});
 const references=await resolveReferences({client:target,root,apply:true});
 const chunks=await generateChunks({client:target,limit:rows.length,apply:true});
 const result={createdAt:new Date().toISOString(),sourceFiles:rows.map(row=>row.path),metadataJudgments:judgments.length,importStatuses:imported.outcomes.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{}),repeatedStatuses:repeated.outcomes.reduce((counts,row)=>(counts[row.status]=(counts[row.status]??0)+1,counts),{}),references:references.counts,chunks,paidProviderCalls:0};
 await writeFile(path.join(root,'pilot-report.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result,null,2));
}finally{await source.query('ROLLBACK').catch(()=>{});await source.end();await target.end();}
