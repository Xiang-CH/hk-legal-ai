"use client";

import { motion } from "framer-motion";

import { Check, ChevronDownIcon } from "lucide-react";
import { SparklesIcon } from "./icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Markdown } from "./markdown";
import { PreviewAttachment } from "./preview-attachment";
import { cn } from "@/lib/utils";
import { useDevMode } from "@/hooks/use-dev-mode";
import type { MyUIMessage } from "@/lib/types";
import type { AskQuestionOutput } from "@/lib/tools";
import { AskQuestionCard, type AskQuestionPart } from "./ask-question";
// import { Weather } from "./weather";
// import { Citation } from "./citation";

import React from "react";

type MessagePart = MyUIMessage["parts"][number];
type ChatToolPart = Extract<MessagePart, { type: `tool-${string}` }>;

const toolLabels = {
  "tool-search_clic": "Search CLIC articles",
  "tool-search_judgments": "Search case law",
  "tool-search_legislation": "Search legislation",
  "tool-get_ordinance_section": "Read ordinance section",
  "tool-get_case": "Read case details",
  "tool-full_search": "Broad fan-out search",
  "tool-ask_question": "Clarifying question",
} satisfies Record<ChatToolPart["type"], string>;

function isAskQuestionPart(part: MessagePart): part is AskQuestionPart {
  return part.type === "tool-ask_question";
}

function isChatToolPart(part: MessagePart): part is ChatToolPart {
  return (
    part.type === "tool-search_clic" ||
    part.type === "tool-search_judgments" ||
    part.type === "tool-search_legislation" ||
    part.type === "tool-get_ordinance_section" ||
    part.type === "tool-get_case" ||
    part.type === "tool-full_search"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolInput(part: ChatToolPart): Record<string, unknown> | null {
  if (!("input" in part)) return null;
  const input: unknown = (part as { input?: unknown }).input;
  return isRecord(input) ? input : null;
}

function stringField(input: Record<string, unknown> | null, key: string): string | null {
  if (!input) return null;
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Human-readable search keywords / identifiers for the tool call. */
function toolInputSummary(part: ChatToolPart): string | null {
  const input = toolInput(part);
  if (!input) return null;
  switch (part.type) {
    case "tool-search_clic":
    case "tool-search_judgments": {
      const query = stringField(input, "query");
      const topic = stringField(input, "topic");
      if (query && topic) return `${query} · ${topic}`;
      return query;
    }
    case "tool-search_legislation": {
      const bits: string[] = [];
      const keywords = stringField(input, "keywords");
      const cap = stringField(input, "capNumber");
      const section = stringField(input, "sectionNumber");
      if (keywords) bits.push(keywords);
      if (cap || section) bits.push(`Cap ${cap ?? "?"} s.${section ?? "?"}`);
      return bits.length > 0 ? bits.join(" · ") : null;
    }
    case "tool-get_ordinance_section": {
      const cap = stringField(input, "cap_no");
      const section = stringField(input, "section_no");
      if (cap || section) return `Cap ${cap ?? "?"} s.${section ?? "?"}`;
      return null;
    }
    case "tool-get_case": {
      return stringField(input, "action_no") ?? stringField(input, "case_name");
    }
    case "tool-full_search": {
      const raw = input["queries"];
      const queries = Array.isArray(raw) ? raw.filter((q): q is string => typeof q === "string") : [];
      const query = queries[0]?.trim() || null;
      const extra = queries.length > 1 ? ` +${queries.length - 1}` : "";
      const depth = input["searchDepth"];
      if (query && typeof depth === "number") return `${query}${extra} · depth ${depth}`;
      return query ? `${query}${extra}` : null;
    }
    default:
      return null;
  }
}

function toolResultCount(part: ChatToolPart): number | null {
  if (part.state !== "output-available") return null;
  const output: unknown = part.output;
  if (!isRecord(output)) return null;
  if (Array.isArray(output.results)) return output.results.length;
  if (Array.isArray(output.sections)) return output.sections.length;
  if (Array.isArray(output.cases)) {
    return output.cases.reduce((total, item) => {
      if (!isRecord(item) || !Array.isArray(item.judgments)) return total;
      return total + item.judgments.length;
    }, 0);
  }
  return null;
}

function toolState(part: ChatToolPart): { label: string; pending: boolean; failed: boolean } {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return { label: "Searching...", pending: true, failed: false };
    case "approval-requested":
      return { label: "Approval required", pending: true, failed: false };
    case "output-available": {
      const count = toolResultCount(part);
      return {
        label: count === null ? "Completed" : `Completed · ${count} result${count === 1 ? "" : "s"}`,
        pending: false,
        failed: false,
      };
    }
    case "output-error":
      return { label: "Search failed", pending: false, failed: true };
    case "output-denied":
      return { label: "Search denied", pending: false, failed: true };
    case "approval-responded":
      return {
        label: part.approval.approved ? "Approved" : "Search denied",
        pending: false,
        failed: !part.approval.approved,
      };
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

function ToolProgress({ part }: { part: ChatToolPart }) {
  const state = toolState(part);
  const keywords = toolInputSummary(part);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-pending={state.pending}
    >
      {state.pending ? (
        <motion.span
          aria-label="Tool running"
          className="size-1.5 shrink-0 rounded-full bg-primary"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
      ) : (
        <Check className={cn("size-3.5 shrink-0", state.failed && "text-destructive")} />
      )}
      <span className="shrink-0 font-medium">{toolLabels[part.type]}</span>
      {keywords && (
        <span className="min-w-0 flex-1 truncate" title={keywords}>
          &ldquo;{keywords}&rdquo;
        </span>
      )}
      <span className={cn("shrink-0", state.failed && "text-destructive")}>{state.label}</span>
    </div>
  );
}

function ReasoningCard({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  // Collapsed by default; stay open while streaming so live thinking is visible.
  const [expanded, setExpanded] = React.useState(false);
  const open = isStreaming ? true : expanded;
  return (
    <Collapsible
      open={open}
      onOpenChange={setExpanded}
      className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronDownIcon
          className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
          {isStreaming ? "Thinking" : "Reasoning"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <Markdown>{text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

type ReasoningUIPart = Extract<MessagePart, { type: "reasoning" }>;

type RenderItem =
  | { kind: "part"; part: MessagePart; index: number }
  | { kind: "reasoning-group"; parts: ReasoningUIPart[]; startIndex: number };

/** Merge runs of adjacent reasoning parts so multi-step thinking shows as one card. */
function groupConsecutiveReasoning(parts: MessagePart[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part?.type === "reasoning") {
      const group: ReasoningUIPart[] = [];
      const startIndex = i;
      while (i < parts.length && parts[i]?.type === "reasoning") {
        group.push(parts[i] as ReasoningUIPart);
        i += 1;
      }
      if (group.some((p) => p.text.trim().length > 0)) {
        items.push({ kind: "reasoning-group", parts: group, startIndex });
      }
    } else if (part) {
      items.push({ kind: "part", part, index: i });
      i += 1;
    } else {
      i += 1;
    }
  }
  return items;
}

const PreviewMessage = React.forwardRef<
  HTMLDivElement,
  {
    message: MyUIMessage;
    onAnswerQuestion?: (toolCallId: string, output: AskQuestionOutput) => void;
  }
>(({ message, onAnswerQuestion }, ref) => {
  const { isDevMode } = useDevMode();
  if (message.parts.length === 0) return null;

  const textParts = message.parts.filter((part) => part.type === "text");
  const reasoningParts = message.parts.filter((part) => part.type === "reasoning");
  const fileParts = message.parts.filter((part) => part.type === "file");
  const toolParts = message.parts.filter(isChatToolPart);
  const askQuestionParts = message.parts.filter(isAskQuestionPart);
  const hasTextContent = textParts.some((part) => part.text.trim().length > 0);
  const hasReasoningContent = reasoningParts.some((part) => part.text.trim().length > 0);
  const completedToolCount = toolParts.filter((part) => part.state === "output-available").length;

  if (message.role === "user" && !hasTextContent) return null;
  if (
    message.role === "assistant" &&
    !hasTextContent &&
    !hasReasoningContent &&
    toolParts.length === 0 &&
    askQuestionParts.length === 0 &&
    fileParts.length === 0
  ) return null;

  // URL regex pattern
  // const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  // let urlsInContent: { url: string; title: string }[] = [];

  const textContent = message.parts.find(
    (part) => part.type === "text"
  )?.text;
  // if (message.role === "assistant" && textContent) {
  //   const matches = [...textContent.matchAll(urlRegex)];
  //   urlsInContent = matches.map((match) => ({
  //     title: match[1],
  //     url: match[2],
  //   }));
  // }

  return (
    <motion.div
      ref={ref}
      className="w-full min-w-0 mx-auto max-w-3xl px-4 group/message scroll-mt-4"
      initial={{ y: 5, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      data-role={message.role}
    >
      <div
        className={cn(
          "group-data-[role=user]/message:bg-primary group-data-[role=user]/message:text-primary-foreground flex gap-4 group-data-[role=user]/message:px-3 w-full group-data-[role=user]/message:w-fit group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:py-2 rounded-xl"
        )}
      >
        {message.role === "assistant" && (textContent || hasReasoningContent || toolParts.length > 0) && (
          <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-2 w-full">
          {message.role === "user" && textContent && (
            <div className="flex flex-col gap-4">
              <Markdown>{textContent}</Markdown>
            </div>
          )}

          {message.role === "assistant" &&
            groupConsecutiveReasoning(message.parts ?? []).map((item) => {
              if (item.kind === "reasoning-group") {
                return (
                  <ReasoningCard
                    key={`reasoning-${item.startIndex}`}
                    text={item.parts.map((p) => p.text).join("\n\n")}
                    isStreaming={item.parts.some((p) => p.state === "streaming")}
                  />
                );
              }

              const part = item.part;
              const index = item.index;
              if (isAskQuestionPart(part)) {
                return (
                  <AskQuestionCard
                    key={part.toolCallId}
                    part={part}
                    onAnswer={(output) => onAnswerQuestion?.(part.toolCallId, output)}
                  />
                );
              }

              if (isChatToolPart(part)) {
                return <ToolProgress key={part.toolCallId} part={part} />;
              }

              if (part.type === "text") {
                return (
                  <Markdown key={index}>{part.text}</Markdown>
                );
              }
              // else if (part.type === "source") {
              //   return <Citation key={index} title={part.title || ""} url={part.url} />;
              // }
              else if (part.type === "file") {
                return (
                  <PreviewAttachment
                    key={part.url}
                    attachment={part}
                  />
                );
              }
              return null;
            })}

          {message.role === "assistant" && toolParts.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Search progress: {completedToolCount}/{toolParts.length} completed
            </div>
          )}

          {/* Display usage information if available */}
          {message.role === "assistant" && isDevMode && message.metadata?.usage && (
            <div className="flex gap-2 w-full max-w-full flex-wrap text-gray-500 text-xs mt-2">

              <span>Input Tokens: {message.metadata.usage.inputTokens}</span>
              <span>Uncached Input: {message.metadata.usage.uncachedInputTokens ?? 0} (${(message.metadata.usage.modelCost?.uncachedInput ?? 0).toFixed(8)})</span>
              {
                (message.metadata.usage.cachedInputTokens ?? 0) > 0 && (
                  <span>Cached Input: {message.metadata.usage.cachedInputTokens} (${(message.metadata.usage.modelCost?.cachedInput ?? 0).toFixed(8)})</span>
                )
              }
              {
                (message.metadata.usage.cacheWriteTokens ?? 0) > 0 && (
                  <span>Cache Writes: {message.metadata.usage.cacheWriteTokens} (${(message.metadata.usage.modelCost?.cacheWrite ?? 0).toFixed(8)})</span>
                )
              }
              <span>Output Tokens: {message.metadata.usage.outputTokens} (${(message.metadata.usage.modelCost?.output ?? 0).toFixed(8)})</span>
              {
                (message.metadata.usage.reasoningTokens ?? 0) > 0 && (
                  <span>Reasoning Tokens: {message.metadata.usage.reasoningTokens} (included in output)</span>
                )
              }
              {
                message.metadata.usage.rerankCalls != null && message.metadata.usage.rerankCalls > 0 && (
                  <span>Rerank: {message.metadata.usage.rerankCalls} calls / {message.metadata.usage.rerankDocuments ?? 0} docs (${(message.metadata.usage.rerankCost ?? 0).toFixed(8)})</span>
                )
              }
              <span>Total Tokens: {message.metadata.usage.totalTokens}</span>
              <span>Total Cost: ${((message.metadata.usage.modelCost?.total ?? message.metadata.usage.foundryCost ?? 0) + (message.metadata.usage.rerankCost ?? 0)).toFixed(8)}</span>
            </div>
          )}

          {/* {message.role === "assistant" && urlsInContent && (
            <div className="flex gap-2 w-full max-w-full flex-wrap">
              {urlsInContent.map((citation, index) => (
                <Citation
                  key={index}
                  title={citation.title}
                  url={citation.url}
                />
              ))}
            </div>
          )} */}

        </div>
      </div>
    </motion.div>
  );
});
PreviewMessage.displayName = "PreviewMessage";

export { PreviewMessage };

export const ThinkingMessage = ({
  query,
}: {
  query: string | null | undefined;
}) => {
  const role = "assistant";

  return (
    <motion.div
      className="w-full min-w-0 mx-auto max-w-3xl px-4 group/message "
      initial={{ y: 5, opacity: 0 }}
      animate={{ y: 0, opacity: 1, transition: { delay: 1 } }}
      data-role={role}
    >
      <div
        className={cn(
          "flex gap-4 group-data-[role=user]/message:px-3 w-full group-data-[role=user]/message:w-fit group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:py-2 rounded-xl",
          {
            "group-data-[role=user]/message:bg-muted": true,
          }
        )}
      >
        <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border">
          <SparklesIcon size={14} />
        </div>

        <div className="flex min-w-0 flex-col gap-2 w-full">
          <div className="flex min-w-0 flex-col text-muted-foreground">
            {query ? (
              <motion.span
                initial={{ opacity: 0.2 }}
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                Searching for: {query}
              </motion.span>
            ) : (
              <motion.span
                initial={{ opacity: 0.2 }}
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                Thinking...
              </motion.span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
};
