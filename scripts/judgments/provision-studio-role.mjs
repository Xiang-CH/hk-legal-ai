#!/usr/bin/env node
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

if(!process.env.STUDIO_ADMIN_DATABASE_URL)throw Error('STUDIO_ADMIN_DATABASE_URL with role-management privileges is required');
const target=new URL(process.env.DATABASE_URL??'');
const admin=new URL(process.env.STUDIO_ADMIN_DATABASE_URL);
if(admin.hostname!==target.hostname||(admin.port||'5432')!==(target.port||'5432')||admin.pathname!==target.pathname)throw Error('Admin URL must match the intended application database');
const outputPath=process.env.STUDIO_READONLY_ENV_FILE??'.env.studio';
const output=await fs.open(outputPath,'wx',0o600);
const password=randomBytes(32).toString('hex');
const client=new pg.Client({connectionString:admin.href});
try {
 await client.connect();await client.query('BEGIN');
 try {
  // The password is generated locally as hexadecimal, never interpolated from external text.
  await client.query(`CREATE ROLE clic_studio_readonly LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
  const database=decodeURIComponent(admin.pathname.slice(1)).replaceAll('"','""');
  await client.query(`GRANT CONNECT ON DATABASE "${database}" TO clic_studio_readonly`);
  await client.query('GRANT USAGE ON SCHEMA public TO clic_studio_readonly');
  await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO clic_studio_readonly');
  await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE clic_app IN SCHEMA public GRANT SELECT ON TABLES TO clic_studio_readonly');
  await client.query('ALTER ROLE clic_studio_readonly SET default_transaction_read_only=on');
  target.username='clic_studio_readonly';target.password=password;
  await output.writeFile(`DRIZZLE_READONLY_DATABASE_URL=${target.href}\n`);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
 console.log('Created SELECT-only Studio role and owner-readable .env.studio');
} catch(error) {await fs.rm(outputPath,{force:true});throw Error(`Studio role provisioning failed (${error.code??'configuration'}); no credentials printed`);}
finally {await output.close();await client.end();}
