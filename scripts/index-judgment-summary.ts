import { PrismaClient } from "../src/prisma/client/index.js";
import { AzureKeyCredential, SearchClient } from "@azure/search-documents";
import { TokenTextSplitter } from "@langchain/textsplitters";
import AzureOpenAI from "openai";
const prisma = new PrismaClient();

const MAX_CHUNK_SIZE = 8000;
const MAX_CHUNK_OVERLAP = 1000;
const ENCODING_NAME = "o200k_base";
const EMBEDDING_BATCH_SIZE = 10;

const splitter = new TokenTextSplitter({
    chunkSize: MAX_CHUNK_SIZE,
    chunkOverlap: MAX_CHUNK_OVERLAP,
    encodingName: ENCODING_NAME,
});

const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT || "",
    process.env.JUDGMENT_SUMMARY_INDEX_NAME || "",
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY || "")
);

const embeddingClient = new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_KEY || undefined,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT + "/openai/v1/" || undefined,
    defaultQuery: {
        "api-version": "preview"
    }
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

function saveDocumentsToFileSystem(documents: JudgmentSummaryDocument[]) {
    const fs = require('fs');
    const path = require('path');
    const outputDir = path.join(__dirname, 'index-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    const outputFile = path.join(outputDir, `judgment-summaries.json`);
    fs.writeFileSync(outputFile, JSON.stringify(documents, null, 2));
}

async function uploadIndexByBatch(documents: JudgmentSummaryDocument[]) {
    const batch = [];
    for (const doc of documents) {
        batch.push(doc);
        if (batch.length === 1000) {
            console.log(`Indexing batch of ${batch.length} documents`);
            const res = await searchClient.mergeOrUploadDocuments(batch);
            const failed = res.results.filter(result => !result.succeeded);
            if (failed.length > 0) {
                console.log(`Failed to index ${failed.length} documents:`, failed);
            } else {
                console.log(`Successfully indexed ${batch.length} documents`); 
            }
            batch.length = 0;
        }
    }
    if (batch.length > 0) {
        const res = await searchClient.mergeOrUploadDocuments(batch);
        const failed = res.results.filter(result => !result.succeeded);
        if (failed.length > 0) {
            console.log(`Failed to index ${failed.length} documents:`, failed);
        } else {
            console.log(`Successfully indexed ${batch.length} documents`);
        }
    }
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

    // Get embeddings for all summary chunks
    const texts = documents.map(doc => doc.summary);
    const embeddings = await getEmbeddingsByBatch(texts);
    for (let i = 0; i < documents.length; i++) {
        documents[i].embedding = embeddings[i];
    }

    // Save documents to the file system
    saveDocumentsToFileSystem(documents);

    // Index documents
    await uploadIndexByBatch(documents);
}

async function indexFromFile() {
    const fs = require('fs');
    const path = require('path');
    const inputDir = path.join(__dirname, 'index-output');
    const inputFile = path.join(inputDir, `judgment-summaries.json`);
    const documents = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    await uploadIndexByBatch(documents);
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
