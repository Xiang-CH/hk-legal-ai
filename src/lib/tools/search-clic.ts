import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchClicChunks, type ClicChunkHit } from "@/lib/pg-search";
import { containsCjk } from "@/lib/cjk";
import { getEmbeddings } from "@/lib/clic-api";
import {
	TOOL_TIMEOUT_MS,
	RERANK_TOP_CLIC,
	ALL_CLIC_LANGUAGE_CODES,
	CLIC_TOPIC_ALIASES,
	withTimeout,
	withToolSpan,
	withSearchFallback,
	fuseRerank,
	dedupe,
	errorPayloadSchema,
	fallbackSearchTerms,
} from "./shared";

const searchClicInput = z.object({
	query: z.string().min(1).describe("Natural-language legal question or keywords."),
	topic: z.string().optional().describe("Preferred CLIC topic filter. The search retries across topics if this filter has no matches."),
	languageCode: z.string().optional().describe("Preferred lane: 'en' (default) or 'sc'/'tc' for Chinese. The search retries across available lanes if this lane has no matches."),
});
type SearchClicInput = z.infer<typeof searchClicInput>;

export interface ClicToolItem {
	nid: number;
	chunk_no: number;
	title: string;
	snippet: string;
	url: string;
	rrf_score: number;
	rerank_score: number | null;
}

export const clicToolOutputSchema = z.union([
	z.strictObject({
		results: z.array(z.strictObject({
			nid: z.number(),
			chunk_no: z.number(),
			title: z.string(),
			snippet: z.string(),
			url: z.string(),
			rrf_score: z.number(),
			rerank_score: z.number().nullable(),
		})),
	}),
	errorPayloadSchema,
]);
export type ClicToolOutput = z.infer<typeof clicToolOutputSchema>;

async function searchClicChunksWithFallback(
	query: string,
	embedding: number[],
	args: SearchClicInput,
): Promise<ClicChunkHit[]> {
	const normalizedTopic = args.topic
		? CLIC_TOPIC_ALIASES[args.topic.toLowerCase().replace(/[^a-z]/g, "")] ?? args.topic
		: undefined;
	const broadenLanguage = Boolean(args.languageCode) || containsCjk(query);
	const hits = await searchClicChunks(query, {
		embedding,
		languageCodes: broadenLanguage ? [...ALL_CLIC_LANGUAGE_CODES] : undefined,
	});
	if (!args.topic && !broadenLanguage) return hits;

	// Topic keys and language lanes are sparse in the current corpus. Query all
	// lanes once, then keep the requested lane/topic as a result-order preference.
	const preferenceScore = (hit: ClicChunkHit): number => {
		let score = 0;
		if (args.languageCode && hit.languageCode === args.languageCode) score += 1;
		if (normalizedTopic && hit.topic === normalizedTopic) score += 1;
		return score;
	};
	return hits.sort((left, right) => preferenceScore(right) - preferenceScore(left));
}

function resolveClicTopic(...values: Array<string | undefined>): string | null {
	for (const value of values) {
		if (!value) continue;
		const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
		const alias = CLIC_TOPIC_ALIASES[normalized];
		if (alias) return alias;
	}

	const query = values.filter(Boolean).join(" ").toLowerCase();
	if (/dismiss|employ|遣散|解雇|雇员|僱員/.test(query)) return "employmentDisputes";
	if (/tenant|landlord|tenancy|rental|租客|業主|收樓/.test(query)) return "landlord_tenant";
	if (/consumer|defective|product|消費|產品/.test(query)) return "consumer_complaints";
	if (/defam|libel|slander|誹謗/.test(query)) return "defamation";
	if (/judicial review|procedural fairness|司法覆核|程序公正/.test(query)) return "judicial_review";
	return null;
}

async function fallbackClicOutput(args: SearchClicInput): Promise<ClicToolOutput> {
	const topic = resolveClicTopic(args.topic, args.query);
	const terms = fallbackSearchTerms(args.query);
	// No matchable terms (e.g. Chinese-only or stop-word-only query): return
	// nothing rather than the first arbitrary rows in the table.
	if (terms.length === 0) return { results: [] };
	const rows = await prisma.clicChunk.findMany({
		where: {
			...(topic ? { topic } : {}),
			OR: terms.map((term) => ({ content: { contains: term, mode: "insensitive" } })),
		},
		select: {
			nid: true,
			chunkNo: true,
			title: true,
			content: true,
			url: true,
		},
		orderBy: { id: "asc" },
		take: 50,
	});
	const rankedRows = rows
		.map((item) => {
			const searchable = `${item.title}\n${item.content}`.toLowerCase();
			return {
				item,
				score: terms.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0),
			};
		})
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, RERANK_TOP_CLIC);
	return {
		results: rankedRows.map(({ item }) => ({
			nid: item.nid,
			chunk_no: item.chunkNo,
			title: item.title,
			snippet: item.content.slice(0, 240),
			url: item.url,
			rrf_score: 0,
			rerank_score: null,
		})),
	};
}

/** search_clic: T08 CLIC fusion top-30 -> dedupe -> T09 rerank -> top-10. */
export const searchClicTool = tool({
	description:
		"Search CLIC legal-information articles (Postgres fusion: lexical + vector, RRF). Returns the final top-10 post-rerank chunks with snippets.",
	inputSchema: searchClicInput,
	outputSchema: clicToolOutputSchema,
	execute: async (args: SearchClicInput): Promise<ClicToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_clic", args, async () => {
					if (!args.query.trim()) return { error: "search_clic: query must not be empty" };
					return withSearchFallback(async (): Promise<ClicToolOutput> => {
						const embedding = await getEmbeddings(args.query);
						const hits = await searchClicChunksWithFallback(args.query, embedding, args);
						const unique = dedupe(hits, (h: ClicChunkHit) => `${h.nid}:${h.chunk_no}`);
						const ranked = await fuseRerank(args.query, unique, (h) => h.content, RERANK_TOP_CLIC);
						return {
							results: ranked.map(({ item, rerank_score }) => ({
								nid: item.nid,
								chunk_no: item.chunk_no,
								title: item.title,
								snippet: item.snippet,
								url: item.url,
								rrf_score: item.rrf_score,
								rerank_score,
							})),
						};
					}, () => fallbackClicOutput(args), "search_clic", (output) => !("results" in output) || output.results.length > 0);
				}),
				TOOL_TIMEOUT_MS,
				"search_clic",
			);
		} catch (err) {
			return { error: `search_clic failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});
