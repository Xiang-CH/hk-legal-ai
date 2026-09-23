import type { DataUIPart, InferAgentUIMessage } from "ai";
import { z } from "zod";

import type { ChatAgent } from "@/lib/chat-agent";

const clicSchema = z.object({
  nid: z.number(),
  title: z.string(),
  content: z.string(),
  url: z.string(),
  topic: z.string(),
  chunk_no: z.number(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  caption: z.string().optional(),
  lexical_rank: z.number().nullable().optional(),
  vector_distance: z.number().nullable().optional(),
  rrf_score: z.number().optional(),
  rerank_score: z.number().nullable().optional(),
  snippet: z.string().optional(),
});
export type ClicPage = z.infer<typeof clicSchema>;

const legislationSchema = z.object({
  capNumber: z.string(),
  sectionNumber: z.string(),
  subsectionNumber: z.string().optional(),
  capTitle: z.string(),
  sectionHeading: z.string(),
  content: z.string(),
  url: z.string(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  lexical_rank: z.number().nullable().optional(),
  vector_distance: z.number().nullable().optional(),
  rrf_score: z.number().optional(),
  rerank_score: z.number().nullable().optional(),
  snippet: z.string().optional(),
});
export type LegislationSection = z.infer<typeof legislationSchema>;

const judgmentSummarySchema = z.object({
  judgmentId: z.number(),
  chunk_no: z.number(),
  neutralCitation: z.string(),
  courtName: z.string(),
  year: z.number(),
  date: z.string(),
  parties: z.string().nullable(),
  summary: z.string(),
  summarySource: z.string().nullable(),
  url: z.string(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  caption: z.string().optional(),
  lexical_rank: z.number().nullable().optional(),
  vector_distance: z.number().nullable().optional(),
  rrf_score: z.number().optional(),
  rerank_score: z.number().nullable().optional(),
  snippet: z.string().optional(),
});
export type JudgmentSummary = z.infer<typeof judgmentSummarySchema>;

const modelCostSchema = z.object({
  longContext: z.boolean(),
  uncachedInput: z.number(),
  cachedInput: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  total: z.number(),
});

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  uncachedInputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  modelCost: modelCostSchema.optional(),
  rerankCalls: z.number().optional(),
  rerankDocuments: z.number().optional(),
  rerankCost: z.number().optional(),
  foundryCost: z.number().optional(),
});

export const metadataSchema = z.object({
  searchMode: z.enum(["agent", "legacy"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
  searchQuery: z.string().optional(),
  groundings: z.unknown().optional(),
  searchQueries: z.array(z.string()).optional(),
  usage: usageSchema.optional(),
});

export type MyMetadata = z.infer<typeof metadataSchema>;

const notificationSchema = z.object({
  type: z.literal("notification"),
  message: z.string(),
  level: z.enum(["info", "warning", "error"]),
});

export const chatDataSchemas = {
  notification: notificationSchema,
} as const;

type ChatDataParts = {
  notification: z.infer<typeof notificationSchema>;
};

type ChatAgentUIMessage = InferAgentUIMessage<ChatAgent, MyMetadata>;
type ChatAgentUIPart = ChatAgentUIMessage["parts"][number];
type NonDataAgentPart<PART> = PART extends { type: `data-${string}` }
  ? never
  : PART;

export type MyUIMessage = Omit<ChatAgentUIMessage, "parts"> & {
  parts: Array<NonDataAgentPart<ChatAgentUIPart> | DataUIPart<ChatDataParts>>;
};
