import assert from 'node:assert/strict';
import pg from 'pg';
import { searchJudgmentChunks } from '@/lib/pg-search';
import { searchJudgmentsTool, judgmentToolOutputSchema } from '@/lib/tools/search-judgments';
import { withTimeout } from '@/lib/tools/shared';
import { prisma } from '@/lib/prisma';
async function main() {
 const url = new URL(process.env.DATABASE_URL ?? '');
 assert(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/clic_judgment_test_'));
 const client = new pg.Client({connectionString:url.href});
 await client.connect();
 let renamed = false;
 try {
  process.env.JUDGMENT_FULLTEXT_ENABLED='true';
  const embedding = [1,...Array(3071).fill(0)];
  await client.query('BEGIN');
  try {
   await client.query('LOCK TABLE judgment_fulltext_chunks IN ACCESS EXCLUSIVE MODE');
   const hits = await withTimeout(
    searchJudgmentChunks('landlord',{embedding,languageCodes:['en']}),
    9_000,
    'summary fallback while full-text is locked',
   );
   assert(hits.some(hit=>hit.judgmentId===1 && !hit.documentId && hit.content.includes('Legacy landlord')));
  } finally {
   await client.query('ROLLBACK');
  }
  await client.query('ALTER TABLE judgment_fulltext_chunks RENAME TO review_unavailable_chunks');
  renamed=true;
  const hits = await searchJudgmentChunks('landlord',{embedding,languageCodes:['en']});
  assert(hits.some(hit=>hit.judgmentId===1 && !hit.documentId && hit.content.includes('Legacy landlord')));
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('Network disabled in fallback regression');};
  try {
   assert(searchJudgmentsTool.execute);
   const result=judgmentToolOutputSchema.parse(await searchJudgmentsTool.execute({query:'landlord',languageCode:'en'},{toolCallId:'fallback-regression',messages:[],context:{}}));
   assert('results' in result && result.results.some(hit=>hit.judgmentId===1 && hit.snippet.includes('Legacy landlord')));
  } finally {globalThis.fetch=previousFetch;}
  console.log(JSON.stringify({passed:true,fulltextLockTimeout:true,fulltextUnavailable:true,summaryPreserved:true,providerCalls:0}));
 } finally {
  if(renamed) await client.query('ALTER TABLE review_unavailable_chunks RENAME TO judgment_fulltext_chunks');
  await client.end();await prisma.$disconnect();
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
