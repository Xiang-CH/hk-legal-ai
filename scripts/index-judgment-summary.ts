import { PrismaClient } from "../src/prisma/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { TokenTextSplitter } from "@langchain/textsplitters";
// T05 — chunk-only. No embeddings (T06), no Azure Search upload (deleted).
// Reads Judgment summaries from pg, TokenTextSplitter(8000/1000, o200k_base),
// writes scripts/index-output/judgment-summaries.json with embedding=null.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const MAX_CHUNK_SIZE = 8000;
const MAX_CHUNK_OVERLAP = 1000;
const ENCODING_NAME = "o200k_base";

const splitter = new TokenTextSplitter({
    chunkSize: MAX_CHUNK_SIZE,
    chunkOverlap: MAX_CHUNK_OVERLAP,
    encodingName: ENCODING_NAME,
});

type JudgmentSummaryDocument = {
    id: string;
    judgmentId: number;
    chunk_no: number;
    neutralCitation: string;
    courtName: string;
    year: number;
    date: string;
    parties: string | null;
    summary: string;
    summarySource: string | null;
    url: string;
    embedding: number[] | null;
}

function saveDocumentsToFileSystem(documents: JudgmentSummaryDocument[]) {
    const fs = require('fs');
    const path = require('path');
    const outputDir = path.join(__dirname, 'index-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputFile = path.join(outputDir, `judgment-summaries.json`);
    fs.writeFileSync(outputFile, JSON.stringify(documents));
    console.log(`wrote ${documents.length} documents to ${outputFile}`);
}

async function main() {
    const judgments = await prisma.judgment.findMany({
        where: {
            summary: {
                not: null
            }
        },
        select: {
            id: true,
            neutralCitation: true,
            courtName: true,
            year: true,
            date: true,
            parties: true,
            summary: true,
            summarySource: true,
            url: true,
        },
    });

    console.log(`Total number of judgments with summaries: ${judgments.length}`);

    const documents: JudgmentSummaryDocument[] = [];
    for (const judgment of judgments) {
        const summaryChunks = await splitter.splitText(judgment.summary!);
        for (let chunkNo = 0; chunkNo < summaryChunks.length; chunkNo++) {
            documents.push({
                id: `${judgment.id}_${chunkNo}`,
                judgmentId: judgment.id,
                chunk_no: chunkNo,
                neutralCitation: judgment.neutralCitation,
                courtName: judgment.courtName,
                year: judgment.year,
                date: judgment.date.toISOString(),
                parties: judgment.parties,
                summary: summaryChunks[chunkNo],
                summarySource: judgment.summarySource,
                url: judgment.url,
                embedding: null
            });
        }
    }

    console.log(`Total number of chunks: ${documents.length}`);

    saveDocumentsToFileSystem(documents);
}

main()
    .then((res) => {
        console.log(res);
    })
    .catch((err) => {
        console.error(err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
