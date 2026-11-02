import { fulltextEnabled, getFulltext, documentOutputSchema } from "@/lib/judgment-fulltext";
import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TOOL_TIMEOUT_MS, withTimeout, withToolSpan, errorPayloadSchema } from "./shared";

const getCaseInput = z.object({
 judgment_id:z.number().int().positive().optional(),
 start_position:z.number().int().min(0).optional(),
 end_position:z.number().int().min(0).optional(),
 reference_direction:z.enum(["incoming","outgoing","both","none"]).default("none"),
 reference_limit:z.number().int().min(1).max(100).default(20),
 reference_after:z.string().regex(/^\d{1,18}$/).optional().describe("Continue references after the previous nextReferenceId."),
 legislation_after:z.string().regex(/^\d{1,18}$/).optional().describe("Continue legislation references after nextLegislationId."),
	action_no: z.string().optional().describe("Case action number, e.g. the caseAct identifier."),
	case_name: z.string().optional().describe("Party name or title fragment to match."),
});
type GetCaseInput = z.infer<typeof getCaseInput>;

export const caseToolOutputSchema = z.union([
 documentOutputSchema,
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

/**
 * get_case: fulfills the `get_case` promise in src/lib/prompts/search.ts —
 * full-text fetch of a case by action number and/or case (party) name, with
 * linked judgments (neutral citation, court, year, url, summary).
 */
export const getCaseTool = tool({
	description:
		"Fetch a Hong Kong case by action number or party-name fragment with linked judgment summaries. When full-text retrieval is enabled, pass judgment_id and a bounded zero-based start_position/end_position range to fetch original paragraphs and optional incoming/outgoing references. Large responses explicitly report truncation; use narrower ranges or search passages for more context.",
	inputSchema: getCaseInput,
	outputSchema: caseToolOutputSchema,
	execute: async (args: GetCaseInput): Promise<CaseToolOutput> => {
		try {
			return await withTimeout(
				withToolSpan("tool:get_case", args, async () => {
					if(args.judgment_id !== undefined) {
 if(!fulltextEnabled()) return {error:"Judgment full text is disabled"};
 if(args.start_position===undefined || args.end_position===undefined || args.end_position<args.start_position || args.end_position-args.start_position>=100) return {error:"Provide a bounded start_position/end_position range of at most 100 paragraphs"};
 return getFulltext(args.judgment_id,args.start_position,args.end_position,args.reference_direction,args.reference_limit,args.reference_after,args.legislation_after);
 }
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
