import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { searchFulltext, getFulltext } from "@/lib/judgment-fulltext";

async function main() {
 if (!process.argv.includes("--production-read-only")) throw Error("Explicit production read-only check required");
 try {
  const hits=await searchFulltext("matchbox", "matchbox", null, ["en"]);
  const matching=hits.find(hit=>hit.neutralCitation==="[1900] HKDC 1");
  assert(matching,"Expected production pilot judgment missing from lexical retrieval");
  const document=await getFulltext(matching.judgmentId,matching.startPosition??0,matching.endPosition??1,"both",20);
  assert(document.paragraphs.length>0);
  assert(document.paragraphs.some(paragraph=>/matchbox/i.test(paragraph.content)));
  console.log(JSON.stringify({verifiedAt:new Date().toISOString(),target:"production",lexicalRetrieval:true,paragraphRetrieval:true,judgmentId:matching.judgmentId,providerCalls:0}));
 } finally { await prisma.$disconnect(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
