// T06 — fill embeddings for T05 chunk JSONs, reusing the T06 EN cache.
// Reuse rule: cached embedding is reused ONLY if the chunk text is identical;
// edited text is re-embedded. Misses go through batch embed with an append-only
// sidecar (<file>.embeddings.jsonl), so kills resume with zero lost progress.
// Writes fresh JSONs back with all embeddings filled (T07 loader asserts this).
// Usage: node scripts/embed-clic-judgment.mjs [--lang=en]   (judgments always processed)
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(k + '=')); return m ? m.slice(k.length + 1) : d; };
const LANG = arg('--lang', 'en');
const LOGFILE = process.env.EMBED_LOG || '/tmp/embed-clic-judg-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}="(.*)"$`, 'm')) || [])[1] || '';
const RAW_ENDPOINT = (get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
let HOST = '';
try { HOST = new URL(RAW_ENDPOINT).hostname; }
catch { HOST = (RAW_ENDPOINT.split('/')[2] || '').split(':')[0]; }
const IS_FOUNDRY = /\.services\.ai\.azure\.com$/i.test(HOST);
// Foundry's OpenAI-compatible surface is already versioned at /openai/v1
// (and rejects api-version query params); classic *.openai.azure.com
// resources need the path appended plus api-version instead.
const BASE_URL = IS_FOUNDRY
  ? RAW_ENDPOINT.replace(/\/openai\/v1$/, '') + '/openai/v1/'
  : RAW_ENDPOINT + '/openai/v1/';
const client = new OpenAI({
  apiKey: get('AZURE_OPENAI_KEY') || undefined,
  baseURL: BASE_URL || undefined,
  ...(IS_FOUNDRY ? {} : { defaultQuery: { 'api-version': 'preview' } }),
});
const MODEL = get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT') || 'text-embedding-3-large';
const dir = path.join(__dirname, 'index-output');

const textHash = (text) => createHash('sha1').update(text ?? '', 'utf8').digest('hex');
async function readJsonlIds(f) {
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  // Values are { embedding, textHash }; lines without a hash predate verification
  // and are treated as misses so stale vectors are never reused.
  for await (const line of rl) { if (line.trim()) { const r = JSON.parse(line); map.set(r.id, r); } }
  return map;
}

async function processFile({ fresh, cache, textField, batch, label }) {
  const freshPath = path.join(dir, fresh);
  if (!fs.existsSync(freshPath)) { log(`${label}: ${fresh} missing, skipping`); return { reused: 0, embedded: 0, tokens: 0 }; }
  const rows = JSON.parse(fs.readFileSync(freshPath, 'utf8'));
  const cacheMap = new Map();
  const cachePath = path.join(dir, cache);
  if (fs.existsSync(cachePath)) {
    for (const c of JSON.parse(fs.readFileSync(cachePath, 'utf8'))) {
      if (c.embedding) cacheMap.set(c.id, { text: c[textField] ?? c.content ?? c.summary, embedding: c.embedding });
    }
    log(`${label}: cache ${cache} entries=${cacheMap.size}`);
  } else log(`${label}: no cache ${cache}, all misses`);

  const sidecar = freshPath + '.embeddings.jsonl';
  const sideMap = fs.existsSync(sidecar) ? await readJsonlIds(sidecar) : new Map();
  let reused = 0, changed = 0;
  const todo = [];
  for (const r of rows) {
    if (r.embedding) continue; // already filled (re-run)
    const hit = cacheMap.get(r.id);
    if (hit && hit.text === r[textField]) { r.embedding = hit.embedding; reused++; continue; }
    if (hit) changed++;
    const s = sideMap.get(r.id);
    if (s?.embedding && s.textHash === textHash(r[textField])) { r.embedding = s.embedding; reused++; continue; }
    if (s) changed++;
    todo.push(r);
  }
  log(`${label}: rows=${rows.length} reused=${reused} text_changed=${changed} pending=${todo.length}`);
  let tokens = 0;
  for (let b = 0; b < todo.length; b += batch) {
    const items = todo.slice(b, b + batch);
    const res = await client.embeddings.create({ model: MODEL, input: items.map((r) => r[textField]) });
    const lines = res.data.map((d, k) => { items[k].embedding = d.embedding; return JSON.stringify({ id: items[k].id, textHash: textHash(items[k][textField]), embedding: d.embedding }); });
    fs.appendFileSync(sidecar, lines.join('\n') + '\n');
    tokens += res.usage?.prompt_tokens ?? 0;
    const n = Math.ceil((b + batch) / batch), t = Math.ceil(todo.length / batch);
    if (n % 10 === 0 || b + batch >= todo.length) log(`  batch ${n}/${t} tokens=${tokens} est=$${(tokens * 0.13 / 1e6).toFixed(2)}`);
  }
  const nulls = rows.filter((r) => !r.embedding || !r.embedding.length).length;
  if (nulls) throw new Error(`${label}: ${nulls} rows still without embedding`);
  const dim = rows[0].embedding.length;
  if (!rows.every((r) => r.embedding.length === dim)) throw new Error(`${label}: mixed embedding dims`);
  fs.writeFileSync(freshPath, JSON.stringify(rows));
  log(`${label}: DONE rows=${rows.length} dim=${dim} reused=${reused} embedded_this_run=${todo.length} tokens=${tokens}`);
  return { reused, embedded: todo.length, tokens };
}

try {
  const langs = [LANG, 'sc', 'tc'].filter((l, i, a) => a.indexOf(l) === i);
  let tokens = 0, embedded = 0, reused = 0;
  for (const l of langs) {
    const r = await processFile({ fresh: `chunks-${l}.json`, cache: `chunks-${l}.cached.json`, textField: 'content', batch: 100, label: `clic-${l}` });
    tokens += r.tokens; embedded += r.embedded; reused += r.reused;
  }
  const j = await processFile({ fresh: 'judgment-summaries.json', cache: 'judgment-summaries.cached.json', textField: 'summary', batch: 10, label: 'judgment' });
  tokens += j.tokens; embedded += j.embedded; reused += j.reused;
  log(`ALL DONE reused=${reused} embedded=${embedded} tokens=${tokens} est=$${(tokens * 0.13 / 1e6).toFixed(2)}`);
} catch (e) {
  console.error('EMBED_FAILED (sidecars keep progress, re-run to resume):', e.message);
  process.exitCode = 1;
}
