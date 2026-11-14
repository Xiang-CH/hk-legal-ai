import {generateChunksBatched} from './chunks-batched.mjs';

// Publish a checkpoint only after every disjoint page in the wave has committed.
// A failed wave can safely be replayed: generation upserts preserve ready vectors.
export async function generateChunkWave({client,createClient,limit=64,afterId=0,concurrency=2,apply=false}) {
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(afterId)||afterId<0)throw Error('Invalid chunk wave bounds');
 const ids=(await client.query('SELECT id FROM judgment_documents WHERE id>$1 ORDER BY id LIMIT $2',[afterId,limit*concurrency])).rows.map(r=>Number(r.id));
 const jobs=[];
 for(let offset=0;offset<ids.length;offset+=limit){
  const lower=offset===0?afterId:ids[offset-1],upper=ids[Math.min(offset+limit,ids.length)-1];
  jobs.push((async()=>{
   const worker=await createClient();
   try{return await generateChunksBatched({client:worker,limit,afterId:lower,throughId:upper,apply});}
   finally{await worker.end();}
  })());
 }
 const settled=await Promise.allSettled(jobs);
 const failed=settled.find(r=>r.status==='rejected');
 if(failed)throw failed.reason;
 const total={documents:0,chunks:0,tokens:0,lastDocumentId:ids.at(-1)??afterId};
 for(const result of settled)for(const key of ['documents','chunks','tokens'])total[key]+=result.value[key];
 return total;
}
