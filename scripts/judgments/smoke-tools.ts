import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { searchJudgmentsTool, judgmentToolOutputSchema } from "@/lib/tools/search-judgments";
import { getCaseTool, caseToolOutputSchema } from "@/lib/tools/get-case";

async function main() {
 if (!process.argv.includes("--approve-cost")) throw new Error("Explicit embedding pilot approval required");
 const url = new URL(process.env.DATABASE_URL ?? "");
 if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.startsWith("/clic_judgment_test_")) throw new Error("Local disposable pilot database required");
 if (process.env.JUDGMENT_FULLTEXT_ENABLED !== "true" || process.env.RERANK_ENABLED === "true") throw new Error("Enable full text and disable paid reranking for this pilot");
 if (!searchJudgmentsTool.execute || !getCaseTool.execute) throw new Error("Tools unavailable");
 const reportPath=process.argv.find(value=>value.startsWith("--output="))?.slice("--output=".length)??".audit/judgment-app-pilot.json";
 const report = await open(reportPath, "wx", 0o600);
 const tests = [
  { query: "A printer and a matchbox manufacturer disagree over approval of advertising samples and whether the printing contract was breached.", languageCode: "en", expected: "[1900] HKDC 1" },
  { query: "清潔公司不服向年長工人支付遣散費的裁決，但覆核時沒有提出新的理據。", languageCode: "tc", expected: "[2012] HKLaT 1" },
  { query: "謀殺案被告沒有作供時，陪審團應怎樣考慮激怒抗辯？", languageCode: "tc", expected: "[1997] HKCFA 1" },
 ];
 const results = [];
 try {
  for (const test of tests) {
   const options = { toolCallId: "judgment-pilot", messages: [], context: {} };
   const output = judgmentToolOutputSchema.parse(await searchJudgmentsTool.execute({ query: test.query, languageCode: test.languageCode }, options));
   assert("results" in output, "Search tool returned an error");
   const matching = output.results.find(item => item.neutralCitation === test.expected && item.contentType === "fulltext");
   assert(matching, `Expected authority missing from top results: ${test.expected}`);
   assert(matching.startPosition !== undefined && matching.endPosition !== undefined);
   const document = caseToolOutputSchema.parse(await getCaseTool.execute({ judgment_id: matching.judgmentId, start_position: matching.startPosition, end_position: Math.min(matching.endPosition, matching.startPosition + 99), reference_direction: "both", reference_limit: 20 }, options));
   assert("paragraphs" in document && document.paragraphs.length > 0);
   results.push({ query: test.query, expected: test.expected, rank: output.results.indexOf(matching) + 1, sourceAnchor: matching.sourceAnchor, url: matching.url, paragraphs: document.paragraphs.length, references: document.references.length, passed: true });
  }
  const result = { completedAt: new Date().toISOString(), queries: tests.length, accounting: "Query tokens covered by the existing 10000-token pilot ledger reserve", rerankProviderCalls: 0, target: "local pilot", results };
  await report.writeFile(JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
 } finally {
  await report.close();
  await prisma.$disconnect();
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
