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

async function findJudgmentWithoutCase() {
    const judgments = await prisma.judgment.findMany({
        where: {
            cases: {
                none: {}
            }
        }
    });
    console.log(`Number of judgments without case: ${judgments.length}`);

    for (const judgment of judgments) {
        const result = await prisma.case.findMany({
            where: {
                judgments: {
                    some: {
                        id: judgment.id
                    }
                }
            }
        });

        if (result.length == 0) {
            console.log(`- Judgment ID: ${judgment.id}`);
        }
    }
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


const TEXTBOOK_DATA_PATH = "/Users/cxiang/Projects/hk-legislation-parsing/judgement/data/table_of_cases.json"
async function updateTextBookJudgments() {
    const data = fs.readFileSync(TEXTBOOK_DATA_PATH, 'utf-8');
    const rows = JSON.parse(data);
    console.log(rows)
    for (const row of rows) {
        for (const item of row) {
            if (item.includes("/")){ // is caseAct
                const result = await prisma.case.findUnique({
                    where: {
                        caseAct: item
                    },
                    include: {
                        judgments: true
                    }
                });

                if (result && result.judgments && result.judgments.length > 0) {
                    await prisma.judgment.updateMany({
                        where: {
                            id: {
                                in: result.judgments.map(r => r.id)
                            }
                        },
                        data: {
                            inTextbook: true
                        }
                    });
                    console.log(`Updated ${result.judgments.length} judgments for case ${item}`);
                    break
                }
            } else { // neutral citation or parallel citation
                const neutralCitation = item;
                const parallelCitation = item;

                const result = await prisma.judgment.updateMany({
                    where: {
                        neutralCitation: neutralCitation
                    },
                    data: {
                        inTextbook: true
                    }
                });

                if (result && result.count > 0) {
                    console.log(`Updated ${result.count} judgments for neutral citation ${neutralCitation}`);
                    break;
                }

                const result2 = await prisma.judgment.updateMany({
                    where: {
                        parallelCitations: {
                            some: {
                                citation: parallelCitation
                            }
                        }
                    },
                    data: {
                        inTextbook: true
                    }
                });

                if (result2 && result2.count > 0) {
                    console.log(`Updated ${result2.count} judgments for parallel citation ${parallelCitation}`);
                    break;
                }

            }
        }
    }
}

const JUDGMENT_SUMMARY_RECORDS_PATH = "/Users/cxiang/Downloads/case-summary-records-0110.jsonl"

async function insertJudgmentSummary() {
    const data = fs.readFileSync(JUDGMENT_SUMMARY_RECORDS_PATH, 'utf-8');
    const lines = data.trim().split('\n');
    
    let updatedCount = 0;
    let notFoundCount = 0;
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        const record = JSON.parse(line) as { citation: string; summary: string };
        
        const result = await prisma.judgment.updateMany({
            where: {
                neutralCitation: record.citation
            },
            data: {
                summary: record.summary,
                summarySource: "GENERATED"
            }
        });
        
        if (result.count > 0) {
            updatedCount += result.count;
            console.log(`Updated judgment for citation: ${record.citation}`);
        } else {
            notFoundCount++;
            console.log(`Judgment not found for citation: ${record.citation}`);
        }
    }
    
    console.log(`\nSummary: Updated ${updatedCount} judgments, ${notFoundCount} not found.`);
}

// insertJudgmentMeta();
// insertParallelCitations();
// insertCases();
// findJudgmentWithoutCase();
// updateTextBookJudgments()
insertJudgmentSummary()
