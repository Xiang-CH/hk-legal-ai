import { PrismaClient, Prisma, type Judgment, type ParallelCitations, type Case } from "../src/prisma/client/index.js";
import fs from 'fs';
const prisma = new PrismaClient();

const META_DATA_PATH = "/Users/cxiang/Projects/hk-legislation-parsing/judgement/data/judgments.json"; 
const CITATION_DATA_PATH = "/Users/cxiang/Projects/hk-legislation-parsing/judgement/data/parallel_citations.json"; 
const CASE_DATA_PATH = "/Users/cxiang/Projects/hk-legislation-parsing/judgement/data/cases.json";

async function insertJudgmentMeta() {
    const data = fs.readFileSync(META_DATA_PATH, 'utf-8');
    const rows = JSON.parse(data);

    const insertData = rows.map((row: any) => {
        return {
            ...row,
            date: new Date(row.date),
        };
    }) as Judgment[];

    await prisma.judgment.createMany({
        data: insertData
    });
}


async function insertParallelCitations() {
    const data = fs.readFileSync(CITATION_DATA_PATH, 'utf-8')
    const row = JSON.parse(data);
    const insertData = row as ParallelCitations;

    await prisma.parallelCitations.createMany({
        data: insertData
    })
}

async function insertCases() {
    const data = fs.readFileSync(CASE_DATA_PATH, 'utf-8')
    const row = JSON.parse(data);
    const insertData = row as (Case & { judgmentIds: number[] })[];


    // Insert cases
    const existingCaseIds = await prisma.case.findMany({
        select: {
            id: true
        }
    });
    const existingCaseIdSet = new Set(existingCaseIds.map(c => c.id));
    const newCases = insertData.filter(c => c.id && !existingCaseIdSet.has(c.id));
    console.log(`Inserting ${newCases.length} new cases...`);
    await prisma.case.createMany({
        data: newCases.map(({ judgmentIds, ...rest }) => rest)
    });

    // Insert case to judgment relationship
    const existingCaseWithoutJudgmentIds = await prisma.case.findMany({
        where: {
            judgments: {
                none: {}
            }
        }
    });
    const existingCaseWithoutJudgmentIdSet = new Set(existingCaseWithoutJudgmentIds.map(c => c.id));
    // Build flat array of [caseId, judgmentId] pairs
    const rels: { caseId: number; judgmentId: number }[] = Array.from(new Set(
        insertData
        .filter(c => c.id && existingCaseWithoutJudgmentIdSet.has(c.id))
        .flatMap(c => (c.judgmentIds || []).map((j: number) => JSON.stringify({ caseId: c.id, judgmentId: j })))
    )).map(str => JSON.parse(str));

    console.log(`Inserting ${rels.length} case-to-judgment relationships...`);

    const maxParams = 2000; // be conservative under 2100
    const colsPerRow = 2; // ("a","b")
    const maxRowsPerBatch = Math.max(1, Math.floor(maxParams / colsPerRow));

    for (let i = 0; i < rels.length; i += maxRowsPerBatch) {
        const batch = rels.slice(i, i + maxRowsPerBatch);

        process.stdout.write(
            `\rProcessing batch ${Math.floor(i / maxRowsPerBatch) + 1} out of ${Math.ceil(rels.length / maxRowsPerBatch)}`
        );

        const prismaValues = Prisma.join(
            batch.map(r => Prisma.sql`(${r.caseId}, ${r.judgmentId})`),
            ', '
        );

        await prisma.$executeRaw`INSERT INTO "_CaseToJudgment" ("a", "b") VALUES ${prismaValues}`;
    }
}

// insertJudgmentMeta();
// insertParallelCitations();
insertCases();