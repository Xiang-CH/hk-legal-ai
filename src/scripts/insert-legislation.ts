import { PrismaClient } from "../prisma/client/index.js";
import fs from 'fs';
import path from 'path';
const prisma = new PrismaClient();


/* Example JSON file structure:
{
    "cap_no": "112",
    "cap_type": "ord",
    "identifier": "/hk/cap112",
    "language": "en",
    "total_token_count": 593092,
    "interpretations": [
        {
        "term": "active partner",
        "text": "active partner (積極參與的合夥人), in relation to a partnership, means a partner who takes an active part in the control, management, or conduct of the trade or business of such partnership;",
        "ref_tags": []
        },
        ...
    ],
    "sections": [{
        "no": "3",
        "name": "s3",
        "heading": "Establishment of Board of Inland Revenue. Power of Chief Executive to appoint a Commissioner and other officers",
        "text": "## 3. Establishment of Board of Inland Revenue. ...",
        "subsections": [
            {
                "name": "1",
                "text": "### (1)\n\t(a) There shall be a Board of Inland Revenue ...",
                "token_count": 224,
                "ref_tags": ["<ref>section 68(5)</ref>", ...],
                "references": [
                    {
                    "type": "subsection",
                    "cap": "112",
                    "section": "68",
                    "subsection": "5"
                    },
                    ...
                ]
            },
            ...
        ],
        "token_count": 347,
        "url": "https://hklii.hk/en/legis/ord/112/s3",
        "eleg_url": "https://www.elegislation.gov.hk/hk/cap112?xpid=ID_1438402578988_001",
        "interp_terms": [
            "assessor",
            "assistant commissioner",
            ...
        ],
        "ref_tags": ["<ref>section 68(5)</ref>", ...],
        "references": [
            {
                "type": "subsection",
                "cap": "112",
                "section": "68",
                "subsection": "5"
            },
            ...
        ]
        },
        ...
    ],
    "schedules": [
        {
            "name": "sch1",
            "heading": "Interpretation and General Provisions",
            "text": "Schedule 1 ...",
            "url": "https://hklii.hk/en/legis/ord/571/sch1",
            "eleg_url": "https://www.elegislation.gov.hk/hk/cap571?xpid=ID_1438403472945_001",
            "token_count": 30041,
            "sections": [
                {
                    "name": "sch1_P1_s1",
                    "heading": "Interpretation of this Ordinance",
                    "text": "## 1. Interpretation of this Ordinance ...",
                    "subsections": [],
                    "token_count": 15325,
                    "url": "https://hklii.hk/en/legis/ord/571/sch1_P1_s1",
                    "eleg_url": "https://www.elegislation.gov.hk/hk/cap571?xpid=ID_1438413460031_060",
                    "interp_terms": [
                        "controller",
                        ...
                    ],
                    "ref_tags": ["<ref>section 122</ref>", ...],
                    "references": []   
                }
            ]
        }
    ]
}

*/

const DATA_DIR_PATH = "/Users/cxiang/Downloads/en";
const LANGUAGE_CODE = "en";


async function insertLegislation() {
    const files = fs.readdirSync(DATA_DIR_PATH)
        .filter(file => file.endsWith('.json'));

    
    let capAdded = 0;
    let capSkipped = 0;
    let capSectionAdded = 0;
    let capSectionSkipped = 0;

    for (const file of files) {
        const filePath = path.join(DATA_DIR_PATH, file);
        const data = require(filePath);

        try {
            // Check if the legislation already exists
            const existingCap = await prisma.legislationCap.findUnique({
                where: {
                    capNumber: data.cap_no,
                },
            });
            if (existingCap) {
                console.log(`Legislation ${data.cap_no} already exists, skipping`);
                capSkipped += 1;
            } else {
                await prisma.legislationCap.create({
                    data: {
                        capNumber: data.cap_no,
                        title: data.title,
                        longTitle: data.long_title,
                        languageCode: data.language,
                        url: data.url,
                        eLegislationUrl: data.eleg_url
                    },
                });
                capAdded += 1;
            }

            // Insert interpretations
            if (data.interpretations && data.interpretations.length > 0) {
                // Remove duplicate terms based on term name
                const uniqueInterpretations = data.interpretations.filter((interpretation: any, index: number, self: any[]) =>
                    index === self.findIndex((i: any) => i.term === interpretation.term)
                );

                const interpretations = uniqueInterpretations.map((interpretation: any) => ({
                    id: `${data.cap_no}/${interpretation.term}`,
                    term: interpretation.term,
                    termDefinition: interpretation.text,
                    languageCode: data.language,
                    capNumber: data.cap_no,
                }));

                // Check if interpretations already exist
                const existingInterpretations = await prisma.interpretation.findMany({
                    where: {
                        id: {
                            in: interpretations.map((interpretation: any) => interpretation.id),
                        },
                    },
                });
                const existingIds = existingInterpretations.map((interpretation) => interpretation.id);
                const newInterpretations = interpretations.filter((interpretation: any) => !existingIds.includes(interpretation.id));

                await prisma.interpretation.createMany({
                    data: newInterpretations,
                });
            }
            
            // Insert sections
            if (data.sections && data.sections.length > 0) {
                const subsections = data.sections.flatMap((section: any) =>
                    section.subsections.map((subsection: any) => ({
                        id: `${data.cap_no}/${section.name}/${subsection.name}`,
                        capNumber: data.cap_no,
                        sectionHeading: section.heading,
                        sectionNumber: section.no? section.no : section.name.replace('s', ''),
                        subsectionNumber: subsection.name,
                        content: subsection.text,
                        languageCode: data.language,
                        url: section.url,
                        eLegislationUrl: section.eleg_url,
                    }))
                );

                const sections = data.sections.map((section: any) => ({
                    id: `${data.cap_no}/${section.name}`,
                    capNumber: data.cap_no,
                    sectionHeading: section.heading,
                    sectionNumber: section.no? section.no : section.name.replace('s', ''),
                    content: section.text,
                    languageCode: data.language,
                    url: section.url,
                    eLegislationUrl: section.eleg_url,
                }));

                const allSections = [...sections, ...subsections];

                // Check if sections already exist
                const existingSections = await prisma.legislationSection.findMany({
                    where: {
                        id: {
                            in: allSections.map((sec) => sec.id),
                        },
                    },
                });
                const existingSectionIds = existingSections.map((sec) => sec.id);
                const newSections = allSections.filter((sec) => !existingSectionIds.includes(sec.id)).filter((sec) => sec.content && sec.content.trim() !== '');

                if (newSections.length === 0) {
                    console.log(`All sections for ${data.cap_no} already exist, skipping section insertion`);
                    capSectionSkipped += sections.length;
                } else {
                    console.log(`Inserting ${newSections.length} new sections for ${data.cap_no}`);
                }

                await prisma.legislationSection.createMany({
                    data: newSections,
                });

                capSectionAdded += newSections.length;
                capSectionSkipped += existingSectionIds.length;
            }


            // Insert schedules
            if (data.schedules && data.schedules.length > 0) {
                const sch_sections = data.schedules.flatMap((schedule: any) =>
                    schedule.sections.map((section: any) => ({
                        id: `${data.cap_no}/${schedule.name}/${section.name.split('_', 2)[1]}`,
                        capNumber: data.cap_no,
                        sectionHeading: schedule.heading,
                        sectionNumber: schedule.no,
                        subsectionNumber: section.name,
                        content: section.text,
                        languageCode: data.language,
                        url: schedule.url,
                        eLegislationUrl: section.eleg_url,
                    }))
                );

                const schedules = data.schedules.map((schedule: any) => ({
                    id: `${data.cap_no}/${schedule.name}`,
                    capNumber: data.cap_no,
                    sectionHeading: schedule.heading,
                    sectionNumber: schedule.name,
                    content: schedule.text,
                    languageCode: data.language,
                    url: schedule.url,
                    eLegislationUrl: schedule.eleg_url,
                }));

                const allSchedules = [...schedules, ...sch_sections];
                // Check if schedules already exist
                const existingSchedules = await prisma.legislationSection.findMany({
                    where: {
                        id: {
                            in: allSchedules.map((sch) => sch.id),
                        },
                    },
                });
                const existingScheduleIds = existingSchedules.map((sch) => sch.id); 
                const newSchedules = allSchedules.filter((sch) => !existingScheduleIds.includes(sch.id));

                await prisma.legislationSection.createMany({
                    data: newSchedules,
                });

                capSectionAdded += newSchedules.length;
                capSectionSkipped += existingScheduleIds.length;
            }

        } catch (error) {
            console.error(`Error inserting legislation item from file ${file}:`, error);
        }
        // break;
    }
    return `Inserted ${capAdded} legislation caps, skipped ${capSkipped} caps, inserted ${capSectionAdded} sections, skipped ${capSectionSkipped} sections.`;
}

insertLegislation() 
    .then((res) => {
        console.log(res);
    })
    .catch((err) => {
        console.error(err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
