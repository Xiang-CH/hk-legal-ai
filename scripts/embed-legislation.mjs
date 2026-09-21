// T17 step 2 — embed sharded legislation JSONL via Foundry/AOAI endpoint.
// Per-shard sidecar: <shard>.embeddings.jsonl (append-only). A shard whose sidecar
// already has every id is skipped, so re-runs resume fast without giant reads.
// Usage: node scripts/embed-legislation.mjs --lang=en
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(k + '=')); return m ? m.slice(k.length + 1) : d; };
const LANG = arg('--lang', 'en');
const BATCH = 100;
const LOGFILE = process.env.EMBED_LOG || '/tmp/embed-leg-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}="(.*)"$`, 'm')) || [])[1] || '';

const client = new OpenAI({
  apiKey: get('AZURE_OPENAI_KEY') || undefined,
  baseURL: (get('AZURE_OPENAI_ENDPOINT') || '') + '/openai/v1/' || undefined,
  defaultQuery: { 'api-version': 'preview' },
});
const MODEL = get('AZURE_OPENAI_EMBEDDING_DEPLOYMENT') || 'text-embedding-3-large';
const countLines = (f) => new Promise((resolve, reject) => {
  let n = 0, tail = true;
  fs.createReadStream(f).on('data', (buf) => { for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { n++; tail = true; } else tail = false; })
    .on('end', () => resolve(tail === false ? n + 1 : n)).on('error', reject);
});

const dir = path.join(__dirname, 'index-output');
const shards = fs.readdirSync(dir).filter((f) => f.startsWith(`legislation-chunks-${LANG}.shard-`) && f.endsWith('.jsonl') && !f.includes('.embeddings.')).sort();
if (!shards.length) throw new Error(`no shards for lang=${LANG} — run chunk-legislation (or split-json) first`);
let promptTokens = 0, embeddedTotal = 0;
try {
  for (const [si, shard] of shards.entries()) {
    const shardPath = path.join(dir, shard);
    const sidecar = shardPath.replace(/\.jsonl$/, '.embeddings.jsonl');
    const total = await countLines(shardPath);
    const doneCount = fs.existsSync(sidecar) ? await countLines(sidecar) : 0;
    if (doneCount >= total) { log(`shard ${si + 1}/${shards.length} ${shard}: done (${total}), skipping`); continue; }
    // resume: ids already in sidecar
    const doneIds = new Set();
    if (doneCount) {
      const rl = readline.createInterface({ input: fs.createReadStream(sidecar), crlfDelay: Infinity });
      for await (const line of rl) { if (line.trim()) doneIds.add(JSON.parse(line).id); }
    }
    const todo = [];
    {
      const rl = readline.createInterface({ input: fs.createReadStream(shardPath), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const c = JSON.parse(line);
        if (!doneIds.has(c.id)) todo.push(c);
      }
    }
    log(`shard ${si + 1}/${shards.length} ${shard}: total=${total} pending=${todo.length}`);
    for (let b = 0; b < todo.length; b += BATCH) {
      const items = todo.slice(b, b + BATCH);
      const res = await client.embeddings.create({ model: MODEL, input: items.map((c) => c.content) });
      fs.appendFileSync(sidecar, res.data.map((d, k) => JSON.stringify({ id: items[k].id, embedding: d.embedding })).join('\n') + '\n');
      promptTokens += res.usage?.prompt_tokens ?? 0;
      embeddedTotal += items.length;
      const n = Math.ceil((b + BATCH) / BATCH), t = Math.ceil(todo.length / BATCH);
      if (n % 10 === 0 || b + BATCH >= todo.length) log(`  batch ${n}/${t} tokens=${promptTokens} est=$${(promptTokens * 0.13 / 1e6).toFixed(2)}`);
    }
  }
  log(`DONE lang=${LANG} embedded_this_run=${embeddedTotal} tokens=${promptTokens} est=$${(promptTokens * 0.13 / 1e6).toFixed(2)}`);
} catch (e) {
  console.error('EMBED_FAILED (sidecars keep progress, re-run to resume):', e.message);
  process.exitCode = 1;
}
