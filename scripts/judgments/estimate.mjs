#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { walk,parseSourcePath } from './source.mjs';
import { PARSER_VERSION } from './parse.mjs';

const {values:options}=parseArgs({options:{dir:{type:'string'},output:{type:'string'},limit:{type:'string'},workers:{type:'string',default:'4'}}});
const limit=options.limit===undefined?Infinity:Number(options.limit);
const workerCount=Number(options.workers);
if(!options.dir||!options.output||!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0)||!Number.isSafeInteger(workerCount)||workerCount<1||workerCount>8)throw Error('--dir, new --output, optional positive --limit and --workers 1..8 required');
if(!process.env.JUDGMENT_AUDIT_DATABASE_URL)throw Error('Explicit read-only metadata connection required');
const root=path.resolve(options.dir),output=path.resolve(options.output);
const stream=fs.createWriteStream(output,{flags:'wx',mode:0o600});
let streamError;
stream.on('error',error=>{streamError=error;});
await once(stream,'open');
const metadata=new Map();
const key=row=>[row.court.toUpperCase(),row.year,Number(row.number),row.language.toLowerCase()].join('|');
const client=new pg.Client({connectionString:process.env.JUDGMENT_AUDIT_DATABASE_URL});
const startedAt=new Date().toISOString();
let workers=[];
let workerFailure,stopping=false;
try {
 await client.connect();
 try {
  await client.query('BEGIN READ ONLY');
  const rows=(await client.query('SELECT id,"courtName",year,number,"languageCode","neutralCitation",parties FROM "Judgment"')).rows;
  for(const row of rows){const identity=key({court:row.courtName,year:row.year,number:row.number,language:row.languageCode});metadata.set(identity,[...(metadata.get(identity)??[]),row]);}
 }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
 workers=Array.from({length:workerCount},()=>{
  const worker=new Worker(new URL('./estimate-worker.mjs',import.meta.url));
  worker.on('error',error=>{workerFailure=error;});
  worker.on('exit',code=>{if(!stopping)workerFailure=Error('Estimator worker exited '+code);});
  return worker;
 });
 const idle=[...workers],inflight=new Set();
 const totals={files:0,valid:0,rejected:0,sourceBytes:0,htmlBytes:0,plainTextBytes:0,blocks:0,numberedBlocks:0,chunks:0,chunkingTokens:0,billableTokens:0};
 let queued=0,failure;
 async function record(row) {
  totals.files++;
  totals.sourceBytes+=row.sourceBytes??0;
  if(row.status==='estimated'){
   totals.valid++;
   for(const field of ['htmlBytes','plainTextBytes','blocks','numberedBlocks','chunks','chunkingTokens','billableTokens'])totals[field]+=row[field];
  }else totals.rejected++;
  if(streamError)throw streamError;
  if(!stream.write(JSON.stringify(row)+'\n'))await once(stream,'drain');
  if(totals.files%500===0)process.stderr.write(JSON.stringify({...totals,progress:true})+'\n');
 }
 function work(worker,payload) {
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{worker.off('message',received);worker.off('error',errored);worker.off('exit',exited);};
   const received=row=>{cleanup();resolve(row);};
   const errored=error=>{cleanup();reject(error);};
   const exited=code=>{cleanup();reject(Error('Estimator worker exited '+code));};
   worker.once('message',received);worker.once('error',errored);worker.once('exit',exited);
   worker.postMessage(payload);
  });
 }
 for await(const file of walk(root)) {
  const identity=parseSourcePath(root,file);
  if(identity?.kind!=='content')continue;
  if(queued>=limit)break;
  if(failure||workerFailure)throw failure??workerFailure;
  if(!idle.length)await Promise.race(inflight);
  if(failure||workerFailure)throw failure??workerFailure;
  const worker=idle.pop();
  if(worker.threadId<0)throw Error('Estimator worker unavailable');
  const task=work(worker,{file,identity,matches:metadata.get(key(identity))??[]}).then(record).finally(()=>{idle.push(worker);inflight.delete(task);});
  task.catch(error=>{failure=error;});
  inflight.add(task);queued++;
 }
 await Promise.all(inflight);
 if(failure||workerFailure)throw failure??workerFailure;
 if(streamError)throw streamError;
 stream.end();await once(stream,'finish');
 const summary={...totals,startedAt,completedAt:new Date().toISOString(),sourceRoot:root,metadataRows:metadata.size,parserVersion:PARSER_VERSION,workerCount,complete:limit===Infinity,rawVectorBytesLowerBound:totals.chunks*3072*2,priceNotAssumed:true,providerCalls:0};
 await fs.promises.writeFile(output+'.summary.json',JSON.stringify(summary,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(summary));
} finally {
 stopping=true;
 await Promise.all(workers.map(worker=>worker.terminate()));
 if(!stream.writableFinished)stream.destroy();
}
