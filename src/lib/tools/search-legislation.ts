import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchLegislationChunks, type LegislationChunkHit } from "@/lib/pg-search";
import { getEmbeddings } from "@/app/api/chat/helper";
import {
	TOOL_TIMEOUT_MS,
	RERANK_TOP_LEGISLATION,
	GRAPH_DEPTH_CAP,
	withTimeout,
	withToolSpan,
	fuseRerank,
	dedupe,
	errorPayloadSchema,
} from "./shared";

const searchLegislationInput = z.object({
	capNumber: z.string().optional().describe("Ordinance chapter number, e.g. '57'."),
	sectionNumber: z.string().optional().describe("Section number within the Cap, e.g. '7'."),
	keywords: z.string().optional().describe("Keywords/question for semantic+lexical chunk search."),
});
type SearchLegislationInput = z.infer<typeof searchLegislationInput>;

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
