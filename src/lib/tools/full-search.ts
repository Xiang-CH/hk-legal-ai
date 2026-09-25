import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
	searchClicChunks,
	searchJudgmentChunks,
	type ClicChunkHit,
	type JudgmentChunkHit,
} from "@/lib/pg-search";
import { getEmbeddings } from "@/lib/clic-api";
import { applyRerank } from "@/lib/rerank";
import {
	TOOL_TIMEOUT_MS,
	FULL_SEARCH_TOOL_TIMEOUT_MS,
	FULL_SEARCH_MERGE_CAP,
	FULL_SEARCH_TOP_N,
	FULL_SEARCH_RERANK_TIMEOUT_MS,
	FULL_SEARCH_GRAPH_CAP,
	FULL_SEARCH_RERANK_TEXT_CHARS,
	FULL_SEARCH_LEGISLATION_SNIPPET_CHARS,
	withTimeout,
	withToolSpan,
	errorPayloadSchema,
} from "./shared";

/* ---------------------------------------------------------------------------
 * full_search — the legacy multi-step pipeline as a callable tool.
 *
 * Mirrors handleLegacyChat's retrieval (minus final-answer generation, which
 * stays with the calling agent): agent-supplied queries (up to 3) -> fan-out
 * over CLIC chunks + judgment chunks -> cross-query merge/dedupe -> one rerank
 * per corpus -> legislation graph walk from the merged CLIC nids.
 *
 * Returns evidence snippets only; call get_ordinance_section / get_case for
 * exact text before quoting. One step, but internally slower than the
 * single-purpose tools — prefer those when the target is already known.
 * ------------------------------------------------------------------------- */

const fullSearchInput = z.object({
	queries: z.array(z.string().min(1)).min(1).max(3).describe("1-3 related search queries ( synonyms / broader and narrower phrasings of the same question). The first query is the primary question and is used for reranking."),
	searchDepth: z.number().int().min(1).max(3).optional().describe("Legislation graph depth: 1 skips the ordinance graph, 2 (default) follows CLIC-referenced sections, 3 adds one more level of related sections."),
});
type FullSearchInput = z.infer<typeof fullSearchInput>;

const fullSearchClicResultSchema = z.strictObject({
	kind: z.literal("clic"),
	nid: z.number(),
	chunk_no: z.number(),
	title: z.string(),
	snippet: z.string(),
	url: z.string(),
	rrf_score: z.number(),
	rerank_score: z.number().nullable(),
});

const fullSearchJudgmentResultSchema = z.strictObject({
	kind: z.literal("judgment"),
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
});

const fullSearchLegislationResultSchema = z.strictObject({
	kind: z.literal("legislation"),
	capNumber: z.string(),
	sectionNumber: z.string(),
	heading: z.string().nullable(),
	snippet: z.string(),
	url: z.string(),
	rrf_score: z.number().nullable(),
	rerank_score: z.number().nullable(),
});

export const fullSearchResultItemSchema = z.discriminatedUnion("kind", [
	fullSearchClicResultSchema,
	fullSearchJudgmentResultSchema,
	fullSearchLegislationResultSchema,
]);
export type FullSearchResultItem = z.infer<typeof fullSearchResultItemSchema>;

export const fullSearchOutputSchema = z.union([
	z.strictObject({
		searchQueries: z.array(z.string()),
		results: z.array(fullSearchResultItemSchema).describe("Global top-10 across all corpora, best first. Scores are comparable across kinds (single rerank call)."),
	}),
	errorPayloadSchema,
]);
export type FullSearchOutput = z.infer<typeof fullSearchOutputSchema>;

/** Merge many hit lists, keeping the best rrf_score per key. */
function mergeBestRrf<T>(lists: T[][], key: (item: T) => string, score: (item: T) => number): T[] {
	const best = new Map<string, T>();
	for (const list of lists) {
		for (const item of list) {
			const k = key(item);
			const prev = best.get(k);
			if (!prev || score(item) > score(prev)) best.set(k, item);
		}
	}
	return [...best.values()];
}

export const fullSearchTool = tool({
	description:
		"Broad multi-query search across CLIC articles, judgment summaries, and the legislation graph in a single call. " +
		"Provide 1-3 related queries (same question from different angles); the tool searches every corpus, pools ALL candidates, reranks them together, and returns the global top 10. " +
		"Use when a first targeted search came back thin, or the question is broad/multi-faceted. " +
		"Returns snippets only — call get_ordinance_section / get_case for exact text before quoting.",
	inputSchema: fullSearchInput,
	outputSchema: fullSearchOutputSchema,
	execute: async (args: FullSearchInput): Promise<FullSearchOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:full_search", args, async () => {
					const searchQueries = args.queries.map((q) => q.trim()).filter((q) => q.length > 0).slice(0, 3);
					if (searchQueries.length === 0) return { error: "full_search: queries must not be empty" };
					const primaryQuery = searchQueries[0] as string;
					const searchDepth = args.searchDepth ?? 2;

					// 1. Embed once per query, fan out across CLIC + judgments (no lane filter, like the legacy route).
					const embeddings = await Promise.all(searchQueries.map((q) => getEmbeddings(q)));
					const clicLists = await Promise.all(
						searchQueries.map((q, i) =>
							searchClicChunks(q, { embedding: embeddings[i] }).catch((): ClicChunkHit[] => []),
						),
					);
					const judgmentLists = await Promise.all(
						searchQueries.map((q, i) =>
							searchJudgmentChunks(q, { embedding: embeddings[i] }).catch((): JudgmentChunkHit[] => []),
						),
					);

					// 2. Cross-query merge/dedupe (best rrf wins), global RRF order, cap rerank input.
					const topByRrf = <T extends { rrf_score?: number | null }>(rows: T[]): T[] =>
						[...rows].sort((a, b) => (b.rrf_score ?? 0) - (a.rrf_score ?? 0)).slice(0, FULL_SEARCH_MERGE_CAP);
					const clicMerged = topByRrf(
						mergeBestRrf(clicLists, (h) => `${h.nid}:${h.chunk_no}`, (h) => h.rrf_score ?? 0),
					);
					const judgmentMerged = topByRrf(
						mergeBestRrf(judgmentLists, (h) => `${h.judgmentId}:${h.chunk_no}`, (h) => h.rrf_score ?? 0),
					);

					// 3. Legislation graph walk from the merged CLIC nids (mirror of the legacy route).
					//    Graph items join the rerank pool below, so they compete with CLIC/judgment hits.
					type FullSearchGraphSection = {
						capNumber: string;
						sectionNumber: string;
						heading: string | null;
						content: string;
						url: string;
					};
					/** Raw prisma shape (sectionHeading + optional nested level) before mapping. */
					type FullSearchGraphRow = {
						capNumber: string;
						sectionNumber: string;
						sectionHeading: string | null;
						content: string;
						url: string;
						referencingLegislationSections?: FullSearchGraphRow[];
					};
					const graphSections: FullSearchGraphSection[] = [];
					if (searchDepth > 1) {
						const nids = [...new Set(clicMerged.map((h) => h.nid))];
						if (nids.length > 0) {
							const rows = await withTimeout(
								prisma.clicPage.findMany({
									where: { nid: { in: nids } },
									include: {
										referencingLegislationSections: {
											select: {
												capNumber: true,
												sectionNumber: true,
												sectionHeading: true,
												content: true,
												url: true,
												referencingLegislationSections: searchDepth > 2
													? {
														select: {
															capNumber: true,
															sectionNumber: true,
															sectionHeading: true,
															content: true,
															url: true,
														},
													}
													: false,
											},
										},
									},
								}),
								TOOL_TIMEOUT_MS,
								"full_search graph",
							);
							const seen = new Set<string>();
							const push = (section: FullSearchGraphRow): void => {
								const key = `${section.capNumber}\u00a7${section.sectionNumber}`;
								if (seen.has(key)) return;
								seen.add(key);
								graphSections.push({
									capNumber: section.capNumber,
									sectionNumber: section.sectionNumber,
									heading: section.sectionHeading,
									content: section.content,
									url: section.url,
								});
								if (graphSections.length >= FULL_SEARCH_GRAPH_CAP) return;
							};
							for (const row of rows) {
								for (const section of row.referencingLegislationSections as unknown as FullSearchGraphRow[]) {
									push(section);
									if (searchDepth > 2) {
										for (const related of section.referencingLegislationSections ?? []) push(related);
									}
									if (graphSections.length >= FULL_SEARCH_GRAPH_CAP) break;
								}
								if (graphSections.length >= FULL_SEARCH_GRAPH_CAP) break;
							}
						}
					}

					// 4. Pool EVERY candidate and rerank once against the primary query, so
					//    scores are comparable across corpora. Return the global top 10.
					type FullSearchPoolItem =
						| { kind: "clic"; hit: ClicChunkHit }
						| { kind: "judgment"; hit: JudgmentChunkHit }
						| { kind: "legislation"; section: FullSearchGraphSection };
					// RRF order upfront: applyRerank does not throw when rerank is
					// disabled/failing (it returns items.slice(0, topN)), so without this
					// the top 10 would always be CLIC hits. Rerank itself is order-independent.
					const poolRrf = (candidate: FullSearchPoolItem): number =>
						candidate.kind === "legislation" ? Number.NEGATIVE_INFINITY : (candidate.hit.rrf_score ?? 0);
					const pool: FullSearchPoolItem[] = [
						...clicMerged.map((hit): FullSearchPoolItem => ({ kind: "clic", hit })),
						...judgmentMerged.map((hit): FullSearchPoolItem => ({ kind: "judgment", hit })),
						...graphSections.map((section): FullSearchPoolItem => ({ kind: "legislation", section })),
					].sort((a, b) => poolRrf(b) - poolRrf(a));
					const poolText = (candidate: FullSearchPoolItem): string => {
						if (candidate.kind === "clic") return candidate.hit.content;
						if (candidate.kind === "judgment") return candidate.hit.content;
						return candidate.section.content.slice(0, FULL_SEARCH_RERANK_TEXT_CHARS);
					};
					let ranked: { item: FullSearchPoolItem; rerank_score: number | null }[];
					if (pool.length === 0) {
						ranked = [];
					} else {
						try {
							const reranked = await withTimeout(
								applyRerank(primaryQuery, pool, {
									getText: poolText,
									topN: FULL_SEARCH_TOP_N,
									timeoutMs: FULL_SEARCH_RERANK_TIMEOUT_MS,
								}),
								FULL_SEARCH_RERANK_TIMEOUT_MS,
								"full_search rerank",
							);
							ranked = reranked.map((r) => ({ item: r.item, rerank_score: r.rerank_score ?? null }));
						} catch {
							// Rerank unavailable: pool is already in fusion order (graph items sink).
							ranked = [...pool]
								.sort((a, b) => poolRrf(b) - poolRrf(a))
								.slice(0, FULL_SEARCH_TOP_N)
								.map((item) => ({ item, rerank_score: null }));
						}
					}
					const top = ranked.slice(0, FULL_SEARCH_TOP_N);

					// 5. Attach caseAct/caseTitle identifiers for get_case follow-ups (ranked hits only).
					const casesByJudgmentId = new Map<number, { caseAct: string; title: string }>();
					const topJudgmentIds = [
						...new Set(
							top.map(({ item }) => (item.kind === "judgment" ? item.hit.judgmentId : null)).filter((id): id is number => id !== null),
						),
					];
					if (topJudgmentIds.length > 0) {
						const judgments = await prisma.judgment.findMany({
							where: { id: { in: topJudgmentIds } },
							select: { id: true, cases: { select: { caseAct: true, title: true }, take: 1 } },
						});
						for (const judgment of judgments) {
							const caseSummary = judgment.cases[0];
							if (caseSummary) casesByJudgmentId.set(judgment.id, caseSummary);
						}
					}

					return {
						searchQueries,
						results: top.map(({ item, rerank_score }): FullSearchResultItem => {
							if (item.kind === "clic") {
								return {
									kind: "clic",
									nid: item.hit.nid,
									chunk_no: item.hit.chunk_no,
									title: item.hit.title,
									snippet: item.hit.snippet,
									url: item.hit.url,
									rrf_score: item.hit.rrf_score,
									rerank_score,
								};
							}
							if (item.kind === "judgment") {
								const caseSummary = casesByJudgmentId.get(item.hit.judgmentId);
								return {
									kind: "judgment",
									judgmentId: item.hit.judgmentId,
									chunk_no: item.hit.chunk_no,
									neutralCitation: item.hit.neutralCitation,
									courtName: item.hit.courtName,
									year: item.hit.year,
									caseAct: caseSummary?.caseAct ?? null,
									caseTitle: caseSummary?.title ?? null,
									parties: item.hit.parties,
									snippet: item.hit.snippet,
									url: item.hit.url,
									rrf_score: item.hit.rrf_score,
									rerank_score,
								};
							}
							return {
								kind: "legislation",
								capNumber: item.section.capNumber,
								sectionNumber: item.section.sectionNumber,
								heading: item.section.heading,
								snippet: item.section.content.slice(0, FULL_SEARCH_LEGISLATION_SNIPPET_CHARS),
								url: item.section.url,
								rrf_score: null,
								rerank_score,
							};
						}),
					};
				}),
				FULL_SEARCH_TOOL_TIMEOUT_MS,
				"full_search",
			);
		} catch (err) {
			return { error: `full_search failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	},
});
