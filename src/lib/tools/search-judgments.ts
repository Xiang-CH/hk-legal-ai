import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchJudgmentChunks, type JudgmentChunkHit } from "@/lib/pg-search";
import { getEmbeddings } from "@/app/api/chat/helper";
import {
	TOOL_TIMEOUT_MS,
	RERANK_TOP_JUDGMENT,
	withTimeout,
	withToolSpan,
	withSearchFallback,
	fuseRerank,
	dedupe,
	errorPayloadSchema,
	fallbackSearchTerms,
	fallbackPrimaryTerm,
} from "./shared";

const searchJudgmentsInput = z.object({
	query: z.string().min(1).describe("Natural-language question or fact pattern to match judgments."),
	languageCode: z.string().optional().describe("Lane override: 'en' (default) or 'sc'/'tc'."),
});
type SearchJudgmentsInput = z.infer<typeof searchJudgmentsInput>;

export interface JudgmentToolItem {
	judgmentId: number;
	chunk_no: number;
	neutralCitation: string | null;
	courtName: string | null;
	year: number | null;
	caseAct: string | null;
	caseTitle: string | null;
	parties: string | null;
	snippet: string;
	url: string | null;
	rrf_score: number;
	rerank_score: number | null;
}

export const judgmentToolOutputSchema = z.union([
	z.strictObject({
		results: z.array(z.strictObject({
			judgmentId: z.number(),
			chunk_no: z.number(),
			neutralCitation: z.string().nullable(),
			courtName: z.string().nullable(),
			year: z.number().nullable(),
			caseAct: z.string().nullable(),
			caseTitle: z.string().nullable(),
			parties: z.string().nullable(),
			snippet: z.string(),
			url: z.string().nullable(),
			rrf_score: z.number(),
			rerank_score: z.number().nullable(),
		})),
	}),
	errorPayloadSchema,
]);
export type JudgmentToolOutput = z.infer<typeof judgmentToolOutputSchema>;

async function fallbackJudgmentOutput(args: SearchJudgmentsInput): Promise<JudgmentToolOutput> {
	const terms = fallbackSearchTerms(args.query);
	const primaryTerm = fallbackPrimaryTerm(terms);
	const rows = await prisma.judgmentChunk.findMany({
		where: {
			...(args.languageCode ? { languageCode: args.languageCode } : {}),
			...(primaryTerm ? { content: { contains: primaryTerm, mode: "insensitive" } } : {}),
		},
		select: {
			judgmentId: true,
			chunkNo: true,
			neutralCitation: true,
			courtName: true,
			year: true,
			parties: true,
			content: true,
			url: true,
		},
		orderBy: { id: "asc" },
		take: 50,
	});
	const rankedRows = rows
		.map((item) => ({
			item,
			score: terms.reduce(
				(total, term) => total + (item.content.toLowerCase().includes(term) ? 1 : 0),
			0,
			),
		}))
		.sort((left, right) => right.score - left.score)
		.slice(0, RERANK_TOP_JUDGMENT);
	const judgmentIds = rankedRows.map(({ item }) => item.judgmentId);
	const casesByJudgmentId = new Map<number, { caseAct: string; title: string }>();
	if (judgmentIds.length > 0) {
		const judgments = await prisma.judgment.findMany({
			where: { id: { in: judgmentIds } },
			select: {
				id: true,
				cases: { select: { caseAct: true, title: true }, take: 1 },
			},
		});
		for (const judgment of judgments) {
			const caseSummary = judgment.cases[0];
			if (caseSummary) casesByJudgmentId.set(judgment.id, caseSummary);
		}
	}
	return {
		results: rankedRows.map(({ item }) => {
			const caseSummary = casesByJudgmentId.get(item.judgmentId);
			return {
				judgmentId: item.judgmentId,
				chunk_no: item.chunkNo,
				neutralCitation: item.neutralCitation,
				courtName: item.courtName,
				year: item.year,
				caseAct: caseSummary?.caseAct ?? null,
				caseTitle: caseSummary?.title ?? item.parties ?? item.neutralCitation,
				parties: item.parties,
				snippet: item.content.slice(0, 240),
				url: item.url,
				rrf_score: 0,
				rerank_score: null,
			};
		}),
	};
}

/** search_judgments: T08 judgment fusion top-30 -> dedupe -> T09 rerank -> top-8. */
export const searchJudgmentsTool = tool({
	description:
		"Search Hong Kong judgment summaries (Postgres fusion: lexical + vector, RRF). Returns the final top-8 post-rerank chunks with caseAct and caseTitle identifiers for get_case.",
	inputSchema: searchJudgmentsInput,
	outputSchema: judgmentToolOutputSchema,
	execute: async (args: SearchJudgmentsInput): Promise<JudgmentToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_judgments", args, async () => {
					if (!args.query.trim()) return { error: "search_judgments: query must not be empty" };
					return withSearchFallback(async (): Promise<JudgmentToolOutput> => {
						const embedding = await getEmbeddings(args.query);
						const hits = await searchJudgmentChunks(args.query, {
							embedding,
							languageCodes: args.languageCode ? [args.languageCode] : undefined,
						});
						const unique = dedupe(hits, (h: JudgmentChunkHit) => `${h.judgmentId}:${h.chunk_no}`);
						const ranked = await fuseRerank(args.query, unique, (h) => h.content, RERANK_TOP_JUDGMENT);
						const judgmentIds = ranked.map(({ item }) => item.judgmentId);
						const casesByJudgmentId = new Map<number, { caseAct: string; title: string }>();
						if (judgmentIds.length > 0) {
							const judgments = await prisma.judgment.findMany({
								where: { id: { in: judgmentIds } },
								select: {
									id: true,
									cases: { select: { caseAct: true, title: true }, take: 1 },
								},
							});
							for (const judgment of judgments) {
								const caseSummary = judgment.cases[0];
								if (caseSummary) {
									casesByJudgmentId.set(judgment.id, caseSummary);
								}
							}
						}
						return {
							results: ranked.map(({ item, rerank_score }) => {
								const caseSummary = casesByJudgmentId.get(item.judgmentId);
								return {
									judgmentId: item.judgmentId,
									chunk_no: item.chunk_no,
									neutralCitation: item.neutralCitation,
									courtName: item.courtName,
									year: item.year,
									caseAct: caseSummary?.caseAct ?? null,
									caseTitle: caseSummary?.title ?? null,
									parties: item.parties,
									snippet: item.snippet,
									url: item.url,
									rrf_score: item.rrf_score,
									rerank_score,
								};
							}),
						};
					}, () => fallbackJudgmentOutput(args), "search_judgments", (output) => !("results" in output) || output.results.length > 0);
				}),
				TOOL_TIMEOUT_MS,
				"search_judgments",
			);
		} catch (err) {
			return { error: `search_judgments failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});
