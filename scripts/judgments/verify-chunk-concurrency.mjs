import assert from 'node:assert/strict';
import pg from 'pg';
import {generateChunksBatched} from './chunks-batched.mjs';
import {generateChunkWave} from './chunks-parallel.mjs';

const connectionString=process.env.JUDGMENT_DATABASE_URL;
const url=new URL(connectionString);
assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
const client=new pg.Client({connectionString});await client.connect();
let live=0,peak=0;
const createClient=async()=>{
 const worker=new pg.Client({connectionString});await worker.connect();live++;peak=Math.max(peak,live);
 const end=worker.end.bind(worker);worker.end=async()=>{try{await end();}finally{live--;}};
 return worker;
};
const snapshot=async()=>(await client.query('SELECT document_id,generation,chunk_no,content_checksum,input_checksum,spans,token_count,status,embedding::text FROM judgment_fulltext_chunks ORDER BY document_id,generation,chunk_no')).rows;
try{
 const ids=(await client.query('SELECT id FROM judgment_documents ORDER BY id')).rows;
 assert(ids.length>=3,'Requires a populated local fixture');
 let cursor=0;
 for(;;){const page=await generateChunksBatched({client,apply:true,limit:2,afterId:cursor});if(!page.documents)break;cursor=page.lastDocumentId;}
 const before=await snapshot();
 let count=0;cursor=0;
 for(;;){const page=await generateChunkWave({client,createClient,apply:true,limit:2,afterId:cursor,concurrency:2});if(!page.documents)break;count+=page.documents;cursor=page.lastDocumentId;}
 assert.equal(count,ids.length);assert.equal(peak,2);assert.equal(live,0);assert.deepEqual(await snapshot(),before);
 let calls=0;
 await assert.rejects(generateChunkWave({client,apply:true,limit:2,concurrency:2,createClient:async()=>{
  const worker=await createClient();if(++calls===2){const query=worker.query.bind(worker);worker.query=(sql,...args)=>sql.startsWith('SELECT d.id')?Promise.reject(Error('injected worker failure')):query(sql,...args);}
  return worker;
 }}),/injected worker failure/);
 assert.equal(live,0,'Failure must drain other workers before returning');
 await generateChunkWave({client,createClient,apply:true,limit:2,concurrency:2});
 assert.deepEqual(await snapshot(),before);
 console.log(JSON.stringify({passed:true,documents:count,peakWorkers:peak,serialOutputIdentical:true,failedWaveReplaySafe:true}));
}finally{await client.end();}
