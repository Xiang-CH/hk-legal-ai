import assert from 'node:assert/strict';
import pg from 'pg';
import {getEncoding} from 'js-tiktoken';
import {generateChunks} from './chunks.mjs';
import {embedPending} from './embed.mjs';
const url=new URL(process.env.JUDGMENT_DATABASE_URL??'');assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
const client=new pg.Client({connectionString:url.href});await client.connect();
try{
 await generateChunks({client,apply:true,fast:true});
 const reset=()=>client.query("UPDATE judgment_fulltext_chunks SET embedding=NULL,status='pending'");await reset();
 let active=0,peak=0;
 const embed=async inputs=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,40));return inputs.map(()=>[1,...Array(3071).fill(0)]);}finally{active--;}};
 let sqlActive=0;const guardedClient={query:async(...args)=>{assert.equal(sqlActive,0,'SQL operations must be serialized on the shared connection');sqlActive++;try{return await client.query(...args);}finally{sqlActive--;}}};
 const config={client:guardedClient,embed,apply:true,approveCost:true,maxTokens:100000,batchSize:1,limit:20,concurrency:2,testProvider:true,retries:0};
 const result=await embedPending(config);assert(result.ready>=2);assert.equal(result.failed,0);assert.equal(peak,2);assert.equal(active,0);
 await reset();const first=(await client.query(`SELECT c.embedding_input FROM judgment_fulltext_chunks c JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation ORDER BY c.id LIMIT 1`)).rows[0];const cap=getEncoding('cl100k_base').encode(first.embedding_input).length;
 const bounded=await embedPending({...config,maxTokens:cap,beforeRequest:async()=>{await new Promise(r=>setTimeout(r,30));}});assert.equal(bounded.requests,1);assert.equal(bounded.ready,1);assert(bounded.budgetExhausted);assert(bounded.tokens<=cap);
 await reset();let calls=0;await assert.rejects(embedPending({...config,embed:async inputs=>{const ordinal=++calls;active++;try{await new Promise(r=>setTimeout(r,20));if(ordinal===1)throw Object.assign(Error('Injected accounting failure'),{code:'EMBEDDING_BUDGET_ACCOUNTING_FAILED'});return inputs.map(()=>[1,...Array(3071).fill(0)]);}finally{active--;}}}),e=>e.code==='EMBEDDING_BUDGET_ACCOUNTING_FAILED');assert.equal(active,0);assert(calls<=2);
 console.log(JSON.stringify({passed:true,boundedConcurrency:true,atomicLocalTokenClaims:true,fatalFailureDrainsInflight:true,providerCalls:0}));
}finally{await client.end();}
