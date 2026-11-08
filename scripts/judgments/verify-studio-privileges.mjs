#!/usr/bin/env node
import assert from 'node:assert/strict';
import pg from 'pg';
const url=new URL(process.env.DRIZZLE_READONLY_DATABASE_URL??'');
assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/clic_judgment_test_'),'Local disposable database required');
const client=new pg.Client({connectionString:url.href});
await client.connect();
try{
 await client.query('SET default_transaction_read_only=off');
 await client.query('BEGIN READ WRITE');await client.query('SELECT id FROM "Judgment" LIMIT 1');await client.query('ROLLBACK');
 for(const sql of ['UPDATE "Judgment" SET number=number WHERE false','DELETE FROM "Judgment" WHERE false','INSERT INTO "Judgment"(id) VALUES(-1)','TRUNCATE "Judgment"','CREATE TABLE public.review_write_test(id int)']){
  await assert.rejects(client.query(sql),error=>error.code==='42501');
 }
 console.log(JSON.stringify({passed:true,selectAllowed:true,writesDeniedWithReadOnlyDefaultOff:true}));
}finally{await client.end();}
