// Index only an explicit English CLIC nid selection. Checkpoints live outside git.
// Usage: node --env-file=/path/to/.env scripts/index-clic-selection.mjs selection.json checkpoint.json [--apply]
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import OpenAI from 'openai';
import { TokenTextSplitter } from '@langchain/textsplitters';

const [selectionPath, checkpointPath] = process.argv.slice(2);
if (!selectionPath || !checkpointPath) throw new Error('Provide selection.json and checkpoint.json');
const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
const nids = [...new Set(selection.map(r => r.nid))];
if (!nids.length || !nids.every(Number.isSafeInteger)) throw new Error('Selection must contain integer nids');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 20000 });
const hash = text => createHash('sha256').update(text).digest('hex');
const splitter = new TokenTextSplitter({ chunkSize: 512, chunkOverlap: 128, encodingName: 'o200k_base' });
try {
  await db.connect();
  const { rows: pages } = await db.query(`SELECT p.*, (SELECT count(*)::int FROM clic_chunks c WHERE c.nid=p.nid AND c.language_code='en') AS chunk_count FROM "ClicPage" p WHERE p.nid=ANY($1::int[]) AND p."languageCode"='en' ORDER BY p.nid`, [nids]);
  if (pages.length !== nids.length) throw new Error(`Missing pages: expected ${nids.length}, found ${pages.length}`);
  const todo = pages.filter(p => p.chunk_count === 0);
  console.log(JSON.stringify({ selectedPages: pages.length, alreadyIndexed: pages.length - todo.length, pagesToIndex: todo.length }));
  if (!process.argv.includes('--apply')) {
    console.log('Read-only plan. Pass --apply to embed and load missing pages.');
  } else if (todo.length) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, '');
    if (!endpoint || !process.env.AZURE_OPENAI_KEY) throw new Error('Azure embedding configuration missing');
    const model = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-large';
    const client = new OpenAI({ apiKey: process.env.AZURE_OPENAI_KEY, baseURL: endpoint.replace(/\/openai\/v1$/, '') + '/openai/v1/', ...(/\.services\.ai\.azure\.com/.test(endpoint) ? {} : { defaultQuery: { 'api-version': 'preview' } }) });
    const cached = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) : [];
    const cache = new Map(cached.map(c => [c.hash, c.embedding]));
    const chunks = [];
    for (const p of todo) {
      const texts = await splitter.splitText(p.content);
      if (!texts.length) throw new Error(`Empty page ${p.nid}`);
      for (let i=0; i<texts.length; i++) {
        const key = hash(model + '\n' + texts[i]);
        chunks.push({ nid:p.nid, chunk_no:i, title:p.title, content:texts[i], url:p.url, topic:p.topic, context:p.contextualInformation, hash:key, embedding:cache.get(key) ?? null });
      }
    }
    const save = () => {
      fs.writeFileSync(checkpointPath + '.tmp', JSON.stringify(chunks));
      fs.renameSync(checkpointPath + '.tmp', checkpointPath);
    };
    const missing = chunks.filter(c => !c.embedding);
    console.log(`chunks=${chunks.length}, embedding misses=${missing.length}`);
    for (let i=0; i<missing.length; i+=32) {
      const batch = missing.slice(i,i+32);
      const response = await client.embeddings.create({ model, input:batch.map(c => c.content) });
      if (response.data.length !== batch.length) throw new Error('Incomplete embedding response');
      for (const item of response.data) {
        if (!batch[item.index] || item.embedding.length !== 3072 || !item.embedding.every(Number.isFinite)) throw new Error('Invalid embedding');
        batch[item.index].embedding = item.embedding;
      }
      save();
      console.log(`embedded ${Math.min(i+32,missing.length)}/${missing.length}, tokens=${response.usage?.total_tokens}`);
    }
    if (!chunks.every(c => c.embedding?.length === 3072 && c.embedding.every(Number.isFinite))) throw new Error('Incomplete checkpoint');
    save();
    await db.query('BEGIN');
    try {
      let inserted = 0;
      for (let i=0; i<chunks.length; i+=100) {
        const params = [];
        const tuples = chunks.slice(i,i+100).map(c => {
          const o=params.length;
          params.push(c.nid,c.chunk_no,c.title,c.content,c.url,c.topic,c.context,'['+c.embedding.join(',')+']');
          return `($${o+1},$${o+2},'en',$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8}::halfvec,to_tsvector('english',coalesce($${o+3},'') || ' ' || $${o+4}))`;
        });
        const r = await db.query(`INSERT INTO clic_chunks (nid,chunk_no,language_code,title,content,url,topic,context,embedding,tsv) VALUES ${tuples.join(',')} ON CONFLICT (nid,language_code,chunk_no) DO NOTHING`, params);
        inserted += r.rowCount;
      }
      await db.query('COMMIT');
      console.log(`Inserted ${inserted} chunks for ${todo.length} pages`);
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    await db.query('ANALYZE clic_chunks');
  }
  const {rows:verify} = await db.query(`SELECT count(*)::int AS chunks,count(DISTINCT nid)::int AS pages,count(*) FILTER (WHERE embedding IS NULL OR vector_dims(embedding::vector)<>3072)::int AS invalid_embeddings,count(*) FILTER (WHERE tsv IS NULL)::int AS missing_tsv FROM clic_chunks WHERE language_code='en' AND nid=ANY($1::int[])`,[nids]);
  console.log('Verification:',JSON.stringify(verify[0]));
  if (process.argv.includes('--apply') && (verify[0].pages !== nids.length || verify[0].invalid_embeddings || verify[0].missing_tsv)) throw new Error('Index verification failed');
} finally { await db.end(); }
