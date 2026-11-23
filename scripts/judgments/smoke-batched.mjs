import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {importCorpus} from './ingest.mjs';
const databaseUrl=process.env.JUDGMENT_DATABASE_URL,url=new URL(databaseUrl);
assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'batched-import-')),client=new pg.Client({connectionString:databaseUrl});await client.connect();
try{
 const source=path.join(root,'HKCA/2020');for(const n of [3,4]){await fs.mkdir(path.join(source,String(n)),{recursive:true});await fs.writeFile(path.join(source,String(n),'EN.json'),JSON.stringify({content:`<p>1. ${n===3?'FAIL_BATCH':'Good batch judgment'}</p>`}));}
 await client.query(`CREATE FUNCTION fast_smoke_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content LIKE '%FAIL_BATCH%' THEN RAISE EXCEPTION 'Injected batch storage failure'; END IF; RETURN NEW; END $$`);
 await client.query('CREATE TRIGGER fast_smoke_fail BEFORE INSERT ON judgment_paragraphs FOR EACH ROW EXECUTE FUNCTION fast_smoke_fail()');
 const config={client,root,databaseUrl,testDatabase:true,apply:true,fast:true,concurrency:2,ingestBatchSize:2};
 const first=await importCorpus(config);assert.equal(first.outcomes.filter(r=>r.status==='imported').length,1);assert.equal(first.outcomes.filter(r=>r.status==='quarantined').length,1);
 assert.equal((await client.query('SELECT count(*)::int AS n FROM judgment_documents WHERE judgment_id=5')).rows[0].n,0);
 assert.equal((await client.query('SELECT count(*)::int AS n FROM judgment_documents WHERE judgment_id=6')).rows[0].n,1);
 await client.query('DROP TRIGGER fast_smoke_fail ON judgment_paragraphs');await client.query('DROP FUNCTION fast_smoke_fail()');
 const second=await importCorpus(config);assert.equal(second.outcomes.filter(r=>r.status==='imported').length,1);assert.equal(second.outcomes.filter(r=>r.status==='unchanged').length,1);
 const dry=await importCorpus({...config,apply:false});assert(dry.outcomes.every(r=>r.status==='unchanged'));
 await client.query("UPDATE judgment_documents SET source_path='other/path/EN.json' WHERE judgment_id=5");
 const conflict=await importCorpus({...config,apply:false});assert(conflict.outcomes.some(r=>r.status==='quarantined'&&r.error==='Conflicting document identity'));assert(!conflict.outcomes.some(r=>r.sourcePath==='HKCA/2020/3/EN.json'&&r.status==='would-import'));
 console.log(JSON.stringify({passed:true,batchRollbackAndIsolation:true,failedRowResumable:true,dryRun:true,providerCalls:0}));
}finally{await client.query('DROP TRIGGER IF EXISTS fast_smoke_fail ON judgment_paragraphs').catch(()=>{});await client.query('DROP FUNCTION IF EXISTS fast_smoke_fail()').catch(()=>{});await client.end();await fs.rm(root,{recursive:true,force:true});}
