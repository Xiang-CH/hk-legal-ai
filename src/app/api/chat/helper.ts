import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { queryExtendPrompt } from "@/lib/prompts";
import { generateObject, ModelMessage, embed } from "ai"
import { z } from 'zod';
import { ClicPage, LegislationSection, JudgmentSummary } from "@/lib/types";
import { prisma } from "@/lib/prisma";
import {
    searchClicChunks,
    searchJudgmentChunks,
    searchLegislationChunks,
    type PgSearchOpts,
} from "@/lib/pg-search";
import { applyRerank } from "@/lib/rerank";

// T09: global top-N after the cross-query merge in route.ts (matches old Azure
// top-10 / top-8 contract). RERANK_ENABLED=false (default) = fusion-order slice.
export const RERANK_TOP_CLIC = 10;
export const RERANK_TOP_JUDGMENT = 8;
const RERANK_TOP_LEGISLATION = 10;


export const azure = createOpenAI({
	apiKey: process.env.AZURE_OPENAI_KEY,
	baseURL: process.env.AZURE_OPENAI_ENDPOINT,
});


export async function rewriteQuery(messages: ModelMessage[]) {
    const QueryExpandFormatSchema = z.object({
        queries: z
            .array(z.string())
            .default([])
            .describe('A list of search queries'),
    });

    const conversation = messages.map((message) => {
        if (typeof message.content === "string") {
            return `${message.role}: ${message.content}`;
        } else {
            return `${message.role}: ${message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ")}`;
        }
    }).join("\n");

    const result = await generateObject({
        model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
        system: queryExtendPrompt,
        prompt: `The conversation history is as follows:\n${conversation}`,
        schema: QueryExpandFormatSchema,
        providerOptions: {
            openai: {
                reasoningEffort: 'low',
            },
        },
        experimental_telemetry: {
            isEnabled: true,
        }
    })
    return result.object.queries;
}

export async function getEmbeddings(text: string) {
    const embeddings = await embed({
        model: azure.textEmbedding(process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-large"),
        value: text,
    })
    return embeddings.embedding;
}


export type PgQueryOpts = PgSearchOpts;

export async function* searchClic(query: string, opts: PgSearchOpts) {
    // T08: pg fusion (lex 15 + vec 15 -> RRF top-30). `score` carries rrf_score and
    // `caption` carries the ts_headline snippet so the route/UI contract is unchanged.
    // T09: fusion-only (top-30). Global rerank happens once per corpus in route.ts
    // AFTER the cross-query merge — reranking here would order per-query hits that
    // then get merged in arrival order (and cost up to 3 calls per turn -> 429s).
    const hits = await searchClicChunks(query, opts);
    for (const h of hits) {
        yield {
            nid: h.nid,
            title: h.title,
            content: h.content,
            url: h.url,
            topic: h.topic,
            chunk_no: h.chunk_no,
            score: h.rrf_score,
            caption: h.snippet,
            lexical_rank: h.lexical_rank,
            vector_distance: h.vector_distance,
            rrf_score: h.rrf_score,
            snippet: h.snippet,
        };
    }
}


export function convertClicResultsToXml(clicResults: ClicPage[]) {
    return "<clicPages>\n" + clicResults.map((r) => {
        return `    <page>
        <url>${r.url}</url>
        <topic>${r.topic}</topic>
        <title>${r.title}</title>
        <content>${r.content}</content>
    </page>`;
    }).join("\n") + "\n</clicPages>";
}

export function convertLegislationResultsToXml(legislationResults: LegislationSection[]) {
    return "<legislationSections>\n" + legislationResults.map((r) => {
        return `    <section>
        <url>${r.url}</url>
        <capNumber>${r.capNumber}</capNumber>
        <capTitle>${r.capTitle}</capTitle>
        <sectionNumber>${r.sectionNumber}</sectionNumber>
        <sectionHeading>${r.sectionHeading}</sectionHeading>
        <content>${r.content}</content>
    </section>`;
    }).join("\n") + "\n</legislationSections>";
}


export async function* searchJudgmentSummary(query: string, opts: PgSearchOpts) {
    // T08: pg fusion over judgment_chunks (same contract notes as searchClic).
    // T09: fusion-only here; global rerank in route.ts (see searchClic note).
    const hits = await searchJudgmentChunks(query, opts);
    for (const h of hits) {
        yield {
            judgmentId: h.judgmentId,
            chunk_no: h.chunk_no,
            neutralCitation: h.neutralCitation ?? "",
            courtName: h.courtName ?? "",
            year: h.year ?? 0,
            date: h.date instanceof Date ? h.date.toISOString() : (h.date ?? ""),
            parties: h.parties,
            summary: h.content,
            summarySource: h.summarySource,
            url: h.url ?? "",
            score: h.rrf_score,
            caption: h.snippet,
            lexical_rank: h.lexical_rank,
            vector_distance: h.vector_distance,
            rrf_score: h.rrf_score,
            snippet: h.snippet,
        };
    }
}

/** T08 Q3: direct legislation chunk search (pg fusion). Not wired into route.ts yet — T10. */
export async function* searchLegislation(query: string, opts: PgSearchOpts) {
    const hits = await searchLegislationChunks(query, opts);
    // Resolve cap titles for the hit set in one query (chunks carry capNumber, not title).
    const capNumbers = [...new Set(hits.map((h) => h.capNumber))];
    const caps = capNumbers.length
        ? await prisma.legislationCap.findMany({
            where: { capNumber: { in: capNumbers } },
            select: { capNumber: true, languageCode: true, title: true },
        })
        : [];
    const titleOf = (capNumber: string, languageCode: string) =>
        caps.find((c) => c.capNumber === capNumber && c.languageCode === languageCode)?.title
        ?? caps.find((c) => c.capNumber === capNumber)?.title
        ?? "";
    // T09: rerank to final top-10 (still unwired in route.ts until T10).
    const ranked = await applyRerank(query, hits, {
        getText: (h) => h.content,
        topN: RERANK_TOP_LEGISLATION,
    });
    for (const { item: h, rerank_score } of ranked) {
        yield {
            capNumber: h.capNumber,
            sectionNumber: h.sectionNumber,
            subsectionNumber: h.subsectionNumber ?? undefined,
            capTitle: titleOf(h.capNumber, h.languageCode),
            sectionHeading: h.heading ?? "",
            content: h.content,
            url: h.url,
            score: h.rrf_score,
            rerankerScore: rerank_score ?? undefined,
            lexical_rank: h.lexical_rank,
            vector_distance: h.vector_distance,
            rrf_score: h.rrf_score,
            rerank_score,
            snippet: h.snippet,
        };
    }
}


export function convertJudgmentResultsToXml(judgmentResults: JudgmentSummary[]) {
    return "<judgmentSummaries>\n" + judgmentResults.map((r) => {
        return `    <judgment>
        <url>${r.url}</url>
        <neutralCitation>${r.neutralCitation}</neutralCitation>
        <courtName>${r.courtName}</courtName>
        <year>${r.year}</year>
        <date>${r.date}</date>
        <parties>${r.parties || ""}</parties>
        <summary>${r.summary}</summary>
    </judgment>`;
    }).join("\n") + "\n</judgmentSummaries>";
}