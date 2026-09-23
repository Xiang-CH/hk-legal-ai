import type { LanguageModelUsage } from "ai";

const TOKENS_PER_MILLION = 1_000_000;
// Prompts above 272K input tokens use the long-context tier for the full request.
// https://developers.openai.com/api/docs/models/gpt-6-luna
const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

// Standard processing prices for gpt-6-luna, in USD per 1M tokens.
// https://developers.openai.com/api/docs/pricing
const shortContextRates = {
  uncachedInput: 0.1,
  cachedInput: 0.01,
  cacheWrite: 0.125,
  output: 0.5,
} as const;

const longContextRates = {
  uncachedInput: 0.2,
  cachedInput: 0.02,
  cacheWrite: 0.25,
  output: 0.75,
} as const;

export type Gpt6LunaCostBreakdown = {
  totalInputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  longContext: boolean;
  uncachedInputCost: number;
  cachedInputCost: number;
  cacheWriteCost: number;
  outputCost: number;
  totalCost: number;
};

function tokenCount(value: number | undefined): number {
  return value ?? 0;
}

function calculateTokenCost(tokens: number, rate: number): number {
  return (tokens * rate) / TOKENS_PER_MILLION;
}

export function calculateGpt6LunaCost(
  usage: LanguageModelUsage,
): Gpt6LunaCostBreakdown {
  const totalInputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.inputTokenDetails.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.inputTokenDetails.cacheWriteTokens);
  const uncachedInputTokens =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(totalInputTokens - cachedInputTokens - cacheWriteTokens, 0);
  const outputTokens = tokenCount(usage.outputTokens);
  const reasoningTokens = tokenCount(usage.outputTokenDetails.reasoningTokens);
  const longContext = totalInputTokens > LONG_CONTEXT_INPUT_THRESHOLD;
  const rates = longContext ? longContextRates : shortContextRates;

  const uncachedInputCost = calculateTokenCost(uncachedInputTokens, rates.uncachedInput);
  const cachedInputCost = calculateTokenCost(cachedInputTokens, rates.cachedInput);
  const cacheWriteCost = calculateTokenCost(cacheWriteTokens, rates.cacheWrite);
  const outputCost = calculateTokenCost(outputTokens, rates.output);

  return {
    totalInputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    longContext,
    uncachedInputCost,
    cachedInputCost,
    cacheWriteCost,
    outputCost,
    totalCost: uncachedInputCost + cachedInputCost + cacheWriteCost + outputCost,
  };
}
