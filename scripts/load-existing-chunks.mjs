// One-shot load of pre-existing chunk JSONs (with embeddings) into pg.
// - scripts/index-output/chunks-en.json      -> clic_chunks (language_code='en')
// - scripts/index-output/judgment-summaries.json -> judgment_chunks (language from Judgment row, fallback 'en')
// Idempotent: ON CONFLICT DO NOTHING (needs 20260911 unique indexes). Skips rows whose FK target is missing.
// Aborts if any JSON row lacks an embedding (run T06 embed first).
// After load: tsv (english/simple) + cjk_tokens + HNSW/GIN x4 per table + ANALYZE.
// Usage: node scripts/load-existing-chunks.mjs [--skip-load]  (--skip-load: straight to tsv + indexes)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGFILE = process.env.CHUNK_LOG || '/tmp/load-chunks-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const pgUrl = env.match(/^DATABASE_URL="(.*)"$/m)[1];
const pool = new pg.Pool({ connectionString: pgUrl, max: 2 });
const SKIP_LOAD = process.argv.includes('--skip-load');
// Keep in sync with scripts/cjk.ts (no zhparser on Flexible).
const cjkTokens = (s) => {
  const cjk = (s.match(/[一-鿿㐀-䶿豈-﫿]+/gu) ?? []);
  const grams = cjk.flatMap((w) => (w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))));
  const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...grams, ...words].join(' ');
};
const vec = (arr) => '[' + arr.join(',') + ']';

const counts = { clic: 0, judgment: 0, skipped: 0 };
const needEmb = (rows, label) => { const n = rows.filter((r) => !r.embedding || !r.embedding.length).length; if (n) throw new Error(`${label}: ${n}/${rows.length} rows lack embeddings — run scripts/embed-clic-judgment.mjs first`); };
try {
  if (!SKIP_LOAD) {
  // --- clic_chunks (en) ---
  const clic = JSON.parse(fs.readFileSync(path.join(__dirname, 'index-output/chunks-en.json'), 'utf8'));
  needEmb(clic, 'clic');
  log(`clic chunks in JSON: ${clic.length}`);
  for (let i = 0; i < clic.length; i += 100) {
    const batch = clic.slice(i, i + 100);
    const params = [];
    const tuples = batch.map((c) => {
      params.push(c.nid, c.chunk_no, 'en', c.title, c.content, c.url, c.topic, c.context ?? null, vec(c.embedding));
      const o = params.length;
      return `($${o - 8}, $${o - 7}, $${o - 6}, $${o - 5}, $${o - 4}, $${o - 3}, $${o - 2}, $${o - 1}, $${o}::halfvec)`;
    });
    const r = await pool.query(
      `INSERT INTO "clic_chunks" ("nid","chunk_no","language_code","title","content","url","topic","context","embedding") VALUES ${tuples.join(', ')} ON CONFLICT ("nid","language_code","chunk_no") DO NOTHING`, params);
    counts.clic += r.rowCount;
    log(`  clic ${Math.min(i + 100, clic.length)}/${clic.length} (+${r.rowCount})`);
  }

  // --- judgment_chunks ---
  const jud = JSON.parse(fs.readFileSync(path.join(__dirname, 'index-output/judgment-summaries.json'), 'utf8'));
  needEmb(jud, 'judgment');
  log(`judgment chunks in JSON: ${jud.length}`);
  const ids = [...new Set(jud.map((j) => j.judgmentId))];
  const langRows = await pool.query(`SELECT "id", "languageCode" FROM "Judgment" WHERE "id" = ANY($1)`, [ids]);
  const langOf = new Map(langRows.rows.map((r) => [r.id, r.languageCode]));
  const missing = ids.filter((id) => !langOf.has(id));
  if (missing.length) log(`  WARNING: ${missing.length} judgmentIds not in pg, skipping: ${missing.slice(0, 10).join(',')}`);
  const ok = jud.filter((j) => langOf.has(j.judgmentId));
  for (let i = 0; i < ok.length; i += 100) {
    const batch = ok.slice(i, i + 100);
    const params = [];
    const tuples = batch.map((j) => {
      params.push(j.judgmentId, j.chunk_no, langOf.get(j.judgmentId) || 'en', j.neutralCitation ?? null,
        j.courtName ?? null, j.year ?? null, j.date ?? null, j.parties ?? null, j.summary,
        j.summarySource ?? null, j.url ?? null, vec(j.embedding));
      const o = params.length;
      return `($${o - 11}, $${o - 10}, $${o - 9}, $${o - 8}, $${o - 7}, $${o - 6}, $${o - 5}, $${o - 4}, $${o - 3}, $${o - 2}, $${o - 1}, $${o}::halfvec)`;
    });
    const r = await pool.query(
      `INSERT INTO "judgment_chunks" ("judgment_id","chunk_no","language_code","neutral_citation","court_name","year","date","parties","content","summary_source","url","embedding") VALUES ${tuples.join(', ')} ON CONFLICT ("judgment_id","chunk_no") DO NOTHING`, params);
    counts.judgment += r.rowCount;
    log(`  judgment ${Math.min(i + 100, ok.length)}/${ok.length} (+${r.rowCount})`);
  }
  counts.skipped = jud.length - ok.length;
  log(`DONE clic=${counts.clic} judgment=${counts.judgment} skipped=${counts.skipped}`);
  } else { log('skip-load: INSERTs skipped'); }
  // --- tsv + cjk (conditional: only NULL rows) ---
  await pool.query(`UPDATE "clic_chunks" SET "tsv" = CASE WHEN "language_code" = 'en' THEN to_tsvector('english', COALESCE("title",'') || ' ' || "content") ELSE to_tsvector('simple', COALESCE("title",'') || ' ' || "content") END WHERE "tsv" IS NULL`);
  await pool.query(`UPDATE "judgment_chunks" SET "tsv" = CASE WHEN "language_code" = 'en' THEN to_tsvector('english', COALESCE("neutral_citation",'') || ' ' || "content") ELSE to_tsvector('simple', COALESCE("neutral_citation",'') || ' ' || "content") END WHERE "tsv" IS NULL`);
  for (const [tbl, expr] of [
    ['clic_chunks', `COALESCE("title",'') || ' ' || "content"`],
    ['judgment_chunks', `COALESCE("neutral_citation",'') || ' ' || "content"`],
  ]) {
    const r = await pool.query(`SELECT "id", (${expr}) AS t FROM "${tbl}" WHERE "language_code" <> 'en' AND "cjk_tokens" IS NULL`);
    for (const row of r.rows) await pool.query(`UPDATE "${tbl}" SET "cjk_tokens" = $2 WHERE "id" = $1`, [row.id, cjkTokens(row.t)]);
    if (r.rows.length) log(`cjk filled: ${tbl} +${r.rows.length}`);
  }
  log('tsv filled');
  // --- indexes (only if missing) + ANALYZE ---
  await pool.query("SET maintenance_work_mem = '1GB'"); log('maintenance_work_mem=1GB for HNSW build');
  const want = [
    ['clic_chunks_embedding_hnsw', `CREATE INDEX "clic_chunks_embedding_hnsw" ON "clic_chunks" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m=16, ef_construction=64)`],
    ['clic_chunks_tsv_gin', `CREATE INDEX "clic_chunks_tsv_gin" ON "clic_chunks" USING gin ("tsv")`],
    ['clic_chunks_cjk_gin', `CREATE INDEX "clic_chunks_cjk_gin" ON "clic_chunks" USING gin ("cjk_tokens" gin_trgm_ops)`],
    ['clic_chunks_content_trgm', `CREATE INDEX "clic_chunks_content_trgm" ON "clic_chunks" USING gin ("content" gin_trgm_ops)`],
    ['judgment_chunks_embedding_hnsw', `CREATE INDEX "judgment_chunks_embedding_hnsw" ON "judgment_chunks" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m=16, ef_construction=64)`],
    ['judgment_chunks_tsv_gin', `CREATE INDEX "judgment_chunks_tsv_gin" ON "judgment_chunks" USING gin ("tsv")`],
    ['judgment_chunks_cjk_gin', `CREATE INDEX "judgment_chunks_cjk_gin" ON "judgment_chunks" USING gin ("cjk_tokens" gin_trgm_ops)`],
    ['judgment_chunks_content_trgm', `CREATE INDEX "judgment_chunks_content_trgm" ON "judgment_chunks" USING gin ("content" gin_trgm_ops)`],
  ];
  const { rows: ix } = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('clic_chunks','judgment_chunks')`);
  const has = new Set(ix.map((r) => r.indexname));
  for (const [name, ddl] of want) {
    if (has.has(name)) { log(`index exists: ${name}`); continue; }
    await pool.query(ddl);
    log(`index created: ${name}`);
  }
  await pool.query(`ANALYZE "clic_chunks"`);
  await pool.query(`ANALYZE "judgment_chunks"`);
  {
    const c = await pool.query(`SELECT COUNT(*)::int n FROM "clic_chunks"`);
    const j = await pool.query(`SELECT COUNT(*)::int n FROM "judgment_chunks"`);
    log(`VERIFY clic_chunks=${c.rows[0].n} judgment_chunks=${j.rows[0].n}`);
  }
} catch (e) {
  console.error('LOAD_FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
