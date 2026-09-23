import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TOOL_TIMEOUT_MS, withTimeout, withToolSpan, errorPayloadSchema } from "./shared";

const getOrdinanceSectionInput = z.object({
	cap_no: z.string().min(1).describe("Ordinance chapter number, e.g. '57'."),
	section_no: z.string().min(1).describe("Section number, e.g. '7'."),
});
type GetOrdinanceSectionInput = z.infer<typeof getOrdinanceSectionInput>;

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
