/** Shared budgets, spans, fusion/rerank and fallback helpers for the agent tools. */

import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import { applyRerank } from "@/lib/rerank";

export const TOOL_TIMEOUT_MS = 10_000;
/** Outer budget for full_search: LLM rewrite + 3 embeddings + fan-out + 2 reranks + graph SQL. */
export const FULL_SEARCH_TOOL_TIMEOUT_MS = 60_000;
/** Cap for the cross-query merge entering rerank (mirrors the legacy route). */
export const FULL_SEARCH_MERGE_CAP = 30;
/** Global top-N returned by full_search after the single cross-corpus rerank. */
export const FULL_SEARCH_TOP_N = 10;
/** Rerank budget for the pooled call (up to ~80 candidates in one request). */
export const FULL_SEARCH_RERANK_TIMEOUT_MS = 10_000;
/** Max graph sections entering the pool (deduped, pre-rerank). */
export const FULL_SEARCH_GRAPH_CAP = 20;
/** Rerank input length for legislation graph items (full text via get_ordinance_section). */
export const FULL_SEARCH_RERANK_TEXT_CHARS = 2000;
/** Snippet length for legislation graph items (full text via get_ordinance_section). */
export const FULL_SEARCH_LEGISLATION_SNIPPET_CHARS = 500;
// Primary covers an embedding call + pg fusion + up to RERANK_TIMEOUT_MS of rerank;
// the substring fallback (single indexed query) needs far less, so it gets the remainder.
export const PRIMARY_SEARCH_BUDGET_MS = 7_000;
export const SEARCH_FALLBACK_BUDGET_MS = TOOL_TIMEOUT_MS - PRIMARY_SEARCH_BUDGET_MS - 250;
export const RERANK_TIMEOUT_MS = 4_000;
export const RERANK_TOP_CLIC = 10;
export const RERANK_TOP_JUDGMENT = 8;
export const RERANK_TOP_LEGISLATION = 10;
/** Depth cap for the legislation graph follow-up (section + 1 level of related). */
export const GRAPH_DEPTH_CAP = 2;
export const ALL_CLIC_LANGUAGE_CODES = ["en", "sc", "tc"] as const;

export const CLIC_TOPIC_ALIASES: Readonly<Record<string, string>> = {
	employment: "employmentDisputes",
	tenancy: "landlord_tenant",
	landlord: "landlord_tenant",
	tenant: "landlord_tenant",
	rental: "landlord_tenant",
	housing: "landlord_tenant",
	consumer: "consumer_complaints",
	defamation: "defamation",
	judicialreview: "judicial_review",
};

export type ErrorPayload = { error: string };
export const errorPayloadSchema = z.strictObject({ error: z.string() });

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`[tool] ${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function withSearchFallback<T>(
	primary: () => Promise<T>,
	fallback: () => Promise<T>,
	label: string,
	isUsable: (value: T) => boolean = () => true,
): Promise<T> {
	try {
		const result = await withTimeout(primary(), PRIMARY_SEARCH_BUDGET_MS, `${label} primary`);
		if (isUsable(result)) return result;
	} catch {
		/* fall through to the bounded direct lookup */
	}
	return await withTimeout(fallback(), SEARCH_FALLBACK_BUDGET_MS, `${label} fallback`);
}

export function summarizeForSpan(value: unknown): unknown {
	try {
		return JSON.parse(
			JSON.stringify(value, (_key, v) =>
				typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v,
			),
		);
	} catch {
		return { unserializable: true };
	}
}

export async function withToolSpan<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
	return startActiveObservation(
		name,
		async (span) => {
			span.update({ input: summarizeForSpan(input) });
			const out = await fn();
			span.update({ output: summarizeForSpan(out) });
			return out;
		},
		{ asType: "tool" },
	);
}

export async function fuseRerank<T>(
	query: string,
	items: T[],
	getText: (item: T) => string,
	topN: number,
): Promise<{ item: T; rerank_score: number | null }[]> {
	const fallback = () => items.slice(0, topN).map((item) => ({ item, rerank_score: null }));
	if (items.length === 0) return [];
	try {
		const ranked = await withTimeout(
			applyRerank(query, items, { getText, topN, timeoutMs: RERANK_TIMEOUT_MS }),
			RERANK_TIMEOUT_MS,
			"rerank",
		);
		return ranked.map((r) => ({ item: r.item, rerank_score: r.rerank_score ?? null }));
	} catch {
		return fallback();
	}
}

export function dedupe<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

export function fallbackSearchTerms(query: string): string[] {
	const stopWords = new Set([
		"about", "after", "against", "case", "cases", "court", "courts", "decided",
		"decision", "explain", "find", "from", "have", "hong", "kong", "legal",
		"summarize", "that", "the", "their", "this", "what", "with",
	]);
	return [...new Set(
		(query.match(/[a-z0-9]{3,}/gi) ?? [])
			.map((term) => term.toLowerCase())
			.filter((term) => !stopWords.has(term)),
	)].slice(0, 8);
}

export function fallbackPrimaryTerm(terms: string[]): string | null {
	const genericTerms = new Set([
		"approach", "compensation", "decision", "employment", "justification",
		"ordinance", "reinstatement", "remedies", "unfair", "unlawful", "unreasonable", "wrongful",
	]);
	return terms.find((term) => term.length >= 6 && !genericTerms.has(term)) ?? terms.find((term) => !genericTerms.has(term)) ?? terms[0] ?? null;
}
