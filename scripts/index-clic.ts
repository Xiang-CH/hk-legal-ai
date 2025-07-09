import { PrismaClient } from "../src/prisma/client/index.js";
import { AzureKeyCredential, SearchClient } from "@azure/search-documents";
import { TokenTextSplitter } from "@langchain/textsplitters";
import OpenAI from "openai";
const prisma = new PrismaClient();

const LANGUAGE_CODE = "en";
const MAX_CHUNK_SIZE = 512;
const MAX_CHUNK_OVERLAP = 128;
const ENCODING_NAME = "o200k_base";
const EMBEDDING_BATCH_SIZE = 100;

const splitter = new TokenTextSplitter({
    chunkSize: MAX_CHUNK_SIZE,
    chunkOverlap: MAX_CHUNK_OVERLAP,
    encodingName: ENCODING_NAME,
});
const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT || "",
    process.env.CLIC_INDEX_NAME || "",
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY || "")
);
const embeddingClient = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_KEY || undefined,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT + "/openai/v1/" || undefined,
    defaultQuery: {
        "api-version": "preview"
    }
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

async function getEmbeddings(texts: string[]) {
    const embeddings = await embeddingClient.embeddings.create({
        model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-large",
        input: texts,
    });
    return embeddings.data.map((embedding) => embedding.embedding);
}

async function getEmbeddingsByBatch(texts: string[]) {
    const embeddings = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
        console.log(`Embedding batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1} of ${Math.ceil(texts.length / EMBEDDING_BATCH_SIZE)}`);
        const batchEmbeddings = await embeddingClient.embeddings.create({
            model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-large",
            input: batch,   
        });
        embeddings.push(...batchEmbeddings.data.map((embedding) => embedding.embedding));
    }
    return embeddings;
}

function saveChunksToFileSystem(chunks: Chunk[]) {
    const fs = require('fs');
    const path = require('path');
    const outputDir = path.join(__dirname, 'index-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    const outputFile = path.join(outputDir, `chunks-${LANGUAGE_CODE}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(chunks, null, 2));
}

async function uploadIndexByBatch(chunks: Chunk[]) {
    // Index chunks
    const batch = [];
    for (const chunk of chunks) {
        batch.push(chunk);
        if (batch.length === 1000) {
            console.log(`Indexing batch of ${batch.length} chunks`);
            const res = await searchClient.mergeOrUploadDocuments(batch);
            const failed = res.results.filter(result => !result.succeeded);
            if (failed.length > 0) {
                console.log(`Failed to index ${failed.length} chunks:`, failed);
            } else {
                console.log(`Successfully indexed ${batch.length} chunks`); 
            }
            batch.length = 0; // Reset batch
        }
    }
    if (batch.length > 0) {
        await searchClient.mergeOrUploadDocuments(batch);
        console.log(`Indexed ${batch.length} chunks`);
    }
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
        for (const textChunk of textChunks) {
            chunks.push({
                id: page.nid + "_" + textChunks.indexOf(textChunk),
                nid: page.nid,
                chunk_no: textChunks.indexOf(textChunk),
                title: page.title,
                content: textChunk,         
                topic: page.topic,
                url: page.url,
                context: page.contextualInformation,
                embedding: null
            });
        }
    }

    console.log(`Total number of pages: ${pages.length}`);
    console.log(`Total number of chunks: ${chunks.length}`);

    // Get embeddings for all chunks
    const texts = chunks.map(chunk => chunk.content);
    const embeddings = await getEmbeddingsByBatch(texts);
    for (let i = 0; i < chunks.length; i++) {
        chunks[i].embedding = embeddings[i];
    }

    // save chunks to the file system
    saveChunksToFileSystem(chunks)

    // Index chunks
    // await uploadIndexByBatch(chunks);   
}

async function indexFromFile() {
    const fs = require('fs');
    const path = require('path');
    const inputDir = path.join(__dirname, 'index-output');
    const inputFile = path.join(inputDir, `chunks-${LANGUAGE_CODE}.json`);
    const chunks = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    await uploadIndexByBatch(chunks);
}

indexFromFile()
    .then((res) => {
        console.log(res);
    })
    .catch((err) => {
        console.error(err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
