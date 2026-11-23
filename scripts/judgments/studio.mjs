#!/usr/bin/env node
import { spawn } from 'node:child_process';
import pg from 'pg';

const raw=process.env.DRIZZLE_READONLY_DATABASE_URL;
if(!raw)throw Error('DRIZZLE_READONLY_DATABASE_URL with a SELECT-only role is required');
const url=new URL(raw);
if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('PostgreSQL URL required');
const client=new pg.Client({connectionString:url.href});
await client.connect();
try {
 const access=(await client.query(`SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS privileged,
  EXISTS(SELECT 1 FROM pg_roles parent WHERE parent.rolname<>current_user AND pg_has_role(current_user,parent.oid,'MEMBER')) AS inherited_role,
  has_database_privilege(current_database(),'CREATE') AS database_write,
  EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND has_schema_privilege(oid,'CREATE')) AS schema_write,
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(c.oid,'INSERT') OR has_table_privilege(c.oid,'UPDATE') OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE') OR has_table_privilege(c.oid,'TRIGGER') OR has_table_privilege(c.oid,'REFERENCES'))) AS table_write,
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='S' AND (has_sequence_privilege(c.oid,'USAGE') OR has_sequence_privilege(c.oid,'UPDATE'))) AS sequence_write
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if(!access||Object.values(access).some(Boolean))throw Error('Studio role must have SELECT-only privileges without privileged memberships');
} finally {await client.end();}
url.searchParams.set('options','-c default_transaction_read_only=on');
const child=spawn('pnpm',['exec','drizzle-kit','studio','--config','drizzle.config.ts','--host','127.0.0.1','--port','4983'],{
 stdio:'inherit',env:{...process.env,DRIZZLE_DATABASE_URL:url.href},
});
child.on('error',()=>{console.error('Unable to start Drizzle Studio');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
