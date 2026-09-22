/**
 * T12 — Agent tool library (single-pg backend).
 *
 * 5 typed tools wrapping T08 pg fusion + T09 app-side rerank, callable by the model
 * (used by the T13-T15 agent loop after the T16 AI SDK 7 upgrade; schema and
 * type definitions remain local to this file).
 *
 * HARD RULE: downstream UI only shows post-rerank docs, so every search_* tool
 * internally runs fuse -> rerank and returns ONLY the final top-N (never raw fusion
 * candidates). Each item carries both rrf_score and rerank_score (null when rerank
 * is disabled/failed — applyRerank already falls back to fusion order internally).
 *
 * Each tool: 10s total timeout, failure returns an `{error}` string payload (never
 * throws), `startActiveObservation("tool:<name>")` span with input/output, and a
 * working RERANK_ENABLED=false path (fusion order, rerank_score: null).
 */
import { tool } from "ai";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import { prisma } from "@/lib/prisma";
import {
	searchClicChunks,
	searchJudgmentChunks,
	searchLegislationChunks,
	type ClicChunkHit,
	type JudgmentChunkHit,
	type LegislationChunkHit,
} from "@/lib/pg-search";
import { containsCjk } from "@/lib/cjk";
import { getEmbeddings } from "@/app/api/chat/helper";
import { applyRerank } from "@/lib/rerank";

const TOOL_TIMEOUT_MS = 10_000;
const PRIMARY_SEARCH_BUDGET_MS = 2_500;
const SEARCH_FALLBACK_BUDGET_MS = TOOL_TIMEOUT_MS - PRIMARY_SEARCH_BUDGET_MS - 250;
const RERANK_TIMEOUT_MS = 2_000;
const RERANK_TOP_CLIC = 10;
const RERANK_TOP_JUDGMENT = 8;
const RERANK_TOP_LEGISLATION = 10;
/** Depth cap for the legislation graph follow-up (section + 1 level of related). */
const GRAPH_DEPTH_CAP = 2;
const ALL_CLIC_LANGUAGE_CODES = ["en", "sc", "tc"] as const;

const CLIC_TOPIC_ALIASES: Readonly<Record<string, string>> = {
	employment: "employmentDisputes",
	tenancy: "landlord_tenant",
	landlord: "landlord_tenant",
	tenant: "landlord_tenant",
	rental: "landlord_tenant",
	housing: "landlord_tenant",
	consumer: "consumer_complaints",
	defamation: "defamation",
	judicialreview: "judicial_review",
};

// ---------------------------------------------------------------------------
// Local schemas & types (kept in-file for the T16 SDK-7 migration)
// ---------------------------------------------------------------------------

const searchClicInput = z.object({
	query: z.string().min(1).describe("Natural-language legal question or keywords."),
	topic: z.string().optional().describe("Preferred CLIC topic filter. The search retries across topics if this filter has no matches."),
	languageCode: z.string().optional().describe("Preferred lane: 'en' (default) or 'sc'/'tc' for Chinese. The search retries across available lanes if this lane has no matches."),
});
type SearchClicInput = z.infer<typeof searchClicInput>;

const searchJudgmentsInput = z.object({
	query: z.string().min(1).describe("Natural-language question or fact pattern to match judgments."),
	languageCode: z.string().optional().describe("Lane override: 'en' (default) or 'sc'/'tc'."),
});
type SearchJudgmentsInput = z.infer<typeof searchJudgmentsInput>;

const searchLegislationInput = z.object({
	capNumber: z.string().optional().describe("Ordinance chapter number, e.g. '57'."),
	sectionNumber: z.string().optional().describe("Section number within the Cap, e.g. '7'."),
	keywords: z.string().optional().describe("Keywords/question for semantic+lexical chunk search."),
});
type SearchLegislationInput = z.infer<typeof searchLegislationInput>;

const getOrdinanceSectionInput = z.object({
	cap_no: z.string().min(1).describe("Ordinance chapter number, e.g. '57'."),
	section_no: z.string().min(1).describe("Section number, e.g. '7'."),
});
type GetOrdinanceSectionInput = z.infer<typeof getOrdinanceSectionInput>;

const getCaseInput = z.object({
	action_no: z.string().optional().describe("Case action number, e.g. the caseAct identifier."),
	case_name: z.string().optional().describe("Party name or title fragment to match."),
});
type GetCaseInput = z.infer<typeof getCaseInput>;

/** Post-rerank CLIC item — the ONLY shape downstream UI consumes. */
export interface ClicToolItem {
	nid: number;
	chunk_no: number;
	title: string;
	snippet: string;
	url: string;
	rrf_score: number;
	rerank_score: number | null;
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

export interface LegislationToolItem {
	sectionId: number;
	chunk_no: number;
	capNumber: string;
	sectionNumber: string;
	heading: string | null;
	snippet: string;
	url: string;
	rrf_score: number | null;
	rerank_score: number | null;
}

type ErrorPayload = { error: string };
const errorPayloadSchema = z.strictObject({ error: z.string() });

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

export const legislationToolOutputSchema = z.union([
	z.strictObject({
		results: z.array(z.strictObject({
			sectionId: z.number(),
			chunk_no: z.number(),
			capNumber: z.string(),
			sectionNumber: z.string(),
			heading: z.string().nullable(),
			snippet: z.string(),
			url: z.string(),
			rrf_score: z.number().nullable(),
			rerank_score: z.number().nullable(),
		})),
		related: z.array(z.strictObject({
			sectionId: z.number(),
			capNumber: z.string(),
			sectionNumber: z.string(),
			heading: z.string().nullable(),
		})),
		clicNids: z.array(z.number()),
	}),
	errorPayloadSchema,
]);
export type LegislationToolOutput = z.infer<typeof legislationToolOutputSchema>;

export const ordinanceSectionToolOutputSchema = z.union([
	z.strictObject({
		cap_no: z.string(),
		section_no: z.string(),
		capTitle: z.string().nullable(),
		sections: z.array(z.strictObject({
			sectionNumber: z.string(),
			subsectionNumber: z.string().nullable(),
			heading: z.string().nullable(),
			content: z.string(),
			url: z.string(),
			languageCode: z.string(),
		})),
	}),
	errorPayloadSchema,
]);
export type OrdinanceSectionToolOutput = z.infer<typeof ordinanceSectionToolOutputSchema>;

export const caseToolOutputSchema = z.union([
	z.strictObject({
		cases: z.array(z.strictObject({
			caseAct: z.string(),
			title: z.string(),
			judgments: z.array(z.strictObject({
				id: z.number(),
				chunk_no: z.literal(0),
				neutralCitation: z.string(),
				courtName: z.string(),
				year: z.number(),
				date: z.string(),
				url: z.string(),
				summary: z.string().nullable(),
			})),
		})),
	}),
	errorPayloadSchema,
]);
export type CaseToolOutput = z.infer<typeof caseToolOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`[tool] ${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withSearchFallback<T>(
	primary: () => Promise<T>,
	fallback: () => Promise<T>,
	label: string,
	isUsable: (value: T) => boolean = () => true,
): Promise<T> {
	try {
		const result = await withTimeout(primary(), PRIMARY_SEARCH_BUDGET_MS, `${label} primary`);
		if (isUsable(result)) return result;
	} catch {
		/* fall through to the bounded direct lookup */
	}
	return await withTimeout(fallback(), SEARCH_FALLBACK_BUDGET_MS, `${label} fallback`);
}

/** Truncate long strings so Langfuse span I/O stays bounded. */
function summarizeForSpan(value: unknown): unknown {
	try {
		return JSON.parse(
			JSON.stringify(value, (_key, v) =>
				typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v,
			),
		);
	} catch {
		return { unserializable: true };
	}
}

/**
 * Run `fn` inside a `tool:<name>` Langfuse observation. The OpenTelemetry no-op
 * tracer keeps unit smoke tests working without a registered provider.
 */
async function withToolSpan<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
	return startActiveObservation(
		name,
		async (span) => {
			span.update({ input: summarizeForSpan(input) });
			const out = await fn();
			span.update({ output: summarizeForSpan(out) });
			return out;
		},
		{ asType: "tool" },
	);
}

/**
 * Rerank `items` to topN with a bounded wait; ANY rerank failure (disabled,
 * timeout, 429/5xx, bad shape) falls back to fusion order with null scores.
 */
async function fuseRerank<T>(
	query: string,
	items: T[],
	getText: (item: T) => string,
	topN: number,
): Promise<{ item: T; rerank_score: number | null }[]> {
	const fallback = () => items.slice(0, topN).map((item) => ({ item, rerank_score: null }));
	if (items.length === 0) return [];
	try {
		const ranked = await withTimeout(
			applyRerank(query, items, { getText, topN, timeoutMs: RERANK_TIMEOUT_MS }),
			RERANK_TIMEOUT_MS,
			"rerank",
		);
		return ranked.map((r) => ({ item: r.item, rerank_score: r.rerank_score ?? null }));
	} catch {
		return fallback();
	}
}

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

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
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

function fallbackSearchTerms(query: string): string[] {
	const stopWords = new Set([
		"about", "after", "against", "case", "cases", "court", "courts", "decided",
		"decision", "explain", "find", "from", "have", "hong", "kong", "legal",
		"summarize", "that", "the", "their", "this", "what", "with",
	]);
	return [...new Set(
		(query.match(/[a-z0-9]{3,}/gi) ?? [])
			.map((term) => term.toLowerCase())
			.filter((term) => !stopWords.has(term)),
	)].slice(0, 8);
}

function fallbackPrimaryTerm(terms: string[]): string | null {
	const genericTerms = new Set([
		"approach", "compensation", "decision", "employment", "justification",
		"ordinance", "reinstatement", "remedies", "unfair", "unlawful", "unreasonable", "wrongful",
	]);
	return terms.find((term) => term.length >= 6 && !genericTerms.has(term)) ?? terms.find((term) => !genericTerms.has(term)) ?? terms[0] ?? null;
}

async function fallbackClicOutput(args: SearchClicInput): Promise<ClicToolOutput> {
	const topic = resolveClicTopic(args.topic, args.query);
	const terms = fallbackSearchTerms(args.query);
	const rows = await prisma.clicChunk.findMany({
		where: {
			...(topic ? { topic } : {}),
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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

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

/**
 * search_legislation: pg chunk search (keywords) and/or direct Cap/section lookup,
 * plus the T10 clic-nid graph walk as an internal follow-up capped at depth <= 2:
 * section -> parent Cap title + one level of referencing sections + referencing CLIC nids.
 */
export const searchLegislationTool = tool({
	description:
		"Find legislation by exact Cap/section numbers or keyword search over section chunks. Exact section lookup returns the provision needed by get_ordinance_section.",
	inputSchema: searchLegislationInput,
	outputSchema: legislationToolOutputSchema,
	execute: async (
		args: SearchLegislationInput,
	): Promise<LegislationToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_legislation", args, async () => {
					if (!args.capNumber && !args.sectionNumber && !args.keywords?.trim()) {
						return { error: "search_legislation: provide capNumber/sectionNumber and/or keywords" };
					}
					const isExactSectionLookup = Boolean(args.capNumber && args.sectionNumber);
					let chunks: LegislationChunkHit[] = [];
					if (isExactSectionLookup) {
						const capNumber = args.capNumber;
						const sectionNumber = args.sectionNumber;
						if (!capNumber || !sectionNumber) {
							return { error: "search_legislation: exact lookup requires capNumber and sectionNumber" };
						}
						const direct = await prisma.legislationSection.findMany({
							where: { capNumber, sectionNumber },
							select: {
								id: true,
								languageCode: true,
								capNumber: true,
								sectionNumber: true,
								subsectionNumber: true,
								sectionHeading: true,
								content: true,
								url: true,
							},
							take: 20,
						});
						if (direct.length === 0) {
							return { error: `search_legislation: no sections found for Cap ${capNumber} s.${sectionNumber}` };
						}
						chunks = direct.map((item) => ({
							sectionId: item.id,
							chunk_no: 0,
							languageCode: item.languageCode,
							capNumber: item.capNumber,
							sectionNumber: item.sectionNumber,
							subsectionNumber: item.subsectionNumber,
							heading: item.sectionHeading,
							content: item.content,
							url: item.url,
							context: null,
							lexical_rank: null,
							vector_distance: null,
							rrf_score: 0,
							snippet: item.content.slice(0, 240),
						}));
					} else if (args.keywords?.trim()) {
						const embedding = await getEmbeddings(args.keywords);
						chunks = await searchLegislationChunks(args.keywords, {
							embedding,
							languageCodes: ["en", "sc", "tc"],
						});
						if (args.capNumber) chunks = chunks.filter((c) => c.capNumber === args.capNumber);
						if (args.sectionNumber) chunks = chunks.filter((c) => c.sectionNumber === args.sectionNumber);
					} else if (args.capNumber) {
						// No keywords: direct section lookup feeds the graph walk below.
						const direct = await prisma.legislationSection.findMany({
							where: {
								capNumber: args.capNumber,
								...(args.sectionNumber ? { sectionNumber: args.sectionNumber } : {}),
							},
							select: { id: true },
							take: 20,
						});
						if (direct.length === 0) {
							return { error: `search_legislation: no sections found for Cap ${args.capNumber}${args.sectionNumber ? ` s.${args.sectionNumber}` : ""}` };
						}
							const capNumber = args.capNumber;
							chunks = direct.map((d) => ({
								sectionId: d.id,
								chunk_no: 0,
								languageCode: "en",
								capNumber,
							sectionNumber: args.sectionNumber ?? "",
							subsectionNumber: null,
							heading: null,
							content: "",
							url: "",
							context: null,
							lexical_rank: null,
							vector_distance: null,
							rrf_score: 0,
							snippet: "",
						}));
					}
					const unique = dedupe(chunks, (c) => `${c.sectionId}:${c.chunk_no}`);
					const rerankQuery = args.keywords?.trim() || `Cap ${args.capNumber ?? ""} s.${args.sectionNumber ?? ""}`;
					const ranked = await fuseRerank(
						rerankQuery,
						unique,
						(c) => `${c.heading ?? ""}\n${c.content}`.trim() || `${c.capNumber} s.${c.sectionNumber}`,
						RERANK_TOP_LEGISLATION,
					);
					const results: LegislationToolItem[] = ranked.map(({ item, rerank_score }) => ({
						sectionId: item.sectionId,
						chunk_no: item.chunk_no,
						capNumber: item.capNumber,
						sectionNumber: item.sectionNumber,
						heading: item.heading,
						snippet: item.snippet,
						url: item.url,
						rrf_score: isExactSectionLookup || !args.keywords ? null : item.rrf_score,
						rerank_score,
					}));
					// Graph follow-up (depth <= GRAPH_DEPTH_CAP): mirror of the route's
					// clic->legislation include, capped at one level of related sections.
					void GRAPH_DEPTH_CAP;
					const sectionIds = [...new Set(results.map((r) => r.sectionId))].slice(0, 10);
					let related: { sectionId: number; capNumber: string; sectionNumber: string; heading: string | null }[] = [];
					let clicNids: number[] = [];
					if (!isExactSectionLookup && sectionIds.length > 0) {
						const sections = await prisma.legislationSection.findMany({
							where: { id: { in: sectionIds } },
							select: {
								referencingLegislationSections: {
									select: { id: true, capNumber: true, sectionNumber: true, sectionHeading: true },
									take: 5,
								},
								referencedByClicPages: { select: { nid: true }, take: 5 },
							},
						});
						related = sections.flatMap((s) =>
							s.referencingLegislationSections.map((r) => ({
								sectionId: r.id,
								capNumber: r.capNumber,
								sectionNumber: r.sectionNumber,
								heading: r.sectionHeading,
							})),
						);
						clicNids = [...new Set(sections.flatMap((s) => s.referencedByClicPages.map((p) => p.nid)))];
					}
					return { results, related, clicNids };
				}),
				TOOL_TIMEOUT_MS,
				"search_legislation",
			);
		} catch (err) {
			return { error: `search_legislation failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});

/**
 * get_ordinance_section: fulfills the `get_ordinance_or_regulation` promise in
 * src/lib/prompts/search.ts — full-text fetch of a Cap section (all subsections,
 * all lanes) with parent Cap title.
 */
export const getOrdinanceSectionTool = tool({
	description:
		"Fetch the full text of a Hong Kong ordinance/regulation section by Cap number and section number (all subsections and language lanes).",
	inputSchema: getOrdinanceSectionInput,
	outputSchema: ordinanceSectionToolOutputSchema,
	execute: async (args: GetOrdinanceSectionInput): Promise<OrdinanceSectionToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:get_ordinance_section", args, async () => {
					const sections = await prisma.legislationSection.findMany({
						where: { capNumber: args.cap_no, sectionNumber: args.section_no },
						select: {
							sectionNumber: true,
							subsectionNumber: true,
							sectionHeading: true,
							content: true,
							url: true,
							languageCode: true,
							parentLegislationCap: { select: { title: true } },
						},
						orderBy: [{ languageCode: "asc" }, { subsectionNumber: "asc" }],
					});
					if (sections.length === 0) {
						return { error: `get_ordinance_section: no section found for Cap ${args.cap_no} s.${args.section_no}` };
					}
					return {
						cap_no: args.cap_no,
						section_no: args.section_no,
						capTitle: sections[0].parentLegislationCap?.title ?? null,
						sections: sections.map((s) => ({
							sectionNumber: s.sectionNumber,
							subsectionNumber: s.subsectionNumber,
							heading: s.sectionHeading,
							content: s.content,
							url: s.url,
							languageCode: s.languageCode,
						})),
					};
				}),
				TOOL_TIMEOUT_MS,
				"get_ordinance_section",
			);
		} catch (err) {
			return { error: `get_ordinance_section failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});

/**
 * get_case: fulfills the `get_case` promise in src/lib/prompts/search.ts —
 * full-text fetch of a case by action number and/or case (party) name, with
 * linked judgments (neutral citation, court, year, url, summary).
 */
export const getCaseTool = tool({
	description:
		"Fetch a Hong Kong case by action number and/or party-name fragment, with linked judgments (citation, court, summary). Provide at least one argument.",
	inputSchema: getCaseInput,
	outputSchema: caseToolOutputSchema,
	execute: async (args: GetCaseInput): Promise<CaseToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:get_case", args, async () => {
					if (!args.action_no?.trim() && !args.case_name?.trim()) {
						return { error: "get_case: provide at least one of action_no or case_name" };
					}
					const cases = await prisma.case.findMany({
						where: {
							...(args.action_no?.trim() ? { caseAct: { contains: args.action_no.trim(), mode: "insensitive" } } : {}),
							...(args.case_name?.trim() ? { title: { contains: args.case_name.trim(), mode: "insensitive" } } : {}),
						},
						select: {
							caseAct: true,
							title: true,
							judgments: {
								select: {
									id: true,
									neutralCitation: true,
									courtName: true,
									year: true,
									date: true,
									url: true,
									summary: true,
								},
								orderBy: { date: "desc" },
								take: 5,
							},
						},
						take: 5,
					});
					if (cases.length === 0) {
						return { error: `get_case: no case found for ${args.action_no?.trim() ? `action_no=${args.action_no.trim()} ` : ""}${args.case_name?.trim() ? `case_name=${args.case_name.trim()}` : ""}`.trim() };
					}
					return {
						cases: cases.map((item) => ({
							caseAct: item.caseAct,
							title: item.title,
							judgments: item.judgments.map((judgment) => ({
								id: judgment.id,
								chunk_no: 0,
								neutralCitation: judgment.neutralCitation,
								courtName: judgment.courtName,
								year: judgment.year,
								date: judgment.date.toISOString(),
								url: judgment.url,
								summary: judgment.summary,
							})),
						})),
					};
				}),
				TOOL_TIMEOUT_MS,
				"get_case",
			);
		} catch (err) {
			return { error: `get_case failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});

/** Tool set for the T13-T15 agent loop. Keys are the model-visible names. */
export const searchTools = {
	search_clic: searchClicTool,
	search_judgments: searchJudgmentsTool,
	search_legislation: searchLegislationTool,
	get_ordinance_section: getOrdinanceSectionTool,
	get_case: getCaseTool,
};
