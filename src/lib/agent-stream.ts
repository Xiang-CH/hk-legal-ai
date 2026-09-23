import type { InferUIMessageChunk, LanguageModelUsage, TextStreamPart } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse, toUIMessageStream } from "ai";

import { langfuseSpanProcessor } from "@/instrumentation";
import type { ChatAgent } from "@/lib/chat-agent";
import { calculateGpt6LunaCost } from "@/lib/pricing";
import {
  caseToolOutputSchema,
  clicToolOutputSchema,
  judgmentToolOutputSchema,
  legislationToolOutputSchema,
  fullSearchOutputSchema,
  ordinanceSectionToolOutputSchema,
  searchTools,
} from "@/lib/tools";
import type { MyMetadata, MyUIMessage } from "@/lib/types";
import { z } from "zod";

type ChatChunk = InferUIMessageChunk<MyUIMessage>;
export type TraceCompletion = (result: { output: string; error?: unknown }) => void;
type AgentTextChunk = TextStreamPart<typeof searchTools>;
type SourceChunk = Extract<ChatChunk, { type: "source-url" }>;
type SearchToolName =
  | "search_clic"
  | "search_judgments"
  | "search_legislation"
  | "get_ordinance_section"
  | "get_case"
  | "full_search";

const sourceMetadataSchema = z.strictObject({
  rrf_score: z.number().nullable(),
  rerank_score: z.number().nullable(),
  snippet: z.string(),
});

type SourceSeed = Omit<SourceChunk, "providerMetadata"> & {
  providerMetadata: { custom: z.infer<typeof sourceMetadataSchema> };
};

function source({
  sourceId,
  url,
  title,
  rrfScore,
  rerankScore,
  snippet,
  baseUrl = "https://clic.org.hk",
}: {
  sourceId: string;
  url: string;
  title: string;
  rrfScore: number | null;
  rerankScore: number | null;
  snippet: string;
  baseUrl?: string;
}): SourceSeed | null {
  let normalizedUrl: URL;
  try {
    normalizedUrl = new URL(url, baseUrl);
  } catch {
    return null;
  }
  if (normalizedUrl.protocol !== "http:" && normalizedUrl.protocol !== "https:") return null;
  return {
    type: "source-url",
    sourceId,
    url: normalizedUrl.toString(),
    title,
    providerMetadata: {
      custom: {
        rrf_score: rrfScore,
        rerank_score: rerankScore,
        snippet,
      },
    },
  };
}

export function mapToolOutputToSources(toolName: SearchToolName, output: unknown): SourceSeed[] {
  switch (toolName) {
    case "search_clic": {
      const parsed = clicToolOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      return parsed.data.results.flatMap((item) => {
        const mapped = source({
          sourceId: `clic-${item.nid}-${item.chunk_no}`,
          url: item.url,
          title: item.title,
          rrfScore: item.rrf_score,
          rerankScore: item.rerank_score,
          snippet: item.snippet,
        });
        return mapped ? [mapped] : [];
      });
    }
    case "search_judgments": {
      const parsed = judgmentToolOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      return parsed.data.results.flatMap((item) => {
        if (!item.url) return [];
        const mapped = source({
          sourceId: `judgment-${item.judgmentId}-${item.chunk_no}`,
          url: item.url,
          title: item.neutralCitation ?? item.courtName ?? `Judgment ${item.judgmentId}`,
          rrfScore: item.rrf_score,
          rerankScore: item.rerank_score,
          snippet: item.snippet,
          baseUrl: "https://hklii.hk",
        });
        return mapped ? [mapped] : [];
      });
    }
    case "search_legislation": {
      const parsed = legislationToolOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      const seen = new Set<string>();
      return parsed.data.results.flatMap((item) => {
        const sourceId = `cap-${item.capNumber}-${item.sectionNumber}`;
        if (seen.has(sourceId)) return [];
        seen.add(sourceId);
        const mapped = source({
          sourceId,
          url: item.url,
          title: `Cap ${item.capNumber}, section ${item.sectionNumber}${item.heading ? `: ${item.heading}` : ""}`,
          rrfScore: item.rrf_score,
          rerankScore: item.rerank_score,
          snippet: item.snippet,
        });
        return mapped ? [mapped] : [];
      });
    }
    case "full_search": {
      const parsed = fullSearchOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      const seeds: SourceSeed[] = [];
      for (const item of parsed.data.results) {
        let seed: SourceSeed | null = null;
        if (item.kind === "clic") {
          seed = source({
            sourceId: `clic-${item.nid}-${item.chunk_no}`,
            url: item.url,
            title: item.title,
            rrfScore: item.rrf_score,
            rerankScore: item.rerank_score,
            snippet: item.snippet,
          });
        } else if (item.kind === "judgment") {
          if (!item.url) continue;
          seed = source({
            sourceId: `judgment-${item.judgmentId}-${item.chunk_no}`,
            url: item.url,
            title: item.neutralCitation ?? item.courtName ?? `Judgment ${item.judgmentId}`,
            rrfScore: item.rrf_score,
            rerankScore: item.rerank_score,
            snippet: item.snippet,
            baseUrl: "https://hklii.hk",
          });
        } else {
          seed = source({
            sourceId: `cap-${item.capNumber}-${item.sectionNumber}`,
            url: item.url,
            title: `Cap ${item.capNumber}, section ${item.sectionNumber}${item.heading ? `: ${item.heading}` : ""}`,
            rrfScore: item.rrf_score,
            rerankScore: item.rerank_score,
            snippet: item.snippet,
          });
        }
        if (seed) seeds.push(seed);
      }
      return seeds;
    }
    case "get_ordinance_section": {
      const parsed = ordinanceSectionToolOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      const data = parsed.data;
      const sourceId = `cap-${data.cap_no}-${data.section_no}`;
      return data.sections.flatMap((item) => {
        const mapped = source({
          sourceId,
          url: item.url,
          title: `Cap ${data.cap_no}, section ${data.section_no}${data.capTitle ? `: ${data.capTitle}` : ""}`,
          rrfScore: null,
          rerankScore: null,
          snippet: item.heading ?? item.content.slice(0, 240),
        });
        return mapped ? [mapped] : [];
      });
    }
    case "get_case": {
      const parsed = caseToolOutputSchema.safeParse(output);
      if (!parsed.success || "error" in parsed.data) return [];
      return parsed.data.cases.flatMap((item) =>
        item.judgments.flatMap((judgment) => {
          const mapped = source({
            sourceId: `judgment-${judgment.id}-${judgment.chunk_no}`,
            url: judgment.url,
            title: judgment.neutralCitation || item.title,
            rrfScore: null,
            rerankScore: null,
            snippet: judgment.summary ?? item.title,
            baseUrl: "https://hklii.hk",
          });
          return mapped ? [mapped] : [];
        }),
      );
    }
    default: {
      const exhaustive: never = toolName;
      return exhaustive;
    }
  }
}

function optionalTokenCount(value: number | undefined): number {
  return value ?? 0;
}

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
    totalTokens: 0,
  };
}

function toMetadata({
  maxSteps,
  stepCount,
  toolCallCount,
  usage,
}: {
  maxSteps: number;
  stepCount: number;
  toolCallCount: number;
  usage: LanguageModelUsage;
}): MyMetadata {
  const cost = calculateGpt6LunaCost(usage);

  return {
    searchMode: "agent",
    maxSteps,
    stepCount,
    toolCallCount,
    usage: {
      inputTokens: cost.totalInputTokens,
      uncachedInputTokens: cost.uncachedInputTokens,
      cachedInputTokens: cost.cachedInputTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      outputTokens: cost.outputTokens,
      totalTokens: optionalTokenCount(usage.totalTokens),
      reasoningTokens: cost.reasoningTokens,
      modelCost: {
        longContext: cost.longContext,
        uncachedInput: cost.uncachedInputCost,
        cachedInput: cost.cachedInputCost,
        cacheWrite: cost.cacheWriteCost,
        output: cost.outputCost,
        total: cost.totalCost,
      },
      foundryCost: cost.totalCost,
    },
  };
}

export async function createAgenticChatResponse({
  agent,
  messages,
  maxSteps,
  abortSignal,
  onTraceComplete,
}: {
  agent: ChatAgent;
  messages: MyUIMessage[];
  maxSteps: number;
  abortSignal?: AbortSignal;
  onTraceComplete: TraceCompletion;
}): Promise<Response> {
  let usage = emptyUsage();
  let stepCount = 0;
  let metadataSent = false;
  let outputText = "";
  let streamError: unknown;
  const toolNamesByCallId = new Map<string, SearchToolName>();
  const emittedSourceIds = new Set<string>();

  const modelMessages = await convertToModelMessages(messages, { tools: agent.tools });
  const result = await agent.stream({
    prompt: modelMessages,
    abortSignal,
  });

  const trackedStream = result.stream.pipeThrough(
    new TransformStream<AgentTextChunk, AgentTextChunk>({
      transform(chunk, controller) {
        if (chunk.type === "start-step") {
          stepCount += 1;
        }
        if (chunk.type === "text-delta") {
          outputText += chunk.text;
        }
        if (chunk.type === "error") {
          streamError = chunk.error;
        }
        if (chunk.type === "finish") {
          usage = chunk.totalUsage;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  const upstream = toUIMessageStream<typeof searchTools, MyUIMessage>({
    stream: trackedStream,
    tools: searchTools,
    sendReasoning: true,
    sendSources: false,
  });

  const transformed = upstream.pipeThrough(
    new TransformStream<ChatChunk, ChatChunk>({
      transform(chunk, controller) {
        switch (chunk.type) {
          case "tool-input-start":
          case "tool-input-available":
          case "tool-input-error": {
            if (isSearchToolName(chunk.toolName)) {
              toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
            }
            break;
          }
          case "tool-output-available": {
            const toolName = toolNamesByCallId.get(chunk.toolCallId);
            if (toolName) {
              for (const sourcePart of mapToolOutputToSources(toolName, chunk.output)) {
                if (emittedSourceIds.has(sourcePart.sourceId)) continue;
                emittedSourceIds.add(sourcePart.sourceId);
                controller.enqueue(sourcePart);
              }
            }
            break;
          }
          case "finish": {
            metadataSent = true;
            controller.enqueue({
              type: "message-metadata",
              messageMetadata: toMetadata({
                maxSteps,
                stepCount: Math.max(stepCount, 1),
                toolCallCount: toolNamesByCallId.size,
                usage,
              }),
            });
            break;
          }
          default:
            break;
        }

        controller.enqueue(chunk);
      },
      async flush(controller) {
        if (!metadataSent) {
          controller.enqueue({
            type: "message-metadata",
            messageMetadata: toMetadata({
              maxSteps,
              stepCount: Math.max(stepCount, 1),
              toolCallCount: toolNamesByCallId.size,
              usage,
            }),
          });
        }
        onTraceComplete({
          output: outputText,
          ...(streamError === undefined ? {} : { error: streamError }),
        });
        await langfuseSpanProcessor.forceFlush();
      },
    }),
  );

  return createUIMessageStreamResponse({ stream: transformed });
}

function isSearchToolName(value: string): value is SearchToolName {
  return (
    value === "search_clic" ||
    value === "search_judgments" ||
    value === "search_legislation" ||
    value === "get_ordinance_section" ||
    value === "get_case" ||
    value === "full_search"
  );
}
