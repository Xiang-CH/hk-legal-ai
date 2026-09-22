import { ToolLoopAgent } from "ai";

import { azure } from "@/app/api/chat/helper";
import { searchPrompt } from "@/lib/prompts";

/**
 * T16 baseline: one model step and no tools, matching the legacy route exactly.
 * T13 can add the T12 search tools and a multi-step stop condition here.
 */
export const chatAgent = new ToolLoopAgent({
  model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
  instructions: searchPrompt,
  allowSystemInMessages: true,
  tools: {},
  experimental_telemetry: { isEnabled: true },
  providerOptions: {
    openai: {
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    },
  },
});
