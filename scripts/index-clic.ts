import { PrismaClient } from "../src/prisma/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { TokenTextSplitter } from "@langchain/textsplitters";
// T05 — chunk-only. No embeddings (T06), no Azure Search upload (deleted).
// Reads ClicPage from pg, TokenTextSplitter(512/128, o200k_base), writes
// scripts/index-output/chunks-{lang}.json with embedding=null (T06 fills it).
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const arg = (k: string, d: string) => {
    const m = process.argv.find((a) => a.startsWith(k + "="));
    return m ? m.slice(k.length + 1) : d;
};
const LANGUAGE_CODE = arg("--lang", "en");
const MAX_CHUNK_SIZE = 512;
const MAX_CHUNK_OVERLAP = 128;
const ENCODING_NAME = "o200k_base";

const splitter = new TokenTextSplitter({
    chunkSize: MAX_CHUNK_SIZE,
    chunkOverlap: MAX_CHUNK_OVERLAP,
    encodingName: ENCODING_NAME,
});

type Chunk = {
    id: string;
    nid: number;
    chunk_no: number;
    title: string | null;
    content: string;
    topic: string;
    url: string;
    context: string;
    embedding: number[] | null;
}

function saveChunksToFileSystem(chunks: Chunk[]) {
    const fs = require('fs');
    const path = require('path');
    const outputDir = path.join(__dirname, 'index-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputFile = path.join(outputDir, `chunks-${LANGUAGE_CODE}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(chunks));
    console.log(`wrote ${chunks.length} chunks to ${outputFile}`);
}

async function main() {
    const pages = await prisma.clicPage.findMany({
        where: {
            languageCode: LANGUAGE_CODE,
        },
        select: {
            id: true,
            nid: true,
            title: true,
            content: true,
            topic: true,
            url: true,
            path: true,
            contextualInformation: true,
        },
    });
    const chunks : Chunk[] = [];
    for (const page of pages) {
        const textChunks = await splitter.splitText(page.content);
        for (let i = 0; i < textChunks.length; i++) {
            chunks.push({
                id: page.nid + "_" + i,
                nid: page.nid,
                chunk_no: i,
                title: page.title,
                content: textChunks[i],
                topic: page.topic,
                url: page.url,
                context: page.contextualInformation,
                embedding: null
            });
        }
    }

    console.log(`Total number of pages: ${pages.length}`);
    console.log(`Total number of chunks: ${chunks.length}`);

    saveChunksToFileSystem(chunks)
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
