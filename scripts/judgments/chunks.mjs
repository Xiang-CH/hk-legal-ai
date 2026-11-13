import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { verifyWriteAccess } from './db.mjs';
const tokenizer = getEncoding('o200k_base');
export const hash = _textValue => createHash('sha256').update(_textValue).digest('hex');
export const tokens = _textValue2 => tokenizer.encode(_textValue2).length;
/** Produce adjacent Han-character bigrams plus Latin tokens for bilingual lexical matching. */
export const cjk = _textValue3 => (_textValue3.match(/[\p{Script=Han}]+/gu) ?? []).flatMap(word => word.length < 2 ? [word] : Array.from({length:word.length-1},(_unused,index)=>word.slice(index,index+2))).concat(_textValue3.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ');
/** Split ordered blocks into bounded, overlapping chunks with exact source spans and metadata-prefixed embedding inputs. */
export function buildChunks(blocks, metadata = {}, options = {}) {
 const target = options.targetTokens ?? 600, max = options.maxTokens ?? 800;
 if (!(target > 0 && target <= max && max <= 800)) throw Error('Invalid token limits');
 const contextText = value => typeof value==='string' ? tokenizer.decode(tokenizer.encode(value).slice(0,100)) : value;
 const partiesContext=contextText(metadata.parties);
 let heading = contextText(metadata.heading);
 const input = text => {
   const prefix=[metadata.neutral_citation,partiesContext,heading].filter(Boolean).join('\n');
   return prefix ? `${prefix}\n\n${text}` : text;
 };
 if(tokens(input('')) >= max - 8) throw Error('Metadata exceeds budget');
 const result = []; let pending = [], hasNew = false;
 const text = spans => spans.map(_textValue4 => _textValue4.content).join('\n');
 const flush = (overlap=false) => { if (!pending.length || !hasNew) {pending=[];return;} const content = text(pending), embedding_input = input(content); result.push({chunk_no:result.length,content,embedding_input,token_count:tokens(embedding_input),content_checksum:hash(content),input_checksum:hash(embedding_input),spans:pending.map(({content,complete,..._spanFields})=>_spanFields),start_position:pending[0].position,end_position:pending.at(-1).position,start_offset:pending[0].start,end_offset:pending.at(-1).end});
 const last=pending.at(-1);
 pending=overlap && last.start===0 && last.complete && tokens(last.content)<=100 ? [last] : [];
 hasNew=false;
 };
 for (const block of blocks) {
  if(typeof block.content !== 'string') throw Error('Block content required');
  if (/heading|^h[1-6]$/.test(block.block_type ?? block.blockType ?? '')) {flush();heading=contextText(block.content);}
  let start=0;
  while(start < block.content.length) {
   let end=block.content.length;
   if(tokens(input(block.content.slice(start,end)))>max) {
    let best=start;
    for(const match of block.content.slice(start).matchAll(/[.!?。！？；;]\s*/gu)) { const candidate=start+match.index+match[0].length; if(tokens(input(block.content.slice(start,candidate)))<=max) best=candidate; else break; }
    if(best===start) { let lo=start+1,hi=end; while(lo<=hi){let mid=Math.floor((lo+hi)/2); if(tokens(input(block.content.slice(start,mid)))<=max){best=mid;lo=mid+1;}else hi=mid-1;} if(best>start && /[\uD800-\uDBFF]/.test(block.content[best-1])) best--; }
    if(best===start) throw Error('Cannot fit source character'); end=best;
   }
   const span={position:block.position,label:block.label??null,anchor:block.anchor??null,start,end,complete:end===block.content.length,content:block.content.slice(start,end)};
   if(pending.length && tokens(input(text([...pending,span])))>max) {flush(true);if(tokens(input(text([...pending,span])))>max) pending=[];}
   pending.push(span); hasNew=true; if(tokens(input(text(pending)))>=target) flush(true); start=end;
  }
 }
 flush(); return result;
}
/** Generate a bounded document batch, reusing matching inputs and publishing only the selected current generation in apply mode. */
export async function generateChunks({client,limit=100,afterId=0,apply=false,fast=false,...options}) {
 if(fast){const {generateChunksBatched}=await import('./chunks-batched.mjs');return generateChunksBatched({client,limit,afterId,apply,...options});}
 if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(afterId)||afterId<0)throw Error('Invalid pagination bounds');
 const documents=(await client.query('SELECT id,judgment_id FROM judgment_documents WHERE id>$1 ORDER BY id LIMIT $2',[afterId,limit])).rows;
 let count=0,totalTokens=0,lastDocumentId=afterId;
 for(const identity of documents) {
  if(apply)await client.query('BEGIN');
  try {
   if(apply)await client.query('SELECT id FROM "Judgment" WHERE id=$1 FOR UPDATE',[identity.judgment_id]);
   const doc=(await client.query('SELECT d.id,d.judgment_id,d.generation,j."neutralCitation",j.parties,j."courtName",j.year,j.date::text AS date,j.url,j."languageCode" FROM judgment_documents d JOIN "Judgment" j ON j.id=d.judgment_id WHERE d.id=$1',[identity.id])).rows[0];
   if(!doc){if(apply)await client.query('ROLLBACK');continue;}
   const blocks=(await client.query('SELECT * FROM judgment_paragraphs WHERE document_id=$1 ORDER BY position',[doc.id])).rows;
   const chunks=buildChunks(blocks,{neutral_citation:doc.neutralCitation,parties:doc.parties},options);
   const model=options.model??'text-embedding-3-large';
   const deployment=options.deployment??process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT??model;
   const version=options.modelVersion??process.env.JUDGMENT_EMBEDDING_VERSION??'1';
   const generation=hash(JSON.stringify([String(doc.generation),chunks.map(chunk=>chunk.input_checksum),model,deployment,version,'1']));
   for(const chunk of chunks) {
    count++;totalTokens+=chunk.token_count;
   }
   if(apply) {
    for(let offset=0;offset<chunks.length;offset+=200){
     const batch=chunks.slice(offset,offset+200).map(chunk=>({...chunk,cjk_tokens:cjk(chunk.content)}));
     await client.query(`INSERT INTO judgment_fulltext_chunks(document_id,judgment_id,document_generation,generation,chunk_no,content,embedding_input,content_checksum,input_checksum,chunker_version,start_position,end_position,start_offset,end_offset,spans,token_count,model,deployment,model_version,cjk_tokens,language_code,neutral_citation,court_name,year,date,parties,url)
      SELECT $1,$2,$3,$4,c.chunk_no,c.content,c.embedding_input,c.content_checksum,c.input_checksum,'1',c.start_position,c.end_position,c.start_offset,c.end_offset,c.spans,c.token_count,$6,$7,$8,c.cjk_tokens,$9,$10,$11,$12,$13::timestamp AT TIME ZONE 'UTC',$14,$15
      FROM jsonb_to_recordset($5::jsonb) AS c(chunk_no integer,content text,embedding_input text,content_checksum text,input_checksum text,start_position integer,end_position integer,start_offset integer,end_offset integer,spans jsonb,token_count integer,cjk_tokens text)
      ON CONFLICT(document_id,generation,chunk_no) DO UPDATE SET date=excluded.date,url=excluded.url,language_code=excluded.language_code,neutral_citation=excluded.neutral_citation,court_name=excluded.court_name,year=excluded.year,parties=excluded.parties`,
      [doc.id,doc.judgment_id,String(doc.generation),generation,JSON.stringify(batch),model,deployment,version,doc.languageCode,doc.neutralCitation,doc.courtName,doc.year,doc.date,doc.parties,doc.url]);
    }
    await client.query('INSERT INTO judgment_fulltext_active(document_id,generation) VALUES($1,$2) ON CONFLICT(document_id) DO UPDATE SET generation=excluded.generation',[doc.id,generation]);
    await client.query('COMMIT');
   }
   lastDocumentId=Number(doc.id);
  }catch(error){if(apply)await client.query('ROLLBACK');throw error;}
 }
 return {documents:documents.length,chunks:count,tokens:totalTokens,lastDocumentId};
}
/** Search active current-generation chunks lexically, optionally fusing supplied vector distances. */
export async function searchChunks({client,query,embedding,limit=10}) {
 if(embedding && (embedding.length!==3072||!embedding.every(Number.isFinite))) throw Error('Invalid vector');
 return (await client.query(`SELECT c.*, ts_rank_cd(c.tsv,plainto_tsquery('english',$1)) + ts_rank_cd(to_tsvector('simple',c.cjk_tokens),plainto_tsquery('simple',$2)) ${embedding?'+ COALESCE(1-(c.embedding <=> $4::halfvec),0)':''} AS score FROM judgment_fulltext_chunks c JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation WHERE ${embedding?"c.status='ready' OR ":''}(c.tsv @@ plainto_tsquery('english',$1) OR to_tsvector('simple',c.cjk_tokens) @@ plainto_tsquery('simple',$2)) ORDER BY score DESC,c.id LIMIT $3`,embedding?[query,cjk(query),limit,JSON.stringify(embedding)]:[query,cjk(query),limit])).rows;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){const apply=process.argv.includes('--apply');const url=await verifyWriteAccess({apply,testDatabase:process.argv.includes('--test-database')}); const {Client}=await import('pg');const client=new Client({connectionString:url});await client.connect();try{console.log(await generateChunks({client,apply}));}finally{await client.end();}}
