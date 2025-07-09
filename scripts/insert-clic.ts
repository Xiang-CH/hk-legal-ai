import { captureOwnerStack } from "react";
import { PrismaClient } from "../src/prisma/client/index.js";
const prisma = new PrismaClient();

const DATA_PATH =
    "/Users/cxiang/Projects/clic-search/scripts/data/CLIC_content_cleaned.json";
const LANGUAGE_CODE = "en";

/*. example json file
[
  {
    "nid":8,
    "type":null,
    "is_complete":true,
    "title":"Criminal liability and types of penalties",
    "path":"\/topics\/PoliceAndCriminalProcedure\/criminal_liability_and_penalties",
	"url":"https:\/\/clic.org.hk\/en\/topics\/PoliceAndCriminalProcedure\/criminal_liability_and_penalties",
    "topic_value":"Police & Criminal Procedure",
    "content":"<h2>.... <\/p>",
    "is_noisy":false,
    "topic_key":"PoliceAndCriminalProcedure",
    "is_question":false,
    "context":"Police & Criminal Procedure",
    "parsed_content":"Criminal liability is ....",
    "cases_ref":[
      {
        "court":"hkcfa",
        "year":"2005",
        "no":"24"
      }
    ],
    "legislation_ref":[
      {
        "type":"ord",
        "no":"358",
        "section":"s8"
      },
      {
        "type":"reg",
        "no":"358A",
        "section":"s10"
      },
      {
        "type":"instrument",
        "no":"A101",
        "section":""
      }
    ],
    "clic_ref":[
      {
        "nid":959,
        "path":"\/topics\/policeAndCrime\/case_illustration"
      }
    ],
    "n_tokens":559
  },
  ...
]
*/

async function findById(id: number) {
    const res = await prisma.clicPage.findFirst({
        where: {
            id: id,
        },
        include: {
            referencingPages: true,
            referencingLegislationSections: true,
            referencingLegislationCaps: true,
        },
    });
    return res;
}

async function insertClicPages() {
    const data = require(DATA_PATH);
    console.log(`Total number of items: ${data.length}`);

    const existingIds = await prisma.clicPage.findMany({
        select: {
            id: true,
            nid: true,
        },
        where: {
            languageCode: LANGUAGE_CODE,
        },
    });
    const existingIdSet = new Set(existingIds.map((item: any) => item.nid));
    console.log(`Number of existing items: ${existingIdSet.size}`);

    // Filter out noisy items and map to the required format
    const clicPages = data
        .filter((item: any) => !item.is_noisy && !existingIdSet.has(item.nid))
        .map((item: any) => ({
            nid: item.nid,
            title: item.title,
            path: item.path,
            url: item.url,
            content: item.parsed_content,
            contextualInformation: item.context,
            topic: item.topic_key,
            languageCode: LANGUAGE_CODE,
        }));

    try {
        const result = await prisma.clicPage.createMany({
            data: clicPages,
        });

        return `Added ${result.count} clic pages`;
    } catch (error) {
        console.error("Error inserting pages:", error);
        return `Failed to insert pages: ${error}`;
    }
}

async function insertClicPageRelations() {
    const data = require(DATA_PATH);
    let updatedCount = 0;
    let skippedCount = 0;
    let missingIds: number[] = [];

    for (const page in data) {
        const currentPage = data[page].nid;
        const references = data[page].clic_ref.filter((ref: any) => ref.nid); // Ensure references have nid;

        if (references.length === 0) continue;
        try {
            const existingPage = await findById(currentPage);
            if (existingPage?.referencingPages.length == references.length) {
                console.log(`Page ${currentPage} already has all references`);
                continue;
            }

            // Check which references exist in the database
            const referenceIds: number[] = references.map(
                (ref: any) => ref.nid
            );
            const existingReferences = await prisma.clicPage.findMany({
                where: {
                    AND: [
                        { nid: { in: referenceIds } },
                        { languageCode: LANGUAGE_CODE },
                    ],
                },
                select: {
                    id: true,
                    nid: true,
                },
            });

            const existingIds = existingReferences.map((ref) => ref.nid);
            const missingIds = referenceIds.filter(
                (nid: number) => !existingIds.includes(nid)
            );

            if (missingIds.length > 0) {
                console.log(
                    `Page ${currentPage}: Missing reference pages with IDs: ${missingIds.join(
                        ", "
                    )}`
                );
                console.log(
                    `Found ${existingIds.length} out of ${referenceIds.length} references`
                );
                missingIds.push(...missingIds);

                // Only connect existing references
                if (existingIds.length === 0) {
                    console.log(
                        `No valid references found for page ${currentPage}, skipping`
                    );
                    skippedCount += 1;
                    continue;
                }
            }

            await prisma.clicPage.update({
                where: {
                    nid_languageCode: {
                        nid: currentPage,
                        languageCode: LANGUAGE_CODE,
                    },
                },
                data: {
                    referencingPages: {
                        connect: existingIds.map((nid: number) => ({
                            nid_languageCode: {
                                nid: nid,
                                languageCode: LANGUAGE_CODE,
                            },
                        })),
                    },
                },
            });
            updatedCount += 1;
        } catch (error) {
            console.error(
                `Error inserting page relations for page ${currentPage}:`,
                error
            );
            skippedCount += 1;
        }
    }
    return `Updated ${updatedCount} pages, skipped ${skippedCount} pages \nMissing IDs: ${
        missingIds.length > 0 ? missingIds.join(", ") : "None"
    }`;
}

async function insertClicLegislationRelations() {
    const data = require(DATA_PATH);
    let updatedCount = 0;
    let skippedCount = 0;
    for (const page in data) {
        const currentPage = data[page].nid;
        const legislationRefs = data[page].legislation_ref.filter(
            (ref: any) => ref.type && ref.no
        ); // Ensure references have type and no

        if (legislationRefs.length === 0) continue;

        try {
            const existingPage = await findById(currentPage);

            // Check which references exist in the database
            const referenceIds = legislationRefs.map((ref: any) => ({
                capNumber: ref.no,
                sectionNumber: ref.section || null,
                languageCode: LANGUAGE_CODE,
            }));
            const existingSectionReferences = existingPage
                ? existingPage.referencingLegislationSections.map((ref) => {
                      return {
                          capNumber: ref.capNumber,
                          sectionNumber: ref.sectionNumber,
                          languageCode: ref.languageCode,
                      };
                  })
                : [];
            const existingCapReferences = existingPage
                ? existingPage.referencingLegislationCaps.map((ref) => {
                      return {
                          capNumber: ref.capNumber,
                          languageCode: ref.languageCode,
                      };
                  })
                : [];

            const missingSectionRefs = referenceIds.filter((ref: any) => {
                return !existingSectionReferences.some(
                    (existingRef) =>
                        existingRef.capNumber === ref.capNumber &&
                        existingRef.sectionNumber === ref.sectionNumber &&
                        existingRef.languageCode === ref.languageCode
                );
            }).filter(((ref: any) => ref.sectionNumber !== null));
            const missingCapRefs = referenceIds.filter((ref: any) => {
                return !existingCapReferences.some(
                    (existingRef) =>
                        existingRef.capNumber === ref.capNumber &&
                        existingRef.languageCode === ref.languageCode
                );
            }).filter(((ref: any) => ref.sectionNumber === null));

            if (missingSectionRefs.length + missingCapRefs.length > 0) {
                console.log(
                    `Page ${currentPage}: Missing legislation references`
                );
                console.log(
                    `Found ${existingSectionReferences.length} section references and ${existingCapReferences.length} cap references, ${missingCapRefs.length} cap references and ${missingSectionRefs.length} section references will be added`
                );

                if (
                    missingSectionRefs.length === 0 &&
                    missingCapRefs.length === 0
                ) {
                    console.log(
                        `No valid references found for page ${currentPage}, skipping`
                    );
                    skippedCount += 1;
                    continue;
                }
            }

            interface ILegislationRef {
                capNumber: string;
                sectionNumber: string | null;
                languageCode: string;
            }

            const missingCapRefsIds = await prisma.legislationCap.findMany({
                where: {
                    capNumber: {
						in: missingCapRefs.map((ref: ILegislationRef) => ref.capNumber),
					},
                    languageCode: LANGUAGE_CODE,
                },
                select: {
                    id: true,
                },
            });

            const missingSectionRefsIds =
                await prisma.legislationSection.findMany({
                    where: {
                        capNumber: {
							in: missingSectionRefs.map(
								(ref: ILegislationRef) => ref.capNumber
							),
						},
						sectionNumber: missingSectionRefs.filter((ref: ILegislationRef) => ref.sectionNumber).length > 0 ? {
							in: missingSectionRefs.map(
								(ref: ILegislationRef) => ref.sectionNumber
							),
						} : undefined,
                        languageCode: LANGUAGE_CODE,
                    },
                    select: {
                        id: true,
                    },
                });

            await prisma.clicPage.update({
                where: {
                    nid_languageCode: {
                        nid: currentPage,
                        languageCode: LANGUAGE_CODE,
                    },
                },
                data: {
                    referencingLegislationSections: {
                        connect: missingSectionRefsIds.map((ref: any) => ({
                            id: ref.id,
                        })),
                    },
                    referencingLegislationCaps: {
                        connect: missingCapRefsIds.map((ref: any) => ({
                            id: ref.id,
                        })),
                    },
                },
            });

            updatedCount += 1;
        } catch (error: unknown) {
            console.error(
                `Error inserting legislation relations for page ${currentPage}:`,
                error
            );
            skippedCount += 1;
        }
    }
    return `Updated ${updatedCount} pages, skipped ${skippedCount} pages`;
}

async function deleteAllClicPages(): Promise<string> {
    try {
        // First, clear all self-referential relationships by using raw SQL
        // This removes all entries from the junction table
        await prisma.$executeRaw`DELETE FROM _ClicPageRelationToClicPage`;

        // Now we can safely delete all ClicPage records
        const result = await prisma.clicPage.deleteMany({});
        return `Deleted ${result.count} clic pages`;
    } catch (error) {
        console.error("Error deleting clic pages:", error);
        return `Failed to delete clic pages: ${error}`;
    }
}

insertClicLegislationRelations()
    .then((res) => {
        console.log(res);
    })
    .catch((err) => {
        console.error(err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
