#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { parseSourcePath, walk, checksum, validateShape } from './source.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
const root = path.resolve(option('--dir', process.env.JUDGMENT_SOURCE_DIR ?? '/Users/cxiang/Downloads/legalData_v2_20250704'));
const output = option('--output', '-');
const keyOf = row => [row.court.toUpperCase(), row.year, Number(row.number), row.language.toLowerCase()].join('|');
const totals = { files: 0, content: 0, sidecars: 0, other: 0, matched: 0, unmatched: 0, ambiguous: 0, invalid: 0, duplicateIdentities: 0, databaseRowsWithoutSource: 0 };
const index = new Map();
const seen = new Set();
let client;
let stream;
try {
  if (process.env.JUDGMENT_DATABASE_URL) {
    const { Client } = await import('pg');
    client = new Client({ connectionString: process.env.JUDGMENT_DATABASE_URL });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const result = await client.query('SELECT id, "courtName", year, number, "languageCode", "neutralCitation", url FROM "Judgment"');
    for (const row of result.rows) {
      const key = keyOf({ court: row.courtName, year: row.year, number: row.number, language: row.languageCode });
      const entries = index.get(key) ?? [];
      entries.push(row);
      index.set(key, entries);
    }
  }
  stream = output === '-' ? process.stdout : fs.createWriteStream(path.resolve(output), { flags: 'wx', mode: 0o600 });
  stream.on('error', error => { process.stderr.write(`Audit output error: ${error.code ?? 'unknown'}\n`); });
  for await (const file of walk(root)) {
    const info = parseSourcePath(root, file);
    if (!info) continue;
    totals.files++;
    totals[info.kind === 'sidecar' ? 'sidecars' : info.kind]++;
    const row = { ...info, sha256: await checksum(file), status: 'ignored' };
    if (info.kind !== 'other') {
      try {
        const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        const invalid = info.kind === 'sidecar'
          ? (!Array.isArray(data) || data.some(value => typeof value !== 'string') ? 'invalid-sidecar' : null)
          : validateShape(data, info.language);
        if (invalid) { row.status = 'invalid'; row.reason = invalid; totals.invalid++; }
        else if (info.kind === 'content') {
          const key = keyOf(info);
          if (seen.has(key)) { row.status = 'conflicting'; row.reason = 'duplicate-source-identity'; totals.duplicateIdentities++; }
          else {
            seen.add(key);
            const hits = index.get(key) ?? [];
            row.status = client ? (hits.length === 1 ? 'matched' : hits.length > 1 ? 'ambiguous' : 'unmatched') : 'not-reconciled';
            if (client) totals[row.status]++;
            if (hits.length === 1) row.judgmentId = hits[0].id;
            if (hits.length > 1) row.candidates = hits.map(hit => hit.id);
          }
        } else row.status = 'validated-sidecar';
      } catch (error) { row.status = 'invalid'; row.reason = error instanceof SyntaxError ? 'invalid-json' : 'read-failed'; totals.invalid++; }
    }
    if (!stream.write(JSON.stringify(row) + '\n')) await once(stream, 'drain');
  }
  if (client) for (const [key, rows] of index) if (!seen.has(key)) totals.databaseRowsWithoutSource += rows.length;
  const summary = { ...totals, sourceDirectory: root, reconciliation: Boolean(client) };
  if (output === '-') process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
  else {
    stream.end();
    await once(stream, 'finish');
    await fs.promises.writeFile(`${output}.summary.json`, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
