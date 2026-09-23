import { tool } from "ai";
import { z } from "zod";

/* ---------------------------------------------------------------------------
 * ask_question — human-in-the-loop clarification tool (client-executed).
 *
 * Unlike the search_* tools above, this tool has NO server `execute` function.
 * When the model calls it, the ToolLoopAgent stops the loop and streams the
 * tool input to the client; the UI renders the questions with the suggested
 * options plus a free-text field, and the user's answers are submitted back
 * via `addToolResult`, which automatically resumes the agent.
 * ------------------------------------------------------------------------- */

const askQuestionOptionSchema = z.object({
	label: z.string().min(1).max(80).describe("Short suggested answer label shown as a clickable option."),
	description: z.string().max(200).optional().describe("One-line explanation of what this option means."),
});

const askQuestionItemSchema = z.object({
	question: z.string().min(1).max(500).describe("The clarification question to show the user."),
	header: z.string().max(24).optional().describe("Very short topic label for the question, e.g. 'Employment status'."),
	multiSelect: z.boolean().optional().describe("Set true when the user may pick more than one option. Defaults to single-select."),
	options: z
		.array(askQuestionOptionSchema)
		.min(2)
		.max(4)
		.optional()
		.describe("2-4 suggested answer options. The user can always type their own response instead."),
});

export const askQuestionInputSchema = z.object({
	questions: z.array(askQuestionItemSchema).min(1).max(4).describe("1-4 clarification questions. Ask only what blocks progress."),
});
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;

export const askQuestionAnswerSchema = z.object({
	question: z.string().min(1).describe("The question being answered (copied from the input)."),
	answer: z.string().min(1).max(2000).describe("The user's answer: selected option label(s) and/or their own words."),
});

export const askQuestionOutputSchema = z.object({
	answers: z.array(askQuestionAnswerSchema).min(1).describe("One entry per answered question."),
});
export type AskQuestionOutput = z.infer<typeof askQuestionOutputSchema>;

export const askQuestionTool = tool({
	description:
		"Ask the user clarification questions when their request is ambiguous and you cannot proceed reliably. " +
		"Provide 2-4 suggested options per question where possible; the user can always type their own response instead. " +
		"Call this INSTEAD of guessing, then wait for the answers before searching or answering. " +
		"Use at most 4 questions and only for details that change the legal answer.",
	inputSchema: askQuestionInputSchema,
	outputSchema: askQuestionOutputSchema,
	// No `execute`: this is a client (human-in-the-loop) tool. The agent loop
	// pauses until the UI submits the user's answers via addToolResult.
});
