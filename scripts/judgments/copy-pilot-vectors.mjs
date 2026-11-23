#!/usr/bin/env node
import pg from 'pg';
import { parseArgs } from 'node:util';
import { verifyWriteAccess } from './db.mjs';

const {values:options}=parseArgs({options:{'ack-backup':{type:'string'},'restore-receipt':{type:'string'},'allow-production':{type:'boolean'},'accept-azure-ai-omission':{type:'boolean'}}});
const sourceUrl=new URL(process.env.JUDGMENT_VECTOR_SOURCE_URL??'');
if(!['localhost','127.0.0.1'].includes(sourceUrl.hostname)||!sourceUrl.pathname.startsWith('/clic_judgment_test_'))throw Error('Local pilot source required');
const targetUrl=await verifyWriteAccess({apply:true,allowProduction:options['allow-production'],ackBackup:options['ack-backup'],restoreReceipt:options['restore-receipt'],acceptAzureAiOmission:options['accept-azure-ai-omission']});
const source=new pg.Client({connectionString:sourceUrl.href});
const target=new pg.Client({connectionString:targetUrl});
await source.connect();await target.connect();
try{
 const rows=(await source.query(`SELECT d.source_path,d.source_checksum,c.input_checksum,c.embedding_input,c.model,c.deployment,c.model_version,c.embedding::text
 FROM judgment_fulltext_chunks c JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation
 JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation
 WHERE c.status='ready' AND c.embedding IS NOT NULL`)).rows;
 if(rows.length>2000)throw Error('Pilot copy limited to 2000 vectors');
 let copied=0;
 await target.query('BEGIN');
 try{
  for(let offset=0;offset<rows.length;offset+=100){
   const result=await target.query(`UPDATE judgment_fulltext_chunks c SET embedding=v.embedding::halfvec,status='ready',error=NULL
   FROM jsonb_to_recordset($1::jsonb) AS v(source_path text,source_checksum text,input_checksum text,embedding_input text,model text,deployment text,model_version text,embedding text),judgment_documents d,judgment_fulltext_active a
   WHERE d.source_path=v.source_path AND d.source_checksum=v.source_checksum AND c.document_id=d.id AND c.document_generation=d.generation::text
   AND a.document_id=d.id AND a.generation=c.generation AND c.input_checksum=v.input_checksum AND c.embedding_input=v.embedding_input
   AND c.model=v.model AND c.deployment=v.deployment AND c.model_version=v.model_version AND c.status<>'ready'`,[JSON.stringify(rows.slice(offset,offset+100))]);
   copied+=result.rowCount;
  }
  await target.query('COMMIT');
 }catch(error){await target.query('ROLLBACK');throw error;}
 console.log(JSON.stringify({sourceReadyVectors:rows.length,copied,providerCalls:0}));
}finally{await source.end();await target.end();}
