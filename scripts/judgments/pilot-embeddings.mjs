#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { getEncoding } from 'js-tiktoken';
import { azureEmbed } from './embed.mjs';
import { verifyWriteAccess } from './db.mjs';

if(!process.argv.includes('--approve-cost'))throw Error('Explicit pilot cost approval required');
const url=await verifyWriteAccess({apply:true,testDatabase:true});
const output=process.argv.find(value=>value.startsWith('--output='))?.slice('--output='.length);
if(!output)throw Error('--output=NEW_REPORT required');
const priceUrl=new URL('https://prices.azure.com/api/retail/prices');
priceUrl.searchParams.set('$filter',"contains(meterName, 'embedding')");
const priceResponse=await fetch(priceUrl);
if(!priceResponse.ok)throw Error('Cannot verify retail price ceiling');
const prices=await priceResponse.json();
const meters=prices.Items.filter(row=>/large/i.test(row.meterName)&&/OpenAI/i.test(row.productName)&&row.unitOfMeasure==='1K'&&row.currencyCode==='USD'&&row.retailPrice>0);
assert(meters.length>0&&!prices.NextPageLink,'Complete primary-source pricing snapshot required');
const pricePerMillion=Math.max(...meters.map(row=>row.retailPrice))*1000;
const approvedUsd=1;
const billing=getEncoding('cl100k_base');
const tests=[
 {source:'HKDC/1900/1/EN.json',term:'matchbox',query:'A printer and a matchbox manufacturer disagree over approval of advertising samples and whether the printing contract was breached.'},
 {source:'HKLaT/2012/1/TC.json',term:'遣散費',query:'清潔公司不服向年長工人支付遣散費的裁決，但覆核時沒有提出新的理據。'},
 {source:'HKCFA/1997/1/TC.json',term:'激怒',query:'謀殺案被告沒有作供時，陪審團應怎樣考慮激怒抗辯？'}
];
const client=new pg.Client({connectionString:url});await client.connect();
try{
 const rows=[];
 for(const test of tests){
  const result=await client.query(`SELECT c.* FROM judgment_fulltext_chunks c JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation WHERE d.source_path=$1 AND c.content ILIKE $2 ORDER BY c.chunk_no LIMIT 1`,[test.source,`%${test.term}%`]);
  assert.equal(result.rows.length,1,`Missing pilot passage ${test.source}`);rows.push(result.rows[0]);
 }
 const inputs=[...rows.map(row=>row.embedding_input),...tests.map(test=>test.query)];
 const estimatedTokens=inputs.reduce((sum,input)=>sum+billing.encode(input).length,0);
 assert(estimatedTokens<=10000&&estimatedTokens*pricePerMillion/1000000<=approvedUsd,'Pilot exceeds approved budget');
 let provider;
 const vectors=await azureEmbed(inputs,{deployment:process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT??'text-embedding-3-large',onUsage:usage=>{provider=usage;}});
 assert.equal(vectors.length,inputs.length);
 assert(vectors.every(vector=>vector.length===3072&&vector.every(Number.isFinite)));
 const cosine=(left,right)=>left.reduce((sum,value,index)=>sum+value*right[index],0)/Math.sqrt(left.reduce((sum,value)=>sum+value*value,0)*right.reduce((sum,value)=>sum+value*value,0));
 const results=tests.map((test,index)=>{
  const ranked=rows.map((row,position)=>({source:tests[position].source,similarity:cosine(vectors[rows.length+index],vectors[position])})).sort((left,right)=>right.similarity-left.similarity);
  return {query:test.query,expected:test.source,top:ranked[0].source,passed:ranked[0].source===test.source,ranked};
 });
 await client.query('BEGIN');
 try{
  for(let index=0;index<rows.length;index++)await client.query(`UPDATE judgment_fulltext_chunks c SET embedding=$2::halfvec,status='ready',attempts=attempts+1,error=NULL FROM judgment_documents d WHERE c.id=$1 AND d.id=c.document_id AND d.generation::text=c.document_generation`,[rows[index].id,JSON.stringify(vectors[index])]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
 const report={completedAt:new Date().toISOString(),approvedUsd,priceSource:priceUrl.href,retailCeilingUsdPerMillion:pricePerMillion,estimatedInputTokens:estimatedTokens,provider,estimatedRetailCostUsd:(provider?.usage?.total_tokens??estimatedTokens)*pricePerMillion/1000000,embeddedPassages:rows.length,queries:tests.length,results,allPassed:results.every(result=>result.passed),productionUnchanged:true};
 await writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(report,null,2));
 assert(report.allPassed,'Semantic pilot failed; inspect report');
}finally{await client.end();}
