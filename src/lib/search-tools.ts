/**
 * T12 — Agent tool library (single-pg backend).
 *
 * 5 typed tools wrapping T08 pg fusion + T09 app-side rerank, callable by the model
 * (wired into the agent loop in T13/T14; T16 will upgrade AI SDK v5 -> 7, so every
 * schema/type used here is declared LOCALLY in this file for a mechanical migration).
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
import { getEmbeddings } from "@/app/api/chat/helper";
import { applyRerank } from "@/lib/rerank";

const TOOL_TIMEOUT_MS = 10_000;
const RERANK_TIMEOUT_MS = 9_000;
const RERANK_TOP_CLIC = 10;
const RERANK_TOP_JUDGMENT = 8;
const RERANK_TOP_LEGISLATION = 10;
/** Depth cap for the legislation graph follow-up (section + 1 level of related). */
const GRAPH_DEPTH_CAP = 2;

// ---------------------------------------------------------------------------
// Local schemas & types (kept in-file for the T16 SDK-7 migration)
// ---------------------------------------------------------------------------

const searchClicInput = z.object({
	query: z.string().min(1).describe("Natural-language legal question or keywords."),
	topic: z.string().optional().describe("CLIC topic filter, e.g. 'Employment'. Omit for all topics."),
	languageCode: z.string().optional().describe("Lane override: 'en' (default) or 'sc'/'tc' for Chinese."),
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
 * Run `fn` inside a `tool:<name>` Langfuse span. Degrades gracefully when called
 * outside an active trace (e.g. unit smoke tests) — work still runs, span is skipped.
 */
async function withToolSpan<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
	try {
		return await startActiveObservation(name, async (span) => {
			try {
				span.update({ input: summarizeForSpan(input) });
			} catch {
				/* best-effort */
			}
			const out = await fn();
			try {
				span.update({ output: summarizeForSpan(out) });
			} catch {
				/* best-effort */
			}
			return out;
		});
	} catch {
		return fn();
	}
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
			applyRerank(query, items, { getText, topN }),
			RERANK_TIMEOUT_MS,
			"rerank",
		);
		return ranked.map((r) => ({ item: r.item, rerank_score: r.rerank_score ?? null }));
	} catch {
		return fallback();
	}
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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** search_clic: T08 CLIC fusion top-30 -> dedupe -> T09 rerank -> top-10. */
export const searchClicTool = tool({
	description:
		"Search CLIC legal-information articles (Postgres fusion: lexical + vector, RRF). Returns the final top-10 post-rerank chunks with snippets.",
	inputSchema: searchClicInput,
	execute: async (args: SearchClicInput): Promise<{ results: ClicToolItem[] } | ErrorPayload> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_clic", args, async () => {
					if (!args.query.trim()) return { error: "search_clic: query must not be empty" };
					const embedding = await getEmbeddings(args.query);
					const hits = await searchClicChunks(args.query, {
						embedding,
						languageCodes: args.languageCode ? [args.languageCode] : undefined,
						topics: args.topic ? [args.topic] : undefined,
					});
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
		"Search Hong Kong judgment summaries (Postgres fusion: lexical + vector, RRF). Returns the final top-8 post-rerank chunks with snippets.",
	inputSchema: searchJudgmentsInput,
	execute: async (args: SearchJudgmentsInput): Promise<{ results: JudgmentToolItem[] } | ErrorPayload> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_judgments", args, async () => {
					if (!args.query.trim()) return { error: "search_judgments: query must not be empty" };
					const embedding = await getEmbeddings(args.query);
					const hits = await searchJudgmentChunks(args.query, {
						embedding,
						languageCodes: args.languageCode ? [args.languageCode] : undefined,
					});
					const unique = dedupe(hits, (h: JudgmentChunkHit) => `${h.judgmentId}:${h.chunk_no}`);
					const ranked = await fuseRerank(args.query, unique, (h) => h.content, RERANK_TOP_JUDGMENT);
					return {
						results: ranked.map(({ item, rerank_score }) => ({
							judgmentId: item.judgmentId,
							chunk_no: item.chunk_no,
							neutralCitation: item.neutralCitation,
							courtName: item.courtName,
							year: item.year,
							snippet: item.snippet,
							url: item.url,
							rrf_score: item.rrf_score,
							rerank_score,
						})),
					};
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
		"Find legislation by Cap/section numbers and/or keyword search over section chunks. Includes directly-related sections and referencing CLIC pages (graph depth <= 2).",
	inputSchema: searchLegislationInput,
	execute: async (
		args: SearchLegislationInput,
	): Promise<
		| { results: LegislationToolItem[]; related: { sectionId: number; capNumber: string; sectionNumber: string; heading: string | null }[]; clicNids: number[] }
		| ErrorPayload
	> => {
		try {
			return await withTimeout(
				withToolSpan("tool:search_legislation", args, async () => {
					if (!args.capNumber && !args.sectionNumber && !args.keywords?.trim()) {
						return { error: "search_legislation: provide capNumber/sectionNumber and/or keywords" };
					}
					let chunks: LegislationChunkHit[] = [];
					if (args.keywords?.trim()) {
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
						chunks = direct.map((d) => ({
							sectionId: d.id,
							chunk_no: 0,
							languageCode: "en",
							capNumber: args.capNumber!,
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
						rrf_score: item.chunk_no === 0 && !args.keywords ? null : item.rrf_score,
						rerank_score,
					}));
					// Graph follow-up (depth <= GRAPH_DEPTH_CAP): mirror of the route's
					// clic->legislation include, capped at one level of related sections.
					void GRAPH_DEPTH_CAP;
					const sectionIds = [...new Set(results.map((r) => r.sectionId))].slice(0, 10);
					let related: { sectionId: number; capNumber: string; sectionNumber: string; heading: string | null }[] = [];
					let clicNids: number[] = [];
					if (sectionIds.length > 0) {
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
	execute: async (
		args: GetOrdinanceSectionInput,
	): Promise<
		| { capTitle: string | null; sections: { sectionNumber: string; subsectionNumber: string | null; heading: string | null; content: string; url: string; languageCode: string }[] }
		| ErrorPayload
	> => {
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
	execute: async (
		args: GetCaseInput,
	): Promise<
		| { cases: { caseAct: string; title: string; judgments: { neutralCitation: string; courtName: string; year: number; date: Date; url: string; summary: string | null }[] }[] }
		| ErrorPayload
	> => {
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
					return { cases };
				}),
				TOOL_TIMEOUT_MS,
				"get_case",
			);
		} catch (err) {
			return { error: `get_case failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});

/** Tool set for the agent loop (wired in T13/T14). Keys are the model-visible names. */
export const searchTools = {
	search_clic: searchClicTool,
	search_judgments: searchJudgmentsTool,
	search_legislation: searchLegislationTool,
	get_ordinance_section: getOrdinanceSectionTool,
	get_case: getCaseTool,
};
