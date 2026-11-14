#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { verifyWriteAccess } from './db.mjs';
import { importCorpus } from './ingest.mjs';
import { resolveReferences } from './references.mjs';
import { generateChunks } from './chunks.mjs';
import { embedPending,azureEmbed } from './embed.mjs';
import { readBudget,reserveBudgetTokens,recordProviderUsage } from './budget.mjs';

const {values:options}=parseArgs({options:{phase:{type:'string'},fast:{type:'boolean',default:false},'chunk-concurrency':{type:'string',default:'1'},concurrency:{type:'string',default:'4'},dir:{type:'string'},apply:{type:'boolean',default:false},all:{type:'boolean',default:false},limit:{type:'string',default:'100'},after:{type:'string',default:'0'},'test-database':{type:'boolean',default:false},'ack-backup':{type:'string'},'approve-cost':{type:'boolean',default:false},'max-tokens':{type:'string',default:'0'},'batch-size':{type:'string',default:'16'},'require-vectors':{type:'boolean',default:false},'ack-destructive':{type:'boolean',default:false},'budget-file':{type:'string'},'budget-scope':{type:'string',default:'full'},'allow-production':{type:'boolean',default:false},'restore-receipt':{type:'string'},'accept-azure-ai-omission':{type:'boolean',default:false}}});
const phases=['ingest','references','chunks','embed','verify','migrate','rollback'];
if(!phases.includes(options.phase))throw Error(`Choose --phase ${phases.join('|')}`);
const limit=Number(options.limit),afterId=Number(options.after),maxTokens=Number(options['max-tokens']),batchSize=Number(options['batch-size']);
if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(maxTokens)||maxTokens<0||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>128)throw Error('Invalid numeric bounds');
if(['ingest','references'].includes(options.phase)&&!options.dir)throw Error('--dir required for this phase');
if(options.phase==='embed'&&options.apply){
 if(!options['approve-cost']||!options['budget-file'])throw Error('Paid embedding requires approval and a persisted --budget-file');
 if(readBudget(options['budget-file']).scope!==options['budget-scope'])throw Error('Budget scope differs from approved ledger');
}
const safety={apply:options.apply,testDatabase:options['test-database'],ackBackup:options['ack-backup'],allowProduction:options['allow-production'],restoreReceipt:options['restore-receipt'],acceptAzureAiOmission:options['accept-azure-ai-omission']};
const connectionString=await verifyWriteAccess(safety);
const child=async(command,args)=>{
 await new Promise((resolve,reject)=>{
  const processChild=spawn(command,args,{stdio:'inherit',env:{...process.env,DATABASE_URL:connectionString,JUDGMENT_DATABASE_URL:connectionString}});
  processChild.on('error',reject);processChild.on('close',code=>code===0?resolve():reject(Error(`${command} exited ${code}`)));
 });
};
if(options.phase==='migrate'){
 if(!options.apply)console.log(JSON.stringify({phase:'migrate',apply:false,action:'Would run reviewed Prisma migrations after database safety checks'}));
 else await child('pnpm',['exec','prisma','migrate','deploy']);
}else if(options.phase==='verify'){
 await child(process.execPath,[fileURLToPath(new URL('./verify.mjs',import.meta.url)),...(options['require-vectors']?['--require-vectors']:[])]);
}else{
 const client=new pg.Client({connectionString});await client.connect();
 try{
  if(!options.apply)await client.query('BEGIN READ ONLY');
  if(options.phase==='ingest'){
   const result=await importCorpus({client,root:options.dir,...safety,fast:options.fast,concurrency:Number(options.concurrency),onProgress:progress=>console.log(JSON.stringify({phase:'ingest',...progress})),limit:options.all?Infinity:limit});
   const counts=result.outcomes.reduce((summary,row)=>(summary[row.status]=(summary[row.status]??0)+1,summary),{});
   console.log(JSON.stringify({runId:result.runId,counts,apply:options.apply}));
   if(counts.quarantined)process.exitCode=2;
  }else if(options.phase==='references'){
   const result=await resolveReferences({client,root:options.dir,apply:options.apply,batchSize:options.fast?64:1,onProgress:progress=>console.log(JSON.stringify({phase:'references',...progress})),limit:options.all?Infinity:limit});
   console.log(JSON.stringify(result));
  }else if(options.phase==='chunks'){
   const parallel=Number(options['chunk-concurrency']);
   if(!Number.isSafeInteger(parallel)||parallel<1||parallel>4||parallel>1&&!options.fast)throw Error('Chunk concurrency requires --fast and must be 1..4');
   const {generateChunkWave}=await import('./chunks-parallel.mjs');
   const createClient=async()=>{const worker=new pg.Client({connectionString});try{await worker.connect();return worker;}catch(error){await worker.end().catch(()=>{});throw error;}};
   let cursor=afterId;
   const total={documents:0,chunks:0,tokens:0,lastDocumentId:cursor};
   for(;;){
    const result=parallel>1?await generateChunkWave({client,createClient,apply:options.apply,limit,afterId:cursor,concurrency:parallel}):await generateChunks({client,apply:options.apply,fast:options.fast,limit,afterId:cursor});
    for(const key of ['documents','chunks','tokens'])total[key]+=result[key];
    total.lastDocumentId=result.lastDocumentId;
    console.log(JSON.stringify({phase:'chunks',...result,apply:options.apply}));
    if(!options.all||result.documents===0)break;
    if(result.lastDocumentId<=cursor)throw Error('Chunk pagination made no progress');
    cursor=result.lastDocumentId;
   }
   console.log(JSON.stringify({phase:'chunks',total}));
  }else if(options.phase==='embed'){
   if(options.apply && !(await client.query("SELECT pg_try_advisory_lock(hashtextextended('clic:judgment-embedding-run',0)) AS acquired")).rows[0].acquired)throw Error('Another embedding process already owns this database');
   const total={ready:0,failed:0,requests:0,tokens:0};
   for(;;){
    const budgetFile=options['budget-file'];
    const result=await embedPending({client,apply:options.apply,embed:(inputs,config)=>azureEmbed(inputs,{...config,onUsage:usage=>recordProviderUsage(budgetFile,usage.usage.total_tokens)}),concurrency:Number(options.concurrency),beforeRequest:options.apply?request=>reserveBudgetTokens(budgetFile,{tokens:request.tokens,scope:options['budget-scope'],purpose:'judgment-embedding'}):undefined,limit,batchSize,approveCost:options['approve-cost'],maxTokens:maxTokens-total.tokens});
    if(!options.apply){console.log(JSON.stringify(result));break;}
    for(const key of ['ready','failed','requests','tokens'])total[key]+=result[key]??0;
    console.log(JSON.stringify({phase:'embed',...result}));
    if(result.failed){process.exitCode=2;break;}
    if(result.budgetExhausted){process.exitCode=3;break;}
    if(!options.all||!result.ready||total.tokens>=maxTokens)break;
   }
   if(options.apply)console.log(JSON.stringify({phase:'embed',total}));
  }else if(options.phase==='rollback'){
   if(options.apply&&!options['ack-destructive'])throw Error('Rollback deletes imported feature data; --ack-destructive required');
   if(options.apply&&process.env.JUDGMENT_FULLTEXT_ENABLED==='true')throw Error('Disable full-text feature before rollback');
   if(options.apply)await client.query(await readFile(new URL('./rollback.sql',import.meta.url),'utf8'));
   console.log(JSON.stringify({phase:'rollback',apply:options.apply,migrationHistoryRequiresReconciliation:true}));
  }
 }finally{if(!options.apply)await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
