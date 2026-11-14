#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { verifyWriteAccess } from './db.mjs';
import { importCorpus } from './ingest.mjs';

const databaseUrl=await verifyWriteAccess({apply:true,testDatabase:true});
const client=new pg.Client({connectionString:databaseUrl});await client.connect();
const root=await mkdtemp(path.join(tmpdir(),'judgment-crash-'));
let child;
try{
 const before=(await client.query('SELECT generation,raw_html FROM judgment_documents WHERE judgment_id=1')).rows[0];
 assert(before,'Run fixture smoke first');
 const directory=path.join(root,'HKCFI/2020/1');await mkdir(directory,{recursive:true});
 const file=path.join(directory,'EN.json');
 await writeFile(file,JSON.stringify({content:'<p><a id="p1">1.</a> INTERRUPT_TEST</p>'}));
 await client.query(`CREATE FUNCTION judgment_crash_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content LIKE '%INTERRUPT_TEST%' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`);
 await client.query('CREATE TRIGGER judgment_crash_sleep BEFORE INSERT ON judgment_paragraphs FOR EACH ROW EXECUTE FUNCTION judgment_crash_sleep()');
 const applicationName=`judgment-crash-${randomUUID()}`;
 const url=new URL(databaseUrl);url.searchParams.set('application_name',applicationName);
 child=spawn(process.execPath,['scripts/judgments/ingest.mjs','--dir',root,'--apply','--test-database'],{env:{...process.env,JUDGMENT_DATABASE_URL:url.href},stdio:'ignore'});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 let backend;
 for(let attempt=0;attempt<100;attempt++){
  backend=(await client.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",[applicationName])).rows[0];
  if(backend)break;
  if(child.exitCode!==null)throw Error('Importer exited before crash injection');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert(backend,'Importer never reached the controlled transaction checkpoint');
 await assert.rejects(importCorpus({client,root,apply:true,databaseUrl,testDatabase:true}),/Another importer owns/);
 assert.deepEqual((await client.query('SELECT generation,raw_html FROM judgment_documents WHERE judgment_id=1')).rows[0],before);
 child.kill('SIGKILL');
 await client.query('SELECT pg_terminate_backend($1)',[backend.pid]);
 const exit=await closed;
 assert.equal(exit.signal,'SIGKILL');
 for(let attempt=0;attempt<50;attempt++){
  if(!(await client.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[applicationName])).rows.length)break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.deepEqual((await client.query('SELECT generation,raw_html FROM judgment_documents WHERE judgment_id=1')).rows[0],before,'Crash must roll back document replacement');
 await writeFile(file,JSON.stringify({content:'<p><a id="p1">1.</a> Resumed after interrupted transaction.</p>'}));
 const resumed=await importCorpus({client,root,apply:true,databaseUrl,testDatabase:true});
 assert.equal(resumed.outcomes[0].status,'imported');
 const runs=(await client.query('SELECT status FROM judgment_import_runs WHERE root=$1',[root])).rows;
 assert(runs.some(run=>run.status==='interrupted'));
 assert(runs.some(run=>run.status==='completed'));
 assert(!runs.some(run=>run.status==='running'));
 console.log(JSON.stringify({processKilledMidTransaction:true,previousDocumentPreserved:true,concurrentImporterRejected:true,resumeSucceeded:true,orphanedRunReconciled:true,providerCalls:0}));
}finally{
 child?.kill('SIGKILL');
 await client.query('DROP TRIGGER IF EXISTS judgment_crash_sleep ON judgment_paragraphs').catch(()=>{});
 await client.query('DROP FUNCTION IF EXISTS judgment_crash_sleep()').catch(()=>{});
 await client.end();await rm(root,{recursive:true,force:true});
}
