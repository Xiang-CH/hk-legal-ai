#!/usr/bin/env node
import assert from 'node:assert/strict';
import pg from 'pg';
import { hash, tokens } from './chunks.mjs';

if(!process.env.JUDGMENT_DATABASE_URL)throw Error('Explicit JUDGMENT_DATABASE_URL required');
const client=new pg.Client({connectionString:process.env.JUDGMENT_DATABASE_URL});
const requireVectors=process.argv.includes('--require-vectors');
await client.connect();
try {
 await client.query('BEGIN READ ONLY');
 const documents=(await client.query('SELECT id,generation FROM judgment_documents ORDER BY id')).rows;
 let blockCount=0,chunkCount=0,totalTokens=0,ready=0;
 for(const document of documents) {
  const blocks=(await client.query('SELECT position,content FROM judgment_paragraphs WHERE document_id=$1 ORDER BY position',[document.id])).rows;
  const chunks=(await client.query(`SELECT c.* FROM judgment_fulltext_chunks c JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation WHERE c.document_id=$1 AND c.document_generation=$2`,[document.id,String(document.generation)])).rows;
  assert(chunks.length,`Document ${document.id} has no active current chunks`);
  const source=new Map(blocks.map(block=>[block.position,block.content]));
  const coverage=new Map(blocks.map(block=>[block.position,[]]));
  for(const chunk of chunks) {
   assert.equal(hash(chunk.content),chunk.content_checksum);
   assert.equal(hash(chunk.embedding_input),chunk.input_checksum);
   assert.equal(tokens(chunk.embedding_input),chunk.token_count);
   assert(chunk.token_count<=800);
   const parts=[];
   for(const span of chunk.spans) {
    const text=source.get(span.position);
    assert.equal(typeof text,'string');
    assert(Number.isInteger(span.start)&&Number.isInteger(span.end)&&span.start>=0&&span.end<=text.length&&span.end>span.start);
    parts.push(text.slice(span.start,span.end));
    coverage.get(span.position).push([span.start,span.end]);
   }
   assert.equal(parts.join('\n'),chunk.content,'Stored chunk must exactly reconstruct from its source spans');
   if(chunk.status==='ready'){assert(chunk.embedding!==null);ready++;}
   if(requireVectors)assert.equal(chunk.status,'ready','Missing embedding');
   totalTokens+=chunk.token_count;chunkCount++;
  }
  for(const block of blocks) {
   let end=0;
   for(const [start,next] of coverage.get(block.position).sort((left,right)=>left[0]-right[0])) {
    assert(start<=end,`Gap in document ${document.id} block ${block.position}`);
    end=Math.max(end,next);
   }
   assert.equal(end,block.content.length,`Incomplete document ${document.id} block ${block.position}`);
   blockCount++;
  }
 }
 const graph=(await client.query(`SELECT
  (SELECT count(*)::int FROM judgment_references r LEFT JOIN judgment_documents d ON d.judgment_id=r.source_id WHERE d.id IS NULL OR r.provenance->>'generation' IS DISTINCT FROM d.generation::text) stale_case_references,
  (SELECT count(*)::int FROM judgment_legislation_references r LEFT JOIN judgment_documents d ON d.judgment_id=r.source_id WHERE d.id IS NULL OR r.provenance->>'generation' IS DISTINCT FROM d.generation::text) stale_legislation_references,
  (SELECT count(*)::int FROM judgment_reference_occurrences o JOIN judgment_references r ON r.id=o.reference_id JOIN judgment_paragraphs p ON p.id=o.paragraph_id JOIN judgment_documents d ON d.id=p.document_id WHERE d.judgment_id<>r.source_id) wrong_source_paragraphs,
  (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated) unvalidated_foreign_keys`)).rows[0];
 for(const [check,count] of Object.entries(graph))assert.equal(count,0,`Graph integrity check failed: ${check}`);
 const caseReferenceOutcomes=(await client.query('SELECT status,count(*)::int AS count FROM judgment_references GROUP BY status ORDER BY status')).rows;
 const legislationReferenceOutcomes=(await client.query('SELECT status,count(*)::int AS count FROM judgment_legislation_references GROUP BY status ORDER BY status')).rows;
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),documents:documents.length,blocks:blockCount,chunks:chunkCount,embeddingInputTokens:totalTokens,readyEmbeddings:ready,completeCoverage:true,requireVectors,graph,caseReferenceOutcomes,legislationReferenceOutcomes}));
}finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
