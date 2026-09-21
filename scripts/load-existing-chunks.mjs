// One-shot load of pre-existing chunk JSONs (with embeddings) into pg.
// - scripts/index-output/chunks-en.json      -> clic_chunks (language_code='en')
// - scripts/index-output/judgment-summaries.json -> judgment_chunks (language from Judgment row, fallback 'en')
// Idempotent: ON CONFLICT DO NOTHING. Skips rows whose FK target is missing.
// Usage: node scripts/load-existing-chunks.mjs
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
const vec = (arr) => '[' + arr.join(',') + ']';

const counts = { clic: 0, judgment: 0, skipped: 0 };
try {
  // --- clic_chunks (en) ---
  const clic = JSON.parse(fs.readFileSync(path.join(__dirname, 'index-output/chunks-en.json'), 'utf8'));
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
} catch (e) {
  console.error('LOAD_FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
