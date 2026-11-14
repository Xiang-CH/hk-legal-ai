import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {searchFulltext,getFulltext} from '@/lib/judgment-fulltext';
import {prisma} from '@/lib/prisma';
import {cjkTokens} from '@/lib/cjk';
async function main(){
 const databaseUrl=process.env.DATABASE_URL??'';const url=new URL(databaseUrl);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'));
 const {importCorpus}=await import('./ingest.mjs');const {generateChunks}=await import('./chunks.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'search-candidates-'));const client=new pg.Client({connectionString:databaseUrl});await client.connect();
 try{
  const dir=path.join(root,'HKCA/2020/4');await fs.mkdir(dir,{recursive:true});const source=path.join(dir,'EN.json');
  await fs.writeFile(source,JSON.stringify({content:'<p><a id="p1">1.</a> Boundarymarker original judgment passage.</p>'}));
  const config={client,root,databaseUrl,apply:true,testDatabase:true,fast:true,onProgress:undefined};await importCorpus(config);await generateChunks({client,apply:true,fast:true});
  const vector=[1,...Array(3071).fill(0)];await client.query("UPDATE judgment_fulltext_chunks SET embedding=$1::halfvec,status='ready' WHERE judgment_id=6",[JSON.stringify(vector)]);
  for(const embedding of [null,vector]){
   const hits=await searchFulltext('boundarymarker',cjkTokens('boundarymarker'),embedding,['en']);const hit=hits.find(h=>h.judgmentId===6);assert(hit?.documentId);assert.equal(hit.sourceAnchor,'p1');
   const doc=await getFulltext(6,hit.startPosition??0,hit.endPosition??0,'none',20);assert(doc.paragraphs.some(p=>p.content.includes('Boundarymarker original judgment passage.')));
  }
  assert.equal((await searchFulltext('boundarymarker','boundarymarker',null,['tc'])).length,0);
  await fs.writeFile(source,JSON.stringify({content:'<p>Replacement with no old marker.</p>'}));await importCorpus(config);
  assert(!(await searchFulltext('boundarymarker','boundarymarker',vector,['en'])).some(h=>h.judgmentId===6));
  console.log(JSON.stringify({passed:true,lexicalAndVectorCandidates:true,sourceAnchor:true,originalParagraph:true,languageFilter:true,staleGenerationExcluded:true,providerCalls:0}));
 }finally{await client.end();await prisma.$disconnect();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
