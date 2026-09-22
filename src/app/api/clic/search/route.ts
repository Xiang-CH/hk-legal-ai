import { prisma } from "@/lib/prisma";
import { getEmbeddings, searchClic } from "@/app/api/chat/helper";

/* T10: pg fusion replaces Azure AI Search. Same {results, clicPages} contract;
 * `score` carries rrf_score, `caption` carries the ts_headline snippet.
 * per plan.md §7: pg layer drops rerankerScore/captionHighlights (reranker
 * adds its own score in the chat flow). languageCode sc/tc now served via
 * language lanes (old 501 removed). Fusion returns top-30; top/skip slice it. */
const FUSION_CAP = 30;

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

        const languageCode = body.language_code || body.language || "en";
        if (!["en", "sc", "tc"].includes(languageCode)) {
            return new Response("Language must be one of 'en', 'sc', or 'tc'", { status: 401 });
        }

        const top = Math.min(body.top ?? 10, FUSION_CAP);
        const skip = body.skip ?? 0;
        // Old `filter` was a topic list for search.in(); now topic = ANY($) passthrough.
        const topics = Array.isArray(body.filter) ? body.filter : undefined;

        const embedding = await getEmbeddings(body.query);
        const hits = [];
        for await (const result of searchClic(body.query, {
            embedding,
            languageCodes: [languageCode],
            topics,
        })) {
            hits.push(result);
        }

        const results = hits.slice(skip, skip + top).map((h) => ({
            nid: h.nid,
            title: h.title,
            content: h.content,
            url: h.url,
            topic: h.topic,
            chunk_no: h.chunk_no,
            score: h.score,
            caption: h.caption,
            rrf_score: h.rrf_score,
            snippet: h.snippet,
        }));

        const nids = [...new Set(results.map((r) => r.nid))];
        const clicPages = nids.length ? await prisma.clicPage.findMany({
            where: {
                nid: { in: nids },
                languageCode: languageCode,
            },
            include: {
                referencingPages: true,
                referencingLegislationSections: true,
                referencingLegislationCaps: true,
            },
        }) : [];

        return Response.json({
            results: results,
            clicPages: clicPages,
        });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify(error));
    }
}
