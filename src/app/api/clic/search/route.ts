import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { PrismaClient } from "@/prisma/client";

const FILTERSTR = "search.in(topic, '{}' , '|')"

const prisma = new PrismaClient();

const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT || "",
    process.env.CLIC_INDEX_NAME || "",
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY || "")
);

export async function POST(request: Request) {
    try {
        const body = await request.json();
        if (!body || !body.query) {
            return new Response("Invalid request body, must be json with a 'query' property.", { status: 400 });
        } else if (body.query.trim() === "") {
            return new Response("Query must be non-empty", { status: 401 });
        } else if (body.language && !["en", "sc", "tc"].includes(body.language)) {
            return new Response("Language must be one of 'en', 'sc', or 'tc'", { status: 401 });
        }

        const languageCode = body.language_code || "en";
        if (["sc", "tc"].includes(languageCode)) {
            return new Response("Chinese language support is not yet implemented", { status: 501 });
        }

        const filter = body.filter? FILTERSTR.replace("{}", body.filter.join("|")) : undefined;
        const searchResults = await searchClient.search(
            body.query,
            {
                filter: filter,
                top: body.top ?? 10,
                skip: body.skip ?? 0,
                queryType: "semantic",
                searchMode: "all",
                select: ["nid", "title", "content", "url", "topic"],
                semanticSearchOptions: {
                    configurationName: "clic-semantic-config",
                    captions:{
                        captionType: "extractive"
                    },
                },
                vectorSearchOptions: {
                    queries: [
                        {
                            kind: "text",
                            text: body.query,
                            fields: ["embedding"],
                        }
                    ],
                },
            }
        );

        const results = [];
        for await (const result of searchResults.results) {
            console.log(result);
            const document = result.document as {
                nid: number;
                title: string;
                content: string;
                url: string;
                topic: string;
            };
            results.push({
                ...document,
                score: result.score,
                rerankerScore: result.rerankerScore,
                caption: result.captions?.[0]?.text || "",
                captionHighlights: result.captions?.[0]?.highlights || ""
            });
        }
        const nids = results.map((r) => r.nid);
        const clicPages = await prisma.clicPage.findMany({
            where: {
                nid: { in: nids },
                languageCode: languageCode,
            },
            include: {
                referencingPages: true,
                referencingLegislationSections: true,
                referencingLegislationCaps: true,
            },
        });

        return Response.json({
            results: results,
            clicPages: clicPages,
        });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify(error));
    }
}