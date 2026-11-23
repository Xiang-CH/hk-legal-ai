import assert from "node:assert/strict";
import { searchJudgmentChunks } from "@/lib/pg-search";
import { prisma } from "@/lib/prisma";

async function main() {
 const url = new URL(process.env.DATABASE_URL ?? "");
 if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.startsWith("/clic_judgment_test_")) throw new Error("Local fixture database required");
 const legacy = process.argv.includes("--legacy");
 process.env.JUDGMENT_FULLTEXT_ENABLED = legacy ? "false" : "true";
 try {
  const hits = await searchJudgmentChunks("landlord", { embedding: [1, ...Array(3071).fill(0)], languageCodes: ["en"] });
  assert(hits.some(hit => hit.judgmentId === 1 && hit.chunk_no === 0 && !hit.documentId), "Existing summary must remain retrievable");
  if (!legacy) assert(hits.some(hit => hit.judgmentId === 1 && hit.chunk_no === 0 && hit.documentId), "Full text and summary chunk zero must coexist");
  else assert(hits.every(hit => !hit.documentId));
  if (legacy) {
   assert.equal(await prisma.judgment.count(), 6);
   const capLinks=await prisma.$queryRawUnsafe<Array<{count:number}>>('SELECT count(*)::int AS count FROM "_JudgmentToLegislationCap" WHERE "A"=1 AND "B"=1');
   assert.equal(capLinks[0].count,1,"Rollback must preserve pre-existing legislation links");
   const sectionLinks=await prisma.$queryRawUnsafe<Array<{count:number}>>('SELECT count(*)::int AS count FROM "_JudgmentToLegislationSection"');
   assert.equal(sectionLinks[0].count,0,"Rollback must remove only importer-owned legislation links");
  }
  console.log(JSON.stringify({ legacy, summaryPreserved: true, coexistence: !legacy, providerCalls: 0 }));
 } finally {
  await prisma.$disconnect();
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
