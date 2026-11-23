import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {importCorpus} from './ingest.mjs';
import {generateChunks} from './chunks.mjs';
import {embedPending} from './embed.mjs';
const databaseUrl=process.env.JUDGMENT_DATABASE_URL;const url=new URL(databaseUrl);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
const client=new pg.Client({connectionString:databaseUrl});const root=await fs.mkdtemp(path.join(os.tmpdir(),'verify-pages-'));await client.connect();
const verify=()=>spawnSync(process.execPath,['scripts/judgments/verify.mjs','--require-vectors'],{encoding:'utf8',env:{...process.env,JUDGMENT_DATABASE_URL:databaseUrl},timeout:30000});
try{
 await client.query(`INSERT INTO "Judgment"(id,"neutralCitation","courtName",year,number,date,"languageCode","isTranslation","legalrefUrl",url) SELECT n,'[2020] HKCFI '||n,'HKCFI',2020,n,'2020-01-01','en',false,'/en/cases/hkcfi/2020/'||n,'/en/cases/hkcfi/2020/'||n FROM generate_series(1000,1064) n ON CONFLICT DO NOTHING`);
 for(let n=1000;n<=1064;n++){const dir=path.join(root,'HKCFI/2020',String(n));await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'EN.json'),JSON.stringify({content:`<p><a id="p1">1.</a> Source paragraph ${n} includes 𠀀.</p>`}));}
 await importCorpus({client,root,databaseUrl,testDatabase:true,apply:true,fast:true});await generateChunks({client,apply:true,fast:true,limit:128});
 await embedPending({client,apply:true,testProvider:true,approveCost:true,maxTokens:1000000,limit:10000,concurrency:2,embed:async inputs=>inputs.map(()=>[1,...Array(3071).fill(0)])});
 const good=verify();assert.equal(good.status,0,good.stderr);const summary=JSON.parse(good.stdout);assert(summary.documents>64);assert(summary.completeCoverage);
 const row=(await client.query('SELECT id,content,embedding::text FROM judgment_fulltext_chunks WHERE judgment_id=1000 ORDER BY id DESC LIMIT 1')).rows[0];
 try{await client.query("UPDATE judgment_fulltext_chunks SET content='tampered' WHERE id=$1",[row.id]);assert.equal(verify().status,1);}finally{await client.query('UPDATE judgment_fulltext_chunks SET content=$2 WHERE id=$1',[row.id,row.content]);}
 try{await client.query('UPDATE judgment_fulltext_chunks SET embedding=NULL WHERE id=$1',[row.id]);assert.equal(verify().status,1);}finally{await client.query('UPDATE judgment_fulltext_chunks SET embedding=$2::halfvec WHERE id=$1',[row.id,row.embedding]);}
 console.log(JSON.stringify({passed:true,documents:summary.documents,multiplePages:true,corruptionDetected:true,missingVectorDetected:true,providerCalls:0}));
}finally{await client.end();await fs.rm(root,{recursive:true,force:true});}
