import { ToolLoopAgent, stepCountIs } from "ai";

import { azure } from "@/lib/clic-api";
import { searchPrompt } from "@/lib/prompts";
import { searchTools } from "@/lib/tools";

export const DEFAULT_AGENT_MAX_STEPS = 5;
export const AGENT_MAX_STEPS_CAP = 8;

export function createChatAgent(maxSteps: number) {
  return new ToolLoopAgent({
    model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
    instructions: searchPrompt,
    allowSystemInMessages: true,
    tools: searchTools,
    stopWhen: stepCountIs(maxSteps),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= maxSteps - 1
        ? {
            activeTools: [],
            toolChoice: "none",
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

export function createLegacyChatAgent() {
  return new ToolLoopAgent({
    model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
    instructions: searchPrompt,
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
