import { randomUUID } from "node:crypto";
import { sourceFields, judgmentSourceMetadata, fulltextEnabled, searchFulltext } from "@/lib/judgment-fulltext";
import { cjkTokens } from "@/lib/cjk";
import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchJudgmentChunks, resolveLanguageCodes, type JudgmentChunkHit } from "@/lib/pg-search";
import { getEmbeddings } from "@/lib/clic-api";
import type { JudgmentSearchDebugEvent, JudgmentSearchDebugSink } from "@/lib/types";
import {
	TOOL_TIMEOUT_MS,
	PRIMARY_SEARCH_BUDGET_MS,
	SEARCH_FALLBACK_BUDGET_MS,
	ToolTimeoutError,
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
const JUDGMENT_LEXICAL_FALLBACK_MS = 15_000;

function searchErrorDetails(error: unknown) {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
	return {
		reason: error instanceof ToolTimeoutError ? "timeout" : "error",
		timeoutMs: error instanceof ToolTimeoutError ? error.timeoutMs : undefined,
		code: typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined,
		status: typeof status === "number" ? status : undefined,
	};
}

function createJudgmentSearchDebug(onDebug?: JudgmentSearchDebugSink) {
	const searchId = onDebug ? randomUUID() : undefined;
	const started = performance.now();
	const log = (event: string, details: JudgmentSearchDebugEvent["details"] = {}) => {
		if (!searchId) return;
		const entry = { searchId, event, elapsedMs: Math.round(performance.now() - started), details };
		console.log("[judgment-search]", entry);
		onDebug?.(entry);
	};
	const stage = async <T>(name: string, run: () => Promise<T>, summarize?: (value: T) => JudgmentSearchDebugEvent["details"]): Promise<T> => {
		if (!searchId) return run();
		const stageStarted = performance.now();
		log("stage_start", { stage: name });
		try {
			const value = await run();
			log("stage_end", { stage: name, durationMs: Math.round(performance.now() - stageStarted), ...summarize?.(value) });
			return value;
		} catch (error) {
			log("stage_error", { stage: name, durationMs: Math.round(performance.now() - stageStarted), ...searchErrorDetails(error) });
			throw error;
		}
	};
	return { log, stage };
}

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
			...sourceFields,
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

/** Use lexical full text when available, then preserve summary retrieval if full-text storage or the embedding provider is unavailable. */
async function fallbackJudgmentOutput(args: SearchJudgmentsInput, debug: ReturnType<typeof createJudgmentSearchDebug>): Promise<JudgmentToolOutput> {
	if (fulltextEnabled()) {
		const hits = await debug.stage("lexical_fallback", () => withTimeout(
			searchFulltext(args.query, cjkTokens(args.query), null, resolveLanguageCodes(args.query, args.languageCode ? [args.languageCode] : undefined)),
			JUDGMENT_LEXICAL_FALLBACK_MS,
			"judgment lexical fallback",
		), (hits) => ({ hitCount: hits.length })).catch((error: unknown) => {
			console.error("Judgment lexical full-text search failed; preserving summary fallback", searchErrorDetails(error));
			return [];
		});
		if (hits.length) return { results: hits.slice(0, RERANK_TOP_JUDGMENT).map(hit => ({
			judgmentId: hit.judgmentId, chunk_no: hit.chunk_no, neutralCitation: hit.neutralCitation,
			courtName: hit.courtName, year: hit.year, caseAct: null, caseTitle: hit.parties ?? hit.neutralCitation,
			parties: hit.parties, snippet: hit.snippet, url: hit.url, rrf_score: hit.rrf_score, rerank_score: null,
			...judgmentSourceMetadata(hit),
		})) };
	}
	const terms = fallbackSearchTerms(args.query);
	const primaryTerm = fallbackPrimaryTerm(terms);
	// No usable term to constrain the lookup: return nothing rather than
	// arbitrary rows the model could cite.
	if (!primaryTerm) return { results: [] };
	const rows = await debug.stage("summary_fallback", () => prisma.judgmentChunk.findMany({
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
	}), (rows) => ({ hitCount: rows.length }));
	const rankedRows = rows
		.map((item) => ({
			item,
			score: terms.reduce(
				(total, term) => total + (item.content.toLowerCase().includes(term) ? 1 : 0),
			0,
			),
		}))
		.filter(({ score }) => score > 0)
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
export const createSearchJudgmentsTool = (onDebug?: JudgmentSearchDebugSink) => tool({
	description:
		"Search Hong Kong judgment summaries (Postgres fusion: lexical + vector, RRF). Returns the final top-8 post-rerank chunks with caseAct and caseTitle identifiers for get_case.",
	inputSchema: searchJudgmentsInput,
	outputSchema: judgmentToolOutputSchema,
	execute: async (args: SearchJudgmentsInput): Promise<JudgmentToolOutput> => {
		const extraFallbackMs = fulltextEnabled() ? JUDGMENT_LEXICAL_FALLBACK_MS : 0;
		const debug = createJudgmentSearchDebug(onDebug);
		debug.log("start", {
			fulltextEnabled: extraFallbackMs > 0,
			primaryBudgetMs: PRIMARY_SEARCH_BUDGET_MS,
			fallbackBudgetMs: SEARCH_FALLBACK_BUDGET_MS + extraFallbackMs,
			toolBudgetMs: TOOL_TIMEOUT_MS + extraFallbackMs,
		});
		try {
			const output = await withTimeout(
				withToolSpan("tool:search_judgments", args, async () => {
					if (!args.query.trim()) return { error: "search_judgments: query must not be empty" };
					return withSearchFallback(async (): Promise<JudgmentToolOutput> => {
						const embedding = await debug.stage("embedding", () => getEmbeddings(args.query));
						const hits = await debug.stage("hybrid_retrieval", () => searchJudgmentChunks(args.query, {
							embedding,
							languageCodes: args.languageCode ? [args.languageCode] : undefined,
						}), (hits) => ({ hitCount: hits.length, fulltextHitCount: hits.filter((hit) => hit.contentType === "fulltext").length }));
						const unique = dedupe(hits, (h: JudgmentChunkHit) => `${h.judgmentId}:${h.documentId ?? "summary"}:${h.chunk_no}`);
						const ranked = await debug.stage("rerank", () => fuseRerank(args.query, unique, (h) => h.content, RERANK_TOP_JUDGMENT),
							(rows) => ({ hitCount: rows.length, scoredCount: rows.filter((row) => row.rerank_score !== null).length }));
						const judgmentIds = ranked.map(({ item }) => item.judgmentId);
						const casesByJudgmentId = new Map<number, { caseAct: string; title: string }>();
						if (judgmentIds.length > 0) {
							const judgments = await debug.stage("case_metadata", () => prisma.judgment.findMany({
								where: { id: { in: judgmentIds } },
								select: {
									id: true,
									cases: { select: { caseAct: true, title: true }, take: 1 },
								},
							}), (rows) => ({ hitCount: rows.length }));
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
									...judgmentSourceMetadata(item),
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
					}, () => fallbackJudgmentOutput(args, debug), "search_judgments",
					(output) => !("results" in output) || output.results.length > 0,
					SEARCH_FALLBACK_BUDGET_MS + extraFallbackMs,
					(event) => debug.log("fallback", "error" in event ? { ...searchErrorDetails(event.error), reason: event.reason } : event));
				}),
				TOOL_TIMEOUT_MS + extraFallbackMs,
				"search_judgments",
			);
			debug.log("end", "results" in output ? { hitCount: output.results.length } : { reason: "invalid_query" });
			return output;
		} catch (err) {
			debug.log("error", searchErrorDetails(err));
			return { error: `search_judgments failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});
export const searchJudgmentsTool = createSearchJudgmentsTool();
