// T17 step 3 — load sharded legislation JSONL + per-shard embedding sidecars into pg,
// then tsv + HNSW/GIN (T07 pattern). Streams everything; INSERTs batch across shards.
// Idempotent: ON CONFLICT DO NOTHING; indexes created only if missing.
// Usage: node scripts/load-legislation-chunks.mjs --lang=en
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(k + '=')); return m ? m.slice(k.length + 1) : d; };
const LANG = arg('--lang', 'en');
const SKIP_LOAD = process.argv.includes('--skip-load'); // skip INSERTs, go straight to tsv + indexes
const LOGFILE = process.env.CHUNK_LOG || '/tmp/load-leg-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const pgUrl = env.match(/^DATABASE_URL="(.*)"$/m)[1];
// Keep in sync with scripts/cjk.ts (no zhparser on Flexible).
const cjkTokens = (s) => {
  const cjk = s.match(/[一-鿿㐀-䶿豈-﫿]+/gu) ?? [];
  const grams = cjk.flatMap((w) => (w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))));
  const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...grams, ...words].join(' ');
};
const vec = (arr) => '[' + arr.join(',') + ']';
const pool = new pg.Pool({ connectionString: pgUrl, max: 2 });

async function* jsonl(f) {
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) yield JSON.parse(line); }
}

try {
  const dir = path.join(__dirname, 'index-output');
  const shards = fs.readdirSync(dir).filter((f) => f.startsWith(`legislation-chunks-${LANG}.shard-`) && f.endsWith('.jsonl') && !f.includes('.embeddings.')).sort();
  if (!shards.length) throw new Error(`no shards for lang=${LANG}`);
  let inserted = 0, n = 0, batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const params = [];
    const tuples = batch.map(({ c, e }) => {
      const cjk = LANG === 'en' ? null : cjkTokens(`${c.heading ?? ''} ${c.content}`);
      params.push(c.section_id, c.chunk_no, LANG, c.cap_number, c.section_number, c.subsection_number ?? null,
        c.heading ?? null, c.content, c.url, c.context ?? null, vec(e), cjk);
      const o = params.length;
      return `($${o - 11}, $${o - 10}, $${o - 9}, $${o - 8}, $${o - 7}, $${o - 6}, $${o - 5}, $${o - 4}, $${o - 3}, $${o - 2}, $${o - 1}::halfvec, $${o})`;
    });
    const r = await pool.query(
      `INSERT INTO "legislation_chunks" ("section_id","chunk_no","language_code","cap_number","section_number","subsection_number","heading","content","url","context","embedding","cjk_tokens") VALUES ${tuples.join(', ')} ON CONFLICT ("section_id","language_code","chunk_no") DO NOTHING`, params);
    inserted += r.rowCount;
    batch = [];
    log(`  rows=${n} (+${r.rowCount})`);
  };
  if (!SKIP_LOAD) {
  for (const shard of shards) {
    const textIt = jsonl(path.join(dir, shard));
    const embIt = jsonl(path.join(dir, shard.replace(/\.jsonl$/, '.embeddings.jsonl')));
    for (;;) {
      const [t, e] = await Promise.all([textIt.next(), embIt.next()]);
      if (t.done && e.done) break;
      if (t.done || e.done) throw new Error(`text/sidecar length mismatch in ${shard} — re-run embed for this shard`);
      if (e.value.id !== t.value.id) throw new Error(`order mismatch in ${shard}: ${e.value.id} vs ${t.value.id}`);
      batch.push({ c: t.value, e: e.value.embedding });
      if (++n % 100 === 0) await flush();
    }
    log(`shard done: ${shard} rows=${n}`);
  }
  await flush();
  } else { log('skip-load: INSERTs skipped'); }
  const cfg = LANG === 'en' ? 'english' : 'simple';
  await pool.query(`UPDATE "legislation_chunks" SET "tsv" = to_tsvector('${cfg}', COALESCE("heading",'') || ' ' || "content") WHERE "language_code" = $1 AND "tsv" IS NULL`, [LANG]);
  log('tsv filled');
  const { rows: ix } = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'legislation_chunks'`);
  const has = new Set(ix.map((r) => r.indexname));
  const want = [
    ['legislation_chunks_embedding_hnsw', `CREATE INDEX "legislation_chunks_embedding_hnsw" ON "legislation_chunks" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m=16, ef_construction=64)`],
    ['legislation_chunks_tsv_gin', `CREATE INDEX "legislation_chunks_tsv_gin" ON "legislation_chunks" USING gin ("tsv")`],
    ['legislation_chunks_cjk_gin', `CREATE INDEX "legislation_chunks_cjk_gin" ON "legislation_chunks" USING gin ("cjk_tokens" gin_trgm_ops)`],
    ['legislation_chunks_content_trgm', `CREATE INDEX "legislation_chunks_content_trgm" ON "legislation_chunks" USING gin ("content" gin_trgm_ops)`],
  ];
  await pool.query("SET maintenance_work_mem = '1GB'"); log('maintenance_work_mem=1GB for HNSW build');
  for (const [name, ddl] of want) {
    if (has.has(name)) { log(`index exists: ${name}`); continue; }
    await pool.query(ddl);
    log(`index created: ${name}`);
  }
  await pool.query(`ANALYZE "legislation_chunks"`);
  const r = await pool.query(`SELECT COUNT(*)::int n FROM "legislation_chunks" WHERE "language_code" = $1`, [LANG]);
  log(`DONE lang=${LANG} inserted=${inserted} total_in_pg=${r.rows[0].n}`);
} catch (e) {
  console.error('LOAD_FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
