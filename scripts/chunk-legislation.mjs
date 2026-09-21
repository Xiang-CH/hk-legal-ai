// T17 step 1 — chunk LegislationSection rows from pg into sharded JSONL checkpoints.
// Streams output (never holds all chunks), keyset-pages the pg read.
// Context per chunk = cap title + section heading. Splitter: TokenTextSplitter(512/128, o200k_base).
// Usage: node scripts/chunk-legislation.mjs --lang=en [--limit=500]
// Output: scripts/index-output/legislation-chunks-{lang}.shard-NNNN.jsonl
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { TokenTextSplitter } from '@langchain/textsplitters';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(k + '=')); return m ? m.slice(k.length + 1) : d; };
const LANG = arg('--lang', 'en');
const LIMIT = parseInt(arg('--limit', '0'), 10);
const SHARD = 25000;
const LOGFILE = process.env.CHUNK_LOG || '/tmp/chunk-leg-out.txt';
const log = (...a) => { const line = a.join(' ') + '\n'; fs.appendFileSync(LOGFILE, line); console.log(...a); };
const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const pgUrl = env.match(/^DATABASE_URL="(.*)"$/m)[1];

const splitter = new TokenTextSplitter({ chunkSize: 512, chunkOverlap: 128, encodingName: 'o200k_base' });
const pool = new pg.Pool({ connectionString: pgUrl, max: 2 });

try {
  let lastId = 0, sections = 0, chunks = 0, shardN = 0, inShard = 0, out = null;
  const prefix = path.join(__dirname, 'index-output', `legislation-chunks-${LANG}`);
  const openShard = () => { out?.end(); out = fs.createWriteStream(`${prefix}.shard-${String(shardN++).padStart(4, '0')}.jsonl`); inShard = 0; };
  openShard();
  for (;;) {
    const { rows } = await pool.query(
      `SELECT s."id", s."capNumber", s."sectionNumber", s."subsectionNumber", s."sectionHeading", s."content", s."url", c."title" AS "capTitle"
       FROM "LegislationSection" s JOIN "LegislationCap" c
         ON c."capNumber" = s."capNumber" AND c."languageCode" = s."languageCode"
       WHERE s."languageCode" = $1 AND s."id" > $2 ORDER BY s."id" LIMIT 2000`, [LANG, lastId]);
    if (!rows.length) break;
    for (const s of rows) {
      const context = [s.capTitle, s.sectionHeading].filter(Boolean).join('\n');
      const pieces = await splitter.splitText(s.content);
      pieces.forEach((content, chunk_no) => {
        out.write(JSON.stringify({
          id: `${s.id}_${chunk_no}`, section_id: s.id, chunk_no, language_code: LANG,
          cap_number: s.capNumber, section_number: s.sectionNumber, subsection_number: s.subsectionNumber,
          heading: s.sectionHeading, content, url: s.url, context,
        }) + '\n');
        chunks++; inShard++;
        if (inShard >= SHARD) openShard();
      });
      sections++;
      if (LIMIT && sections >= LIMIT) break;
    }
    lastId = rows[rows.length - 1].id;
    log(`  sections=${sections} chunks=${chunks}`);
    if (LIMIT && sections >= LIMIT) break;
  }
  out.end();
  log(`DONE lang=${LANG} sections=${sections} chunks=${chunks} shards=${shardN} prefix=${prefix}`);
} catch (e) {
  console.error('CHUNK_FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
