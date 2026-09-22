import type { DataUIPart, InferAgentUIMessage } from "ai";
import z from 'zod';

const clicSchema = z.object({
  nid: z.number(),
  title: z.string(),
  content: z.string(),
  url: z.string(),
  topic: z.string(),
  chunk_no: z.number(),
  // T11: legacy Azure Search aliases — read-only compat fallback for older
  // writers. New contract is { rrf_score, rerank_score, snippet } below.
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  caption: z.string().optional(),
  captionHighlights: z.string().optional(),
  // T08 pg fusion extras (score carries rrf_score, caption carries snippet)
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
  // T11: legacy Azure Search aliases — compat fallback only.
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  // T08 pg fusion extras
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
  // T11: legacy Azure Search aliases — read-only compat fallback (score ~= rrf,
  // caption ~= snippet). captionHighlights is dead, never written since T08.
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  caption: z.string().optional(),
  captionHighlights: z.string().optional(),
  // T08 pg fusion extras (score carries rrf_score, caption carries snippet)
  lexical_rank: z.number().nullable().optional(),
  vector_distance: z.number().nullable().optional(),
  rrf_score: z.number().optional(),
  rerank_score: z.number().nullable().optional(),
  snippet: z.string().optional(),
});
export type JudgmentSummary = z.infer<typeof judgmentSummarySchema>;

const judgementSchema = z.object({
  case_name: z.string(),
  court: z.string(),
  date: z.string(),
  case_summary: z.string(),
  case_causes: z.string(),
  court_decision: z.string(),
  url: z.string(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
});

export const groundingsSchema = z.object({
  legislation: z.array(legislationSchema),
  judgement: z.array(judgementSchema),
  clicPages: z.array(clicSchema),
});

export type Groundings = z.infer<typeof groundingsSchema>;

const metadataSchema = z.object({
  searchQuery: z.string().optional(),
  groundings: groundingsSchema.optional(),
  searchQueries: z.array(z.string()).optional(),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    // T09 rerank accounting (server-computed; cost needs RERANK_COST_PER_CALL)
    rerankCalls: z.number().optional(),
    rerankDocuments: z.number().optional(),
    rerankCost: z.number().optional(),
  }).optional(),
});

export type MyMetadata = z.infer<typeof metadataSchema>;

type MyDataParts = {
  data: {
    type: "notification";
    message: string;
    level: "info" | "warning" | "error";
  };
};

type ChatAgentUIMessage = InferAgentUIMessage<
  (typeof import("@/lib/chat-agent"))["chatAgent"],
  MyMetadata
>;
type ChatAgentUIPart = ChatAgentUIMessage["parts"][number];
type NonDataAgentPart<PART> = PART extends { type: `data-${string}` }
  ? never
  : PART;

export type MyUIMessage = Omit<ChatAgentUIMessage, "parts"> & {
  parts: Array<
    NonDataAgentPart<ChatAgentUIPart> | DataUIPart<MyDataParts>
  >;
};
