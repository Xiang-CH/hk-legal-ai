"use client";

import { motion } from "framer-motion";

import { SparklesIcon } from "./icons";
import { Markdown } from "./markdown";
import { PreviewAttachment } from "./preview-attachment";
import { cn } from "@/lib/utils";
import { useDevMode } from "@/hooks/use-dev-mode";
import type { MyUIMessage } from "@/lib/types";
import { inputCostPerToken, outputCostPerToken, cachedInputCostPerToken } from "@/lib/pricing";
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
} satisfies Record<ChatToolPart["type"], string>;

function isChatToolPart(part: MessagePart): part is ChatToolPart {
  return (
    part.type === "tool-search_clic" ||
    part.type === "tool-search_judgments" ||
    part.type === "tool-search_legislation" ||
    part.type === "tool-get_ordinance_section" ||
    part.type === "tool-get_case"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-sm"
      data-pending={state.pending}
    >
      <div className="min-w-0">
        <div className="font-medium">{toolLabels[part.type]}</div>
        <div className={state.failed ? "text-destructive" : "text-muted-foreground"}>
          {state.label}
        </div>
      </div>
      {state.pending && (
        <motion.span
          aria-label="Tool running"
          className="size-2 shrink-0 rounded-full bg-primary"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
      )}
    </div>
  );
}

const PreviewMessage = React.forwardRef<
  HTMLDivElement,
  {
    message: MyUIMessage;
  }
>(({ message }, ref) => {
  const { isDevMode } = useDevMode();
  if (message.parts.length === 0) return null;

  const textParts = message.parts.filter((part) => part.type === "text");
  const reasoningParts = message.parts.filter((part) => part.type === "reasoning");
  const fileParts = message.parts.filter((part) => part.type === "file");
  const toolParts = message.parts.filter(isChatToolPart);
  const hasTextContent = textParts.some((part) => part.text.trim().length > 0);
  const hasReasoningContent = reasoningParts.some((part) => part.text.trim().length > 0);
  const completedToolCount = toolParts.filter((part) => part.state === "output-available").length;

  if (message.role === "user" && !hasTextContent) return null;
  if (
    message.role === "assistant" &&
    !hasTextContent &&
    !hasReasoningContent &&
    toolParts.length === 0 &&
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
      className="w-full mx-auto max-w-3xl px-4 group/message scroll-mt-4"
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

        <div className="flex flex-col gap-2 w-full">
          {message.role === "user" && textContent && (
            <div className="flex flex-col gap-4">
              <Markdown>{textContent}</Markdown>
            </div>
          )}

          {message.role === "assistant" &&
            message.parts?.map((part, index) => {
              if (isChatToolPart(part)) {
                return <ToolProgress key={part.toolCallId} part={part} />;
              }

              if (part.type === "reasoning" && part.text.trim().length > 0) {
                const isStreaming = part.state === "streaming";

                return (
                  <div
                    key={`${part.type}-${index}`}
                    className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
                  >
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {isStreaming ? "Thinking" : "Reasoning summary"}
                    </div>
                    <Markdown>{part.text}</Markdown>
                  </div>
                );
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

              <span>Input Tokens: {message.metadata.usage.inputTokens} (${((message.metadata.usage.inputTokens ?? 0) * inputCostPerToken).toFixed(8)})</span>
              <span>Output Tokens: {message.metadata.usage.outputTokens} (${((message.metadata.usage.outputTokens ?? 0) * outputCostPerToken).toFixed(8)})</span>
              {
                message.metadata.usage.cachedInputTokens && message.metadata.usage.cachedInputTokens > 0 && (
                  <span>Cached Input Tokens: {message.metadata.usage.cachedInputTokens} (${(message.metadata.usage.cachedInputTokens * cachedInputCostPerToken).toFixed(8)})</span>
              )}
              {
                message.metadata.usage.reasoningTokens && message.metadata.usage.reasoningTokens > 0 && (
                  <span>Reasoning Tokens: {message.metadata.usage.reasoningTokens} (${(message.metadata.usage.reasoningTokens * outputCostPerToken).toFixed(8)})</span>
                )
              }
              {
                message.metadata.usage.rerankCalls != null && message.metadata.usage.rerankCalls > 0 && (
                  <span>Rerank: {message.metadata.usage.rerankCalls} calls / {message.metadata.usage.rerankDocuments ?? 0} docs (${(message.metadata.usage.rerankCost ?? 0).toFixed(8)})</span>
                )
              }
              <span>Total Tokens: {message.metadata.usage.totalTokens}</span>
              <span>Total Cost: ${(((message.metadata.usage.inputTokens ?? 0) * inputCostPerToken) + ((message.metadata.usage.outputTokens ?? 0) * outputCostPerToken) + ((message.metadata.usage.cachedInputTokens ?? 0) * cachedInputCostPerToken) + (message.metadata.usage.rerankCost ?? 0)).toFixed(8)}</span>
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
      className="w-full mx-auto max-w-3xl px-4 group/message "
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

        <div className="flex flex-col gap-2 w-full">
          <div className="flex flex-col text-muted-foreground">
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
