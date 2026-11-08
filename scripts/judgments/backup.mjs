#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, open, readFile, unlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const usage = 'Usage: backup.mjs backup <archive> | restore <archive> --target-url-env JUDGMENT_RESTORE_DATABASE_URL --ack-disposable';
const args = process.argv.slice(2);
function fail(message) { throw new Error(message); }
/** Read a PostgreSQL URL from a named environment variable and reject unsupported connection schemes. */
function envUrl(name) {
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) fail('Provide a valid environment variable name.');
  const value = process.env[name];
  if (!value) fail(`Required environment variable ${name} is not set.`);
  try { const url = new URL(value); if(!['postgres:','postgresql:'].includes(url.protocol)) fail('Invalid protocol'); return url; } catch { fail(`Environment variable ${name} is not a valid PostgreSQL URL.`); }
}
/** Compare normalized host, port and database identities without retaining credentials. */
function identity(url) {
  const host = (url.hostname || '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const port = url.port || '5432';
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host || !db) fail('Database URL must include host and database name.');
  return `${host}:${port}/${db.toLowerCase()}`;
}
/** Build PostgreSQL client arguments without placing passwords on the process command line. */
function safeArgs(url) { return ['--host', url.hostname, '--port', url.port || '5432', '--username', decodeURIComponent(url.username), '--dbname', decodeURIComponent(url.pathname.slice(1))]; }
/** Run PostgreSQL tooling with credentials in the child environment and suppress potentially sensitive failure output. */
function run(bin, argv, url) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer' };
    for (const key of ['PGPASSWORD', 'DATABASE_URL']) if (!env[key]) delete env[key];
    const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    child.stdout.on('data', _buffer => out.push(_buffer)); child.stderr.on('data', () => { err = ' (see redacted tool output)'; });
    child.on('error', () => reject(new Error(`Could not start ${bin}.`)));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${bin} failed with exit code ${code}${err}`)));
  });
}
/** Calculate the archive checksum using streaming reads. */
async function sha(file) { const _hasher = createHash('sha256'); for await (const _buffer2 of createReadStream(file)) _hasher.update(_buffer2); return _hasher.digest('hex'); }
/** Create an exclusive verified archive, or transactionally restore a checksum-matched archive into an acknowledged disposable database. */
async function main() {
  const [mode, file, ...opts] = args;
  if (!mode || !file || !['backup', 'restore'].includes(mode)) fail(usage);
  const archive = path.resolve(file);
  const source = envUrl('JUDGMENT_DATABASE_URL');
  if (mode === 'backup') {
    const temp = `${archive}.partial-${process.pid}`;
    try {
      await (await open(temp,'wx',0o600)).close();
      await run('pg_dump', [...safeArgs(source), '--format=custom', '--no-password', '--file', temp], source);
      await run('pg_restore', ['--list', temp], source);
      const checksum = await sha(temp);
      await chmod(temp, 0o600);
      await link(temp, archive);
      await unlink(temp);
      await writeFile(`${archive}.manifest.json`, JSON.stringify({ format: 'pg_dump-custom', createdAt: new Date().toISOString(), source: identity(source), archive: path.basename(archive), sha256: checksum }, null, 2) + '\n', { mode: 0o600, flag:'wx' });
      console.log(`Backup created: ${path.basename(archive)} (sha256 ${checksum})`);
    } catch (_error) { await import('node:fs/promises').then(fs => fs.rm(temp, { force: true })); throw _error; }
    return;
  }
  const targetEnv = opts[opts.indexOf('--target-url-env') + 1];
  if (!opts.includes('--ack-disposable')) fail('Restore requires --ack-disposable.');
  if (!targetEnv || !opts.includes('--target-url-env')) fail(usage);
  const target = envUrl(targetEnv), targetName = decodeURIComponent(target.pathname.slice(1));
  if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)) fail('Restore is restricted to a local disposable database.');
  if (!/^clic_judgment_(test|restore)_[a-z0-9_]+$/i.test(targetName)) fail('Restore target database must start clic_judgment_test_ or clic_judgment_restore_.');
  if (identity(source) === identity(target)) fail('Source and target database identities match; refusing restore.');
  const manifest = JSON.parse(await readFile(`${archive}.manifest.json`, 'utf8'));
  if(manifest.format!=='pg_dump-custom' || manifest.archive!==path.basename(archive) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) fail('Invalid archive manifest.');
  const checksum = await sha(archive);
  if (manifest.sha256 !== checksum) fail('Archive checksum does not match manifest.');
  if (manifest.source === identity(target)) fail('Target matches backup source; refusing restore.');
  const omitAzureAi=opts.includes('--omit-azure-ai');
  const selection=`${archive}.restore-selection-${process.pid}`;
  const restoreArgs=[...safeArgs(target),'--exit-on-error','--single-transaction','--no-owner','--no-privileges','--no-password'];
  const omitted=[];
  try {
    if(omitAzureAi) {
      const listing=(await run('pg_restore',['--list',archive],target)).toString('utf8');
      const kept=listing.split('\n').filter(line=>{
        if(/\bEXTENSION - azure_ai\s*$|\bCOMMENT - EXTENSION azure_ai\s*$/.test(line)){omitted.push(line.split(';')[0]);return false;}
        return true;
      });
      if(omitted.length!==2||kept.some(line=>/\bazure_ai\b/.test(line)&&!line.startsWith(';')))fail('Unexpected Azure AI archive dependencies; refusing partial application restore.');
      await writeFile(selection,kept.join('\n'),{flag:'wx',mode:0o600});
      restoreArgs.push('--use-list',selection);
    }
    await run('pg_restore',[...restoreArgs,archive],target);
    const {Client}=await import('pg');const verification=new Client({connectionString:target.href});await verification.connect();
    let tables;
    try {
      await verification.query('BEGIN READ ONLY');
      const names=(await verification.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      tables={};
      for(const {tablename} of names){
        const quoted='"'+tablename.replaceAll('"','""')+'"';
        tables[tablename]=Number((await verification.query(`SELECT count(*)::text AS count FROM public.${quoted}`)).rows[0].count);
      }
      await verification.query('ROLLBACK');
    }finally{await verification.end();}
    const receipt={completedAt:new Date().toISOString(),archiveSha256:checksum,source:manifest.source,target:identity(target),applicationDataRestored:true,omittedExtensions:omitAzureAi?['azure_ai']:[],omittedArchiveEntries:omitted,strictTransactionalRestore:true,tables};
    await writeFile(`${archive}.restore-receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  }finally{await rm(selection,{force:true});}
  console.log(`Restore completed into ${identity(target)}.`);
}
main().catch(_error2 => { console.error(`judgment backup: ${_error2.message}`); console.error(usage); process.exitCode = 1; });
