import {buildChunks,hash,cjk} from './chunks.mjs';
/** Construct a bounded page from prefetched paragraphs, then atomically publish each page after generation checks. */
export async function generateChunksBatched({client,limit=64,afterId=0,apply=false,...options}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(afterId)||afterId<0)throw Error('Invalid chunk page bounds');
 const docs=(await client.query('SELECT d.id,d.judgment_id,d.generation,j."neutralCitation",j.parties,j."courtName",j.year,j.date::text AS date,j.url,j."languageCode" FROM judgment_documents d JOIN "Judgment" j ON j.id=d.judgment_id WHERE d.id>$1 ORDER BY d.id LIMIT $2',[afterId,limit])).rows;
 if(!docs.length)return {documents:0,chunks:0,tokens:0,lastDocumentId:afterId};
 const byDoc=new Map();for(const row of (await client.query('SELECT * FROM judgment_paragraphs WHERE document_id=ANY($1::bigint[]) ORDER BY document_id,position',[docs.map(d=>d.id)])).rows){const k=String(row.document_id);const rows=byDoc.get(k)??[];rows.push(row);byDoc.set(k,rows);}
 let count=0,tokens=0;const active=[],rows=[];
 const model=options.model??'text-embedding-3-large',deployment=options.deployment??process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT??model,version=options.modelVersion??process.env.JUDGMENT_EMBEDDING_VERSION??'1';
 for(const doc of docs){
  const chunks=buildChunks(byDoc.get(String(doc.id))??[],{neutral_citation:doc.neutralCitation,parties:doc.parties},options);
  const generation=hash(JSON.stringify([String(doc.generation),chunks.map(c=>c.input_checksum),model,deployment,version,'1']));active.push({document_id:doc.id,generation});
  for(const chunk of chunks){count++;tokens+=chunk.token_count;rows.push({...chunk,document_id:doc.id,judgment_id:doc.judgment_id,document_generation:String(doc.generation),generation,cjk_tokens:cjk(chunk.content),language_code:doc.languageCode,neutral_citation:doc.neutralCitation,court_name:doc.courtName,year:doc.year,date:doc.date,parties:doc.parties,url:doc.url});}
 }
 if(apply){
  await client.query('BEGIN');try{
   await client.query('SELECT id FROM "Judgment" WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[docs.map(d=>d.judgment_id).sort((a,b)=>a-b)]);
   const current=new Map((await client.query('SELECT id,generation::text FROM judgment_documents WHERE id=ANY($1::bigint[])',[docs.map(d=>d.id)])).rows.map(r=>[String(r.id),r.generation]));
   if(docs.some(d=>current.get(String(d.id))!==String(d.generation)))throw Error('Chunk source generation changed; retry page');
   for(let offset=0;offset<rows.length;offset+=200)await client.query(`INSERT INTO judgment_fulltext_chunks(document_id,judgment_id,document_generation,generation,chunk_no,content,embedding_input,content_checksum,input_checksum,chunker_version,start_position,end_position,start_offset,end_offset,spans,token_count,model,deployment,model_version,cjk_tokens,language_code,neutral_citation,court_name,year,date,parties,url)
    SELECT document_id,judgment_id,document_generation,generation,chunk_no,content,embedding_input,content_checksum,input_checksum,'1',start_position,end_position,start_offset,end_offset,spans,token_count,$2,$3,$4,cjk_tokens,language_code,neutral_citation,court_name,year,date::timestamp AT TIME ZONE 'UTC',parties,url
    FROM jsonb_to_recordset($1::jsonb) AS c(document_id bigint,judgment_id int,document_generation text,generation text,chunk_no int,content text,embedding_input text,content_checksum text,input_checksum text,start_position int,end_position int,start_offset int,end_offset int,spans jsonb,token_count int,cjk_tokens text,language_code text,neutral_citation text,court_name text,year int,date text,parties text,url text)
    ON CONFLICT(document_id,generation,chunk_no) DO UPDATE SET date=excluded.date,url=excluded.url,language_code=excluded.language_code,neutral_citation=excluded.neutral_citation,court_name=excluded.court_name,year=excluded.year,parties=excluded.parties`,[JSON.stringify(rows.slice(offset,offset+200)),model,deployment,version]);
   await client.query('INSERT INTO judgment_fulltext_active(document_id,generation) SELECT document_id,generation FROM jsonb_to_recordset($1::jsonb) AS a(document_id bigint,generation text) ON CONFLICT(document_id) DO UPDATE SET generation=excluded.generation',[JSON.stringify(active)]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
 }
 return {documents:docs.length,chunks:count,tokens,lastDocumentId:Number(docs.at(-1).id)};
}
