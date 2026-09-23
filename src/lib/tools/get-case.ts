import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TOOL_TIMEOUT_MS, withTimeout, withToolSpan, errorPayloadSchema } from "./shared";

const getCaseInput = z.object({
	action_no: z.string().optional().describe("Case action number, e.g. the caseAct identifier."),
	case_name: z.string().optional().describe("Party name or title fragment to match."),
});
type GetCaseInput = z.infer<typeof getCaseInput>;

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
