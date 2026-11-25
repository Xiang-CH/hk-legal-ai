import { ToolLoopAgent, stepCountIs } from "ai";

import { azure } from "@/lib/clic-api";
import { searchPrompt } from "@/lib/prompts";
import { searchTools } from "@/lib/tools";
import { createSearchClicTool } from "@/lib/tools/search-clic";
import { createFullSearchTool } from "@/lib/tools/full-search";
import { createSearchLegislationTool } from "@/lib/tools/search-legislation";
import { createSearchJudgmentsTool } from "@/lib/tools/search-judgments";
import type { JudgmentSearchDebugSink } from "@/lib/types";

export const DEFAULT_AGENT_MAX_STEPS = 5;
export const AGENT_MAX_STEPS_CAP = 8;

export function createChatAgent(maxSteps: number, instructions: string = searchPrompt, onJudgmentSearchDebug?: JudgmentSearchDebugSink) {
  return new ToolLoopAgent({
    model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
    instructions,
    allowSystemInMessages: true,
    tools: onJudgmentSearchDebug
      ? {
          ...searchTools,
          search_clic: createSearchClicTool(onJudgmentSearchDebug),
          search_judgments: createSearchJudgmentsTool(onJudgmentSearchDebug),
          search_legislation: createSearchLegislationTool(onJudgmentSearchDebug),
          full_search: createFullSearchTool(onJudgmentSearchDebug),
        }
      : searchTools,
    stopWhen: stepCountIs(maxSteps),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= maxSteps - 1
        ? {
            activeTools: [],
            toolChoice: "none",
            instructions: `${instructions}\n\nWrite the final answer from the evidence already collected. Tools are unavailable in this step. Keep tool arguments and search requests out of the answer.`,
          }
        : undefined,
    experimental_telemetry: { isEnabled: true },
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
      },
    },
  });
}

export type ChatAgent = ReturnType<typeof createChatAgent>;

export function createLegacyChatAgent(instructions: string = searchPrompt) {
  return new ToolLoopAgent({
    model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
    instructions,
    allowSystemInMessages: true,
    tools: {},
    stopWhen: stepCountIs(1),
    experimental_telemetry: { isEnabled: true },
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
      },
    },
  });
}
