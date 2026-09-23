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
import { searchClicTool } from "./search-clic";
import { searchJudgmentsTool } from "./search-judgments";
import { searchLegislationTool } from "./search-legislation";
import { getOrdinanceSectionTool } from "./get-ordinance-section";
import { getCaseTool } from "./get-case";
import { fullSearchTool } from "./full-search";
import { askQuestionTool } from "./ask-question";

/** Tool set for the agent loop. Keys are the model-visible names. */
export const searchTools = {
	search_clic: searchClicTool,
	search_judgments: searchJudgmentsTool,
	search_legislation: searchLegislationTool,
	get_ordinance_section: getOrdinanceSectionTool,
	get_case: getCaseTool,
	full_search: fullSearchTool,
	ask_question: askQuestionTool,
};

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
