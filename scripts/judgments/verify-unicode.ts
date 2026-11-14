import assert from 'node:assert/strict';
import pg from 'pg';
import {cjkTokens,containsCjk} from '../../src/lib/cjk';
import {cjkTokens as loaderTokens} from '../cjk';
async function main(){
 const url=new URL(process.env.JUDGMENT_DATABASE_URL??'');assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
 const {cjk}=await import('./chunks.mjs');const client=new pg.Client({connectionString:url.href});await client.connect();
 try{for(const text of ['𠄀','𠄀人','犯人用假槍及𠄀字','甲𠀀乙 English123','激怒抗辯']){
  const tokens=cjk(text);assert.equal(tokens,cjkTokens(text));assert.equal(tokens,loaderTokens(text));assert(containsCjk(text));
  await client.query('SELECT $1::jsonb',[JSON.stringify({tokens})]);
 }
 assert.equal(cjk('甲𠀀乙'),'甲𠀀 𠀀乙');console.log(JSON.stringify({passed:true,unicodeCodePoints:true,postgresJsonAccepted:true,indexQueryParity:true,providerCalls:0}));
 }finally{await client.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
