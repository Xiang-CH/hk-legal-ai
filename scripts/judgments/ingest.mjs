import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk, parseSourcePath, checksum, validateShape } from './source.mjs';
import { parseJudgment, PARSER_VERSION } from './parse.mjs';
import { verifyWriteAccess } from './db.mjs';
import { clearManagedLinks } from './legislation-links.mjs';
/** Import checksum-matched source documents transactionally per judgment; quarantine failures and preserve the previous generation. Dry runs never write. */
export async function importCorpus({client, root, apply=false, limit=Infinity, ...safety}) {
  await verifyWriteAccess({apply,...safety});
  if (!root || !(limit >= 0)) throw new Error('root and nonnegative limit required');
  root = path.resolve(root);
  const runId = randomUUID(), outcomes = [];
  if(apply) {
    const lock=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[root])).rows[0];
    if(!lock.acquired)throw Error('Another importer owns this source root');
  }
  try {
    if(apply) {
      await client.query("UPDATE judgment_import_runs SET status='interrupted',completed_at=now() WHERE root=$1 AND status='running'",[root]);
      await client.query('INSERT INTO judgment_import_runs(id,root,parser_version,status) VALUES($1,$2,$3,$4)',[runId,root,PARSER_VERSION,'running']);
    }
    for await (const file of walk(root)) {
      if(outcomes.length >= limit) break;
      const identity = parseSourcePath(root,file);
      const sourcePath = path.relative(root,file).split(path.sep).join('/');
      let digest=null, status='quarantined', error=null;
      try {
        digest=await checksum(file);
        if(identity?.kind !== 'content') { status='skipped'; }
        else {
          if(!identity.court || !identity.year || !identity.number || !identity.language) throw new Error('Incomplete source identity');
          const data=JSON.parse(await readFile(file,'utf8'));
          const invalid=validateShape(data,identity.language); if(invalid) throw new Error(invalid);
          const parsed=parseJudgment(data.html ?? data.content ?? data.judgment ?? data.text);
          if(apply) await client.query('BEGIN');
          try {
            const matches=await client.query('SELECT id FROM "Judgment" WHERE upper("courtName")=$1 AND year=$2 AND number=$3 AND lower("languageCode")=$4',[identity.court,identity.year,Number(identity.number),identity.language.toLowerCase()]);
            if(matches.rows.length !== 1) throw new Error(matches.rows.length ? 'Ambiguous judgment identity' : 'Unmatched judgment identity');
            const judgmentId=matches.rows[0].id;
            if(apply) await client.query('SELECT id FROM "Judgment" WHERE id=$1 FOR UPDATE',[judgmentId]);
            const existing=await client.query('SELECT * FROM judgment_documents WHERE judgment_id=$1 OR source_path=$2',[judgmentId,sourcePath]);
            if(existing.rows.some(_documentValue=>_documentValue.judgment_id !== judgmentId || _documentValue.source_path !== sourcePath)) throw new Error('Conflicting document identity');
            const old=existing.rows[0];
            status=old?.source_checksum===digest && old.parser_version===PARSER_VERSION ? 'unchanged' : apply ? 'imported' : 'would-import';
            if(apply && status==='imported') {
              if(old && (await client.query("SELECT to_regclass('judgment_managed_legislation_links') IS NOT NULL AS available")).rows[0].available)await clearManagedLinks(client,judgmentId);
              const result=await client.query(`INSERT INTO judgment_documents(judgment_id,source_path,source_checksum,raw_html,plain_text,parser_version,generation)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(judgment_id) DO UPDATE SET source_checksum=excluded.source_checksum,raw_html=excluded.raw_html,plain_text=excluded.plain_text,parser_version=excluded.parser_version,generation=excluded.generation,imported_at=now() RETURNING id`,[judgmentId,sourcePath,digest,data.html ?? data.content ?? data.judgment ?? data.text,parsed.plainText,PARSER_VERSION,randomUUID()]);
              const documentId=result.rows[0].id;
              await client.query('DELETE FROM judgment_paragraphs WHERE document_id=$1',[documentId]);
              await client.query(`INSERT INTO judgment_paragraphs(document_id,position,label,anchor,block_type,content,html)
                SELECT $1,position,label,anchor,"blockType",content,html FROM jsonb_to_recordset($2::jsonb)
                AS blocks(position int,label text,anchor text,"blockType" text,content text,html text)`,[documentId,JSON.stringify(parsed.blocks)]);
            }
            if(apply) await client.query('COMMIT');
          } catch(_error) { if(apply) await client.query('ROLLBACK'); throw _error; }
        }
      } catch(_error2) { status='quarantined'; error=_error2.message; }
      if(apply) await client.query('INSERT INTO judgment_import_files(run_id,source_path,source_checksum,status,error) VALUES($1,$2,$3,$4,$5)',[runId,sourcePath,digest,status,error]);
      outcomes.push({sourcePath,checksum:digest,status,error});
    }
    if(apply) await client.query("UPDATE judgment_import_runs SET status='completed',completed_at=now() WHERE id=$1",[runId]);
  } catch(_error3) { if(apply) await client.query("UPDATE judgment_import_runs SET status='failed',completed_at=now() WHERE id=$1",[runId]).catch(()=>{}); throw _error3; }
  finally {if(apply)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[root]).catch(()=>{});}
  return {runId,outcomes};
}
/** Parse bounded import options, validate write authorization and close the explicit database connection. */
async function main() {
  const args=process.argv.slice(2), options={};
  for(let _index=0;_index<args.length;_index++) {
    const _argument=args[_index];
    if(['--apply','--dry-run','--test-database'].includes(_argument)) options[_argument]=true;
    else if(['--dir','--limit','--ack-backup'].includes(_argument) && args[_index+1]) options[_argument]=args[++_index];
    else throw new Error(`Unknown or incomplete argument: ${_argument}`);
  }
  if(options['--apply'] && options['--dry-run']) throw new Error('Choose apply or dry-run');
  const config={root:options['--dir'],apply:!!options['--apply'],testDatabase:!!options['--test-database'],ackBackup:options['--ack-backup'],limit:options['--limit']===undefined?Infinity:Number(options['--limit'])};
  const connectionString=await verifyWriteAccess(config);
  const {Client}=await import('pg'); const client=new Client({connectionString});
  await client.connect();
  try { console.log(JSON.stringify(await importCorpus({client,...config}),null,2)); } finally { await client.end(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(_error4=>{console.error(_error4.message);process.exitCode=1;});
