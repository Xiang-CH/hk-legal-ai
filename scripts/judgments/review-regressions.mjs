#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import pg from 'pg';
import {verifyWriteAccess} from './db.mjs';
import {checksum} from './source.mjs';
import {importCorpus} from './ingest.mjs';
import {resolveReferences} from './references.mjs';
const databaseUrl=process.env.JUDGMENT_DATABASE_URL;
const url=new URL(databaseUrl);
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'judgment-review-'));
const client=new pg.Client({connectionString:databaseUrl});
const run=(script,args=[],extra={})=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:15000,env:{...process.env,JUDGMENT_DATABASE_URL:databaseUrl,...extra}});
function failed(result,pattern){assert.equal(result.error,undefined);assert.equal(result.status,1,result.stderr);assert.match(result.stderr,pattern);}
await client.connect();
try {
 const archive=path.join(root,'backup.dump');await fs.writeFile(archive,'fixture archive');
 const source='production.invalid:5432/clic_chat';const sha256=await checksum(archive);
 const manifest=path.join(root,'manifest.json'),receipt=path.join(root,'receipt.json');
 await fs.writeFile(manifest,JSON.stringify({source,sha256,archive:'backup.dump'}));
 const safety={apply:true,allowProduction:true,ackBackup:manifest,restoreReceipt:receipt,databaseUrl:'postgresql://fixture@production.invalid/clic_chat'};
 for(const count of [undefined,null,'1',0,-1,1.5,NaN]){
  await fs.writeFile(receipt,JSON.stringify({source,archiveSha256:sha256,target:'local:test',applicationDataRestored:true,strictTransactionalRestore:true,tables:{Judgment:count}}));
  await assert.rejects(verifyWriteAccess(safety),/Restore receipt/);
 }
 await fs.writeFile(receipt,JSON.stringify({source,archiveSha256:sha256,target:'local:test',applicationDataRestored:true,strictTransactionalRestore:true,tables:{Judgment:1}}));
 await verifyWriteAccess(safety);
 const corpus=path.join(root,'corpus');await fs.mkdir(path.join(corpus,'HKCFI/2020/1'),{recursive:true});
 await fs.writeFile(path.join(corpus,'HKCFI/2020/1/EN.json'),JSON.stringify({content:'<p>HCA999/2020</p>'}));
 await fs.writeFile(path.join(corpus,'HKCFI/2020/1/tc.json'),JSON.stringify({content:'<p>測試內容</p>'}));
 const existing=path.join(root,'existing');await fs.writeFile(existing,'preserve');
 failed(run('scripts/judgments/audit.mjs',['--dir',corpus,'--output',existing]),/EEXIST/);
 failed(run('scripts/judgments/audit.mjs',['--dir',corpus,'--output',path.join(root,'missing/report')]),/ENOENT/);
 assert.equal(await fs.readFile(existing,'utf8'),'preserve');
 await assert.rejects(fs.access(existing+'.summary.json'));
 const brokenPipe=spawn(process.execPath,['scripts/judgments/audit.mjs','--dir',corpus],{env:{...process.env,JUDGMENT_DATABASE_URL:databaseUrl},stdio:['ignore','pipe','pipe']});
 let pipeError='';brokenPipe.stderr.on('data',data=>{pipeError+=data;});brokenPipe.stdout.destroy();
 const pipeExit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{brokenPipe.kill();reject(Error('Audit hung on broken stdout'));},15000);brokenPipe.on('error',reject);brokenPipe.on('close',code=>{clearTimeout(timer);resolve(code);});});
 assert.equal(pipeExit,1);assert.match(pipeError,/EPIPE/);assert(!pipeError.includes('sourceDirectory'));
 const audit=run('scripts/judgments/audit.mjs',['--dir',corpus,'--output',path.join(root,'audit')]);assert.equal(audit.status,0,audit.stderr);
 for(const output of [existing,path.join(root,'missing/report')]) failed(run('scripts/judgments/pilot-embeddings.mjs',['--approve-cost',`--output=${output}`]),/EEXIST|ENOENT/);
 failed(run('scripts/judgments/references.mjs',['--dir',corpus,'--apply','--allow-production','--ack-backup',path.join(root,'absent'),'--restore-receipt',receipt,'--accept-azure-ai-omission']),/ENOENT/);
 // Exercise the resolver with empty source AND candidate citations, keeping the fixture isolated.
 await client.query('BEGIN');
 await client.query(`UPDATE "Judgment" SET "neutralCitation"='' WHERE id IN (1,2)`);
 await client.query(`INSERT INTO "Case"(id,"caseAct","actType",year,number,title,"cjrId","cjrDis") VALUES(999,'HCA999/2020','HCA',2020,999,'Review fixture',999,999) ON CONFLICT DO NOTHING`);
 await client.query('INSERT INTO "_CaseToJudgment"("A","B") VALUES(999,2) ON CONFLICT DO NOTHING');
 // Import and resolver own transactions, so use explicit cleanup by restoring the fixture after this test.
 await client.query('COMMIT');
 await importCorpus({client,root:corpus,apply:true,databaseUrl,testDatabase:true});
 await resolveReferences({client,root:corpus,apply:true});
 const reference=(await client.query("SELECT status,candidates FROM judgment_references WHERE source_id=1 AND kind='action-number' AND original='HCA999/2020'")).rows[0];
 assert.equal(reference.status,'pending');assert.deepEqual(reference.candidates,[2]);
 const {generateChunks}=await import('./chunks.mjs');await generateChunks({client,apply:true});
 const chunk=(await client.query('SELECT id,judgment_id FROM judgment_fulltext_chunks LIMIT 1')).rows[0];
 assert(chunk,'Run smoke.mjs first to create chunks');
 for(const judgment of [2147483647,6])await assert.rejects(client.query('UPDATE judgment_fulltext_chunks SET judgment_id=$1 WHERE id=$2',[judgment,chunk.id]),error=>error.code==='23503');
 const counts=()=>client.query('SELECT (SELECT count(*) FROM judgment_documents) AS documents,(SELECT count(*) FROM judgment_fulltext_chunks) AS chunks');
 const before=(await counts()).rows;
 await client.query(await fs.readFile(new URL('./integrity-down.sql',import.meta.url),'utf8'));
 await client.query(await fs.readFile(new URL('../../prisma/migrations/20261108000000_judgment_reference_integrity/migration.sql',import.meta.url),'utf8'));
 assert.deepEqual((await counts()).rows,before);
 assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conname IN ('judgment_fulltext_chunks_judgment_id_fkey','judgment_fulltext_chunks_document_id_judgment_id_fkey') AND convalidated")).rows[0].count,2);
 console.log(JSON.stringify({passed:true,checks:['strict restore counts','audit output failures','pilot output reserved before network','standalone production flags','empty citations remain pending','orphan and mismatched updates rejected','integrity down/up retains data'],providerCalls:0}));
}finally{await client.query('ROLLBACK').catch(()=>{});await client.end();await fs.rm(root,{recursive:true,force:true});}
