import assert from "node:assert/strict";
import { z as _schema } from "zod";
import { prisma } from "@/lib/prisma";
import { getFulltext } from "@/lib/judgment-fulltext";
import { mapToolOutputToSources } from "@/lib/agent-stream";

async function main() {
 const url = new URL(process.env.DATABASE_URL ?? "");
 if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.startsWith("/clic_judgment_test_")) throw new Error("Local pilot database required");
 try {
  const rows = _schema.array(_schema.object({ id: _schema.number() })).parse(await prisma.$queryRawUnsafe<unknown>("SELECT judgment_id AS id FROM judgment_documents WHERE source_path=$1", "HKCA/2004/205/EN.json"));
  const document = rows[0];
  assert(document, "Real-source pilot not loaded");
  const first = await getFulltext(document.id, 0, 1, "outgoing", 1);
  assert.equal(first.references.length, 1);
  assert(first.nextReferenceId);
  const second = await getFulltext(document.id, 0, 1, "outgoing", 1, first.nextReferenceId);
  assert.equal(second.references.length, 1);
  assert.notEqual(first.references[0].id, second.references[0].id);
  assert(first.occurrences.length <= 3);
  const sources = mapToolOutputToSources("get_case", first);
  assert.equal(sources.length, 1);
  assert(sources[0].url.includes("hklii.hk"));
  console.log(JSON.stringify({ referencePagination: true, occurrenceBound: true, paragraphSourceMapping: true, providerCalls: 0 }));
 } finally {
  await prisma.$disconnect();
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
