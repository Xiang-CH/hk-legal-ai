/**
 * Agent tool library (single-pg backend).
 *
 * One file per tool under this directory plus shared budgets/spans/helpers in
 * `./shared`. Import from `@/lib/tools` (this index re-exports the public
 * surface so existing `searchTools` consumers keep working unchanged).
 *
 * HARD RULE: downstream UI only shows post-rerank docs, so every search_* tool
 * internally runs fuse -> rerank and returns ONLY the final top-N (never raw fusion
 * candidates). Each item carries both rrf_score and rerank_score (null when rerank
 * is disabled/failed — applyRerank already falls back to fusion order internally).
 */
import type { JudgmentSearchDebugSink } from "@/lib/types";
import { createSearchClicTool } from "./search-clic";
import { createSearchJudgmentsTool } from "./search-judgments";
import { createSearchLegislationTool } from "./search-legislation";
import { getOrdinanceSectionTool } from "./get-ordinance-section";
import { getCaseTool } from "./get-case";
import { createFullSearchTool } from "./full-search";
import { askQuestionTool } from "./ask-question";

/** Tool set for the agent loop. Keys are the model-visible names. */
export function createSearchTools(debug?: JudgmentSearchDebugSink) {
	return {
		search_clic: createSearchClicTool(debug),
		search_judgments: createSearchJudgmentsTool(debug),
		search_legislation: createSearchLegislationTool(debug),
		get_ordinance_section: getOrdinanceSectionTool,
		get_case: getCaseTool,
		full_search: createFullSearchTool(debug),
		ask_question: askQuestionTool,
	};
}

export const searchTools = createSearchTools();

export { searchClicTool } from "./search-clic";
export type { ClicToolItem, ClicToolOutput } from "./search-clic";
export { clicToolOutputSchema } from "./search-clic";
export { searchJudgmentsTool } from "./search-judgments";
export type { JudgmentToolItem, JudgmentToolOutput } from "./search-judgments";
export { judgmentToolOutputSchema } from "./search-judgments";
export { searchLegislationTool } from "./search-legislation";
export type { LegislationToolItem, LegislationToolOutput } from "./search-legislation";
export { legislationToolOutputSchema } from "./search-legislation";
export { getOrdinanceSectionTool } from "./get-ordinance-section";
export type { OrdinanceSectionToolOutput } from "./get-ordinance-section";
export { ordinanceSectionToolOutputSchema } from "./get-ordinance-section";
export { getCaseTool } from "./get-case";
export type { CaseToolOutput } from "./get-case";
export { caseToolOutputSchema } from "./get-case";
export { fullSearchTool } from "./full-search";
export type { FullSearchResultItem, FullSearchOutput } from "./full-search";
export { fullSearchOutputSchema, fullSearchResultItemSchema } from "./full-search";
export { askQuestionTool } from "./ask-question";
export type { AskQuestionInput, AskQuestionOutput } from "./ask-question";
export {
	askQuestionInputSchema,
	askQuestionAnswerSchema,
	askQuestionOutputSchema,
} from "./ask-question";
