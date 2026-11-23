#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { verifyWriteAccess } from './db.mjs';

const connectionString=await verifyWriteAccess({apply:true,testDatabase:true});
const output=process.argv.find(argument=>argument.startsWith('--output='))?.slice('--output='.length);
if(!output)throw Error('--output=NEW_REPORT required');
const client=new pg.Client({connectionString});await client.connect();
try{
 await client.query('BEGIN');
 const sample=`judgment_capacity_${randomUUID().replaceAll('-','')}`;
 const columns=(await client.query("SELECT array_agg(attname::text ORDER BY attnum) AS names FROM pg_attribute WHERE attrelid='judgment_fulltext_chunks'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ")).rows[0].names;
 if(!Array.isArray(columns)||columns.some(name=>typeof name!=='string'||!/^[a-z_][a-z0-9_]*$/.test(name)))throw Error('Unexpected chunk columns');
 const names=columns.map(name=>`"${name}"`).join(',');
 const selected=columns.map(name=>`chunks."${name}"`).join(',');
 await client.query(`CREATE TEMP TABLE "${sample}" (LIKE judgment_fulltext_chunks INCLUDING ALL) ON COMMIT DROP`);
 await client.query(`INSERT INTO "${sample}"(${names}) SELECT ${selected} FROM judgment_fulltext_chunks chunks JOIN judgment_fulltext_active active ON active.document_id=chunks.document_id AND active.generation=chunks.generation JOIN judgment_documents documents ON documents.id=chunks.document_id AND documents.generation::text=chunks.document_generation`);
 const counts=(await client.query(`SELECT count(*)::int AS chunks,count(embedding)::int AS vectors,sum(octet_length(content)+octet_length(embedding_input))::text AS text_bytes FROM "${sample}"`)).rows[0];
 const sizes=(await client.query('SELECT pg_total_relation_size($1::regclass)::text AS total,pg_table_size($1::regclass)::text AS table_bytes,pg_indexes_size($1::regclass)::text AS indexes',[sample])).rows[0];
 const indexes=(await client.query(`SELECT access.amname AS method,pg_relation_size(indexes.indexrelid)::text AS bytes FROM pg_index indexes JOIN pg_class index_relation ON index_relation.oid=indexes.indexrelid JOIN pg_am access ON access.oid=index_relation.relam WHERE indexes.indrelid=$1::regclass ORDER BY pg_relation_size(indexes.indexrelid) DESC`,[sample])).rows;
 if(!counts.chunks||counts.vectors!==counts.chunks)throw Error('Need a fully embedded current pilot');
 const report={measuredAt:new Date().toISOString(),chunks:counts.chunks,vectors:counts.vectors,textBytes:Number(counts.text_bytes),freshTotalBytes:Number(sizes.total),tableAndToastBytes:Number(sizes.table_bytes),indexBytes:Number(sizes.indexes),bytesPerChunk:Number(sizes.total)/counts.chunks,rawVectorBytesLowerBound:counts.vectors*3072*2,indexes:indexes.map(index=>({method:index.method,bytes:Number(index.bytes)})),oldGenerationsAndUpdateBloatExcluded:true,temporaryObjectsOnly:true,productionUnchanged:true,excludes:['judgment HTML/documents','paragraphs','references and legacy links','WAL','temporary index-build headroom','base database']};
 await client.query('ROLLBACK');
 await writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(report));
}finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
