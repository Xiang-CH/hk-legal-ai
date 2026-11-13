import { pathToFileURL } from 'node:url';
import { verifyWriteAccess } from './db.mjs';
import { getEncoding } from 'js-tiktoken';
const billingTokenizer=getEncoding('cl100k_base');
/** Embed a bounded pending batch under an explicit token budget, caching identical inputs and persisting retries without activating stale generations. */
export async function embedPending({client,embed,batchSize=8,limit=100,apply=false,approveCost=false,maxTokens=0,retries=3,testProvider=false,beforeRequest}) {
 if(!Number.isInteger(batchSize)||batchSize<1||!Number.isInteger(limit)||limit<1||!Number.isInteger(retries)||retries<0) throw Error('Invalid bounds');
 if(testProvider && process.env.NODE_ENV==='production') throw Error('Test provider prohibited in production');
 const {rows}=await client.query(`SELECT c.* FROM judgment_fulltext_chunks c JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation WHERE c.status<>'ready' ORDER BY c.id LIMIT $1`,[limit]);
 const tokenCost=row=>billingTokenizer.encode(row.embedding_input).length;
 const estimate=rows.reduce((sum,row)=>sum+tokenCost(row),0); if(!apply) return {pending:rows.length,tokens:estimate};
 if(!approveCost||!Number.isSafeInteger(maxTokens)||maxTokens<=0) throw Error('Explicit cost approval and positive token ceiling required');
 let spent=0,ready=0,requests=0,failed=0;
 const save=async(items,attempts=1)=>{
  if(!items.length)return;
  await client.query(`UPDATE judgment_fulltext_chunks c SET embedding=v.embedding::halfvec,status='ready',error=NULL,attempts=c.attempts+$2
   FROM jsonb_to_recordset($1::jsonb) AS v(id bigint,embedding text) WHERE c.id=v.id`,[JSON.stringify(items.map(({row,vector})=>({id:row.id,embedding:typeof vector==='string'?vector:JSON.stringify(vector)}))),attempts]);ready+=items.length;
 };
 for(let offset=0;offset<rows.length;offset+=batchSize) {
  const batch=rows.slice(offset,offset+batchSize);
  const cached=(await client.query(`SELECT DISTINCT ON (r.id) r.id,c.embedding::text AS embedding
   FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,input_checksum text,embedding_input text,model text,deployment text,model_version text)
   JOIN judgment_fulltext_chunks c ON c.input_checksum=r.input_checksum AND c.embedding_input=r.embedding_input AND c.model=r.model AND c.deployment=r.deployment AND c.model_version=r.model_version
   WHERE c.status='ready' AND c.embedding IS NOT NULL ORDER BY r.id,c.id`,[JSON.stringify(batch.map(({id,input_checksum,embedding_input,model,deployment,model_version})=>({id,input_checksum,embedding_input,model,deployment,model_version})))])).rows;
  const cache=new Map(cached.map(row=>[String(row.id),row.embedding]));
  await save(batch.filter(row=>cache.has(String(row.id))).map(row=>({row,vector:cache.get(String(row.id))})));
  const pending=batch.filter(row=>!cache.has(String(row.id)));
  const groups=new Map();
  for(const row of pending){const key=JSON.stringify([row.model,row.deployment,row.model_version]);groups.set(key,[...(groups.get(key)??[]),row]);}
  for(const group of groups.values()) {
   const cost=group.reduce((sum,row)=>sum+tokenCost(row),0);
   let attempts=0;
   try {
    let vectors;
    for(;;) {
     if(spent+cost>maxTokens)return {ready,failed,requests,tokens:spent,budgetExhausted:true};
     if(beforeRequest){
      try{await beforeRequest({tokens:cost,model:group[0].model,deployment:group[0].deployment,version:group[0].model_version});}
      catch(error){if(error.code==='EMBEDDING_BUDGET_EXHAUSTED')return {ready,failed,requests,tokens:spent,budgetExhausted:true};throw error;}
     }
     spent+=cost;requests++;attempts++;
     try {
      vectors=await embed(group.map(row=>row.embedding_input),{model:group[0].model,deployment:group[0].deployment,version:group[0].model_version});
      if(!Array.isArray(vectors)||vectors.length!==group.length||vectors.some(vector=>!Array.isArray(vector)||vector.length!==3072||!vector.every(Number.isFinite)||!vector.some(value=>value!==0)))throw Error('Expected one nonzero 3072-dimensional vector per input');
      break;
     }catch(error){if(attempts>retries||['EMBEDDING_BUDGET_ACCOUNTING_FAILED','UNEXPECTED_EMBEDDING_MODEL'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**(attempts-1),10000)));}
    }
    const beforeSave=ready;
    await client.query('BEGIN');
    try{await save(group.map((row,index)=>({row,vector:vectors[index]})),attempts);await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');ready=beforeSave;throw error;}
   }catch(error){if(['EMBEDDING_BUDGET_ACCOUNTING_FAILED','UNEXPECTED_EMBEDDING_MODEL'].includes(error.code))throw error;await client.query(`UPDATE judgment_fulltext_chunks SET status='failed',error=$2,attempts=attempts+$3 WHERE id=ANY($1::bigint[])`,[group.map(row=>row.id),String(error.message),attempts]);failed+=group.length;}
  }
 }
 return {ready,failed,requests,tokens:spent};
}
/** Call the configured Azure embedding deployment and validate response count/dimensions; report provider usage through the callback. */
export async function azureEmbed(inputs,{deployment,onUsage}) {
 const endpoint=process.env.AZURE_OPENAI_ENDPOINT, key=process.env.AZURE_OPENAI_KEY;
 if(!endpoint||!key) throw Error('Azure endpoint/key required');
 const {default:OpenAI}=await import('openai'); const base=endpoint.replace(/\/+$/,'').replace(/\/openai\/v1$/,'');
 const provider=new OpenAI({apiKey:key,baseURL:base+'/openai/v1/',...(/\.services\.ai\.azure\.com/.test(base)?{}:{defaultQuery:{'api-version':'preview'}}),maxRetries:0});
 const response=await provider.embeddings.create({model:deployment,input:inputs,dimensions:3072});
 try{await onUsage?.({model:response.model,usage:response.usage});}
 catch{throw Object.assign(Error('Embedding usage accounting failed; reserved budget retained'),{code:'EMBEDDING_BUDGET_ACCOUNTING_FAILED'});}
 if(response.model!=='text-embedding-3-large')throw Object.assign(Error('Unexpected embedding model; refusing incompatible vectors'),{code:'UNEXPECTED_EMBEDDING_MODEL'});
 return response.data.sort((_leftValue,_rightValue)=>_leftValue.index-_rightValue.index).map(_documentValue=>_documentValue.embedding);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.includes('--apply'))throw Error('Use run.mjs --phase embed with a persisted budget ledger for paid writes');
 const url=await verifyWriteAccess();const {Client}=await import('pg');const client=new Client({connectionString:url});await client.connect();
 try{console.log(await embedPending({client,apply:false,embed:azureEmbed}));}finally{await client.end();}
}
