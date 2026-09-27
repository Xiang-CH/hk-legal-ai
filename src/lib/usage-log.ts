/**
 * Anonymous chat usage logging.
 *
 * One row per chat turn in `chat_usage_events`: usage metrics plus the question
 * and answer text, chained within a conversation via `sessionId` + `turnIndex`.
 * The IP is never stored raw, only as an HMAC-SHA256 hash.
 *
 * Enabled in production only, so local/dev turns are never persisted. Set
 * `USAGE_LOG_IP_SALT` in production to keep the IP hash unguessable.
 */
import { createHmac } from "node:crypto";

import { prisma } from "@/lib/prisma";

export interface ChatUsageLogInput {
  sessionId: string;
  question: string;
  answer: string;
  searchMode: "agent" | "legacy";
  model: string;
  stepCount: number;
  toolCallCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  ip: string | null;
  userAgent: string | null;
  domain: string | null;
}

/** Usage logging is production-only. */
export function usageLoggingEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.USAGE_LOG_IP_SALT ?? "";
  return createHmac("sha256", salt).update(ip).digest("hex");
}

/** First client hop from the proxy chain, then common platform fallbacks. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get("x-azure-clientip") ??
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    null
  );
}

/** Domain the app is served on, as seen by the client. */
export function domainFromHeaders(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  return host.split(",")[0]?.trim() || null;
}

/**
 * Append one turn to the session log. Never throws: a logging failure must not
 * affect the chat response. `turnIndex` is assigned here (previous + 1); the
 * unique index on (sessionId, turnIndex) guards concurrent turns, so a losing
 * write retries against a fresh read.
 */
export async function recordChatUsage(input: ChatUsageLogInput): Promise<void> {
  if (!usageLoggingEnabled()) return;

  const ipHash = hashIp(input.ip);
  const base = {
    ipHash,
    userAgent: input.userAgent,
    domain: input.domain,
    searchMode: input.searchMode,
    model: input.model,
    stepCount: input.stepCount,
    toolCallCount: input.toolCallCount,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    costUsd: input.costUsd,
    latencyMs: input.latencyMs,
    question: input.question,
    answer: input.answer,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const previous = await tx.chatUsageEvent.findFirst({
          where: { sessionId: input.sessionId },
          orderBy: { turnIndex: "desc" },
          select: { id: true, turnIndex: true },
        });
        await tx.chatUsageEvent.create({
          data: {
            ...base,
            sessionId: input.sessionId,
            turnIndex: (previous?.turnIndex ?? 0) + 1,
            previousId: previous?.id ?? null,
          },
        });
      });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "P2002" || attempt === 2) {
        console.error("Failed to record chat usage", error);
        return;
      }
    }
  }
}
