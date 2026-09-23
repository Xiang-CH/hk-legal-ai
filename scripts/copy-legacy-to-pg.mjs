// T04 — one-shot copy from legacy Azure SQL (read-only) to pg clic_chat.
// Preserves surrogate `id` values so junction tables + FK graph stay intact,
// then fixes serial sequences. Safe to re-run: uses plain INSERT into tables
// that must be empty (checks + aborts otherwise, unless --resume).
// Usage: node scripts/copy-legacy-to-pg.mjs [--resume]
import fs from 'fs';
import ted from 'tedious';
import pg from 'pg';

const RESUME = process.argv.includes('--resume');
const LOGFILE = process.env.COPY_LOG || '/tmp/copy-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const legacy = env.match(/^DATABASE_URL_SQLSERVER_BACKUP="(.*)"$/m)[1];
const pgUrl = env.match(/^DATABASE_URL="(.*)"$/m)[1];
const pw = legacy.match(/password=\{(.*?)\};encrypt/i)[1];
const user = legacy.match(/;user=([^;]+)/)[1];

const ENTITY_TABLES = ['LegislationCap', 'LegislationSection', 'Interpretation', 'ClicPage', 'Case', 'Judgment', 'ParallelCitations'];
const JUNCTION_TABLES = ['_ClicPageRelationToClicPage', '_ClicPageToLegislationSection', '_ClicPageToLegislationCap', '_ClicPageToJudgment', '_LegislationSectionToLegislationSection', '_LegislationSectionToLegislationCap', '_InterpretationToLegislationSection', '_JudgmentToLegislationSection', '_JudgmentToLegislationCap', '_JudgmentToJudgment', '_CaseToJudgment'];

function connectLegacy() {
  return new Promise((resolve, reject) => {
    const conn = new ted.Connection({
      server: 'legal-ai-sql.database.windows.net',
      authentication: { type: 'default', options: { userName: user, password: pw } },
      options: { database: 'legal-ai-sql-db', encrypt: true, connectTimeout: 15000, requestTimeout: 300000 },
    });
    conn.on('connect', (err) => err ? reject(err) : resolve(conn));
    conn.connect();
  });
}
function legacyQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = new ted.Request(sql, (err) => err ? reject(err) : resolve(rows));
    req.on('row', (cols) => rows.push(cols.map(c => c.value)));
    conn.execSql(req);
  });
}

const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
const pgCols = async (table) => {
  const r = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table]);
  return r.rows.map(x => x.column_name);
};
const esc = (id) => `"${id.replace(/"/g, '""')}"`;

async function copyEntity(conn, table, columns) {
  const [{ n: total }] = (await legacyQuery(conn, `SELECT COUNT(*) AS n FROM [${table}]`)).map(r => ({ n: r[0] }));
  log(`${table}: ${total} rows`);
  if (total === 0) return 0;
  const { rows: existing } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${esc(table)}`);
  if (existing[0].n > 0 && !RESUME) throw new Error(`${table} not empty (${existing[0].n}) — aborting. Use --resume to skip filled tables.`);
  if (existing[0].n > 0) {
    if (existing[0].n !== total) throw new Error(`${table} partially filled (${existing[0].n}/${total}) — truncate and re-run`);
    log(`  resume: already has ${existing[0].n}, skipping`); return total;
  }
  const colList = columns.map(esc).join(', ');
  const selectList = columns.map((c) => `[${c}]`).join(', ');
  let lastId = 0, done = 0;
  for (;;) {
    const rows = await legacyQuery(conn, `SELECT TOP 2000 ${selectList} FROM [${table}] WHERE id > ${lastId} ORDER BY id`);
    if (!rows.length) break;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const params = [];
      const tuples = batch.map((row) => `(${row.map((v) => { params.push(v instanceof Date ? v : v); return `$${params.length}`; }).join(', ')})`);
      await pool.query(`INSERT INTO ${esc(table)} (${colList}) VALUES ${tuples.join(', ')}`, params);
    }
    lastId = rows[rows.length - 1][0];
    done += rows.length;
    log(`  ${done}/${total}`);
  }
  return done;
}

async function copyJunction(conn, table) {
  const cols = await pgCols(table); // [A, B]
  const [{ n: total }] = (await legacyQuery(conn, `SELECT COUNT(*) AS n FROM [${table}]`)).map(r => ({ n: r[0] }));
  log(`${table}: ${total} rows`);
  if (total === 0) return 0;
  const { rows: existing } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${esc(table)}`);
  if (existing[0].n > 0 && !RESUME) throw new Error(`${table} not empty — aborting.`);
  if (existing[0].n > 0) {
    if (existing[0].n !== total) throw new Error(`${table} partially filled (${existing[0].n}/${total}) — truncate and re-run`);
    log(`  resume: already has ${existing[0].n}, skipping`); return total;
  }
  const colList = cols.map(esc).join(', ');
  let done = 0, offset = 0;
  for (;;) {
    const selectList = cols.map((c) => `[${c}]`).join(', ');
    const rows = await legacyQuery(conn, `SELECT ${selectList} FROM [${table}] ORDER BY [A], [B] OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY`);
    if (!rows.length) break;
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      const params = [];
      const tuples = batch.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
      await pool.query(`INSERT INTO ${esc(table)} (${colList}) VALUES ${tuples.join(', ')}`, params);
    }
    offset += rows.length; done += rows.length;
    log(`  ${done}/${total}`);
  }
  return done;
}

const counts = {};
try {
  const conn = await connectLegacy();
  log('connected to legacy SQL');
  for (const t of ENTITY_TABLES) counts[t] = await copyEntity(conn, t, await pgCols(t));
  for (const t of JUNCTION_TABLES) counts[t] = await copyJunction(conn, t);
  conn.close();
  // Fix serial sequences (tables with nextval defaults)
  const seq = await pool.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_default LIKE 'nextval%'");
  for (const { table_name, column_name } of seq.rows) {
    const lit = (v) => `'${v.replace(/'/g, "''")}'`;
    await pool.query(`SELECT setval(pg_get_serial_sequence(${lit('"' + table_name + '"')}, ${lit(column_name)}), (SELECT MAX(${esc(column_name)}) FROM ${esc(table_name)}))`);
    log(`sequence fixed: ${table_name}.${column_name}`);
  }
  // Verify pg counts against the legacy source totals (counts[t] is the source total,
  // including resume runs). Any mismatch fails the script.
  let verifyOk = true;
  for (const t of [...ENTITY_TABLES, ...JUNCTION_TABLES]) {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${esc(t)}`);
    const ok = r.rows[0].n === counts[t];
    if (!ok) verifyOk = false;
    log(`VERIFY ${t}: pg=${r.rows[0].n} (source ${counts[t] ?? '?'}) ${ok ? 'OK' : 'MISMATCH'}`);
  }
  if (!verifyOk) throw new Error('VERIFY_FAILED: pg counts do not match legacy source totals');
} catch (e) {
  console.error('COPY_FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
