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
 const save=async(row,vector,attempts=1)=>{
  await client.query(`UPDATE judgment_fulltext_chunks SET embedding=$2::halfvec,status='ready',error=NULL,attempts=attempts+$3 WHERE id=$1`,[row.id,typeof vector==='string'?vector:JSON.stringify(vector),attempts]);ready++;
 };
 for(let offset=0;offset<rows.length;offset+=batchSize) {
  const pending=[];
  for(const row of rows.slice(offset,offset+batchSize)) {
   const cached=await client.query(`SELECT embedding::text FROM judgment_fulltext_chunks WHERE input_checksum=$1 AND embedding_input=$2 AND model=$3 AND deployment=$4 AND model_version=$5 AND status='ready' AND embedding IS NOT NULL LIMIT 1`,[row.input_checksum,row.embedding_input,row.model,row.deployment,row.model_version]);
   if(cached.rows[0]?.embedding)await save(row,cached.rows[0].embedding);else pending.push(row);
  }
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
    try{for(let index=0;index<group.length;index++)await save(group[index],vectors[index],attempts);await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');ready=beforeSave;throw error;}
   }catch(error){if(['EMBEDDING_BUDGET_ACCOUNTING_FAILED','UNEXPECTED_EMBEDDING_MODEL'].includes(error.code))throw error;for(const row of group)await client.query(`UPDATE judgment_fulltext_chunks SET status='failed',error=$2,attempts=attempts+$3 WHERE id=$1`,[row.id,String(error.message),attempts]);failed+=group.length;}
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
