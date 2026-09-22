/**
 * T09 — app-side reranker (Cohere rerank-v4.0-fast via Foundry serverless HTTP).
 *
 * Why app-side, not in-DB `azure_ai.rank`: `azure_ai.rank()` exists on this server
 * (2-arg + 3-arg overloads; server default was cohere-rerank-v3.5) but the settings key is
 * rejected (`azure_ml.serverless_ranking_endpoint is not a valid configuration key`;
 * T01 step 4's `azure_ml.scoring_endpoint` / `azure_ml.serverless_ranking_key` are
 * unverified guesses). Until the correct key is discovered (T01 step 3 discovery SQL),
 * rerank runs here — no DB change needed.
 *
 * Env (app runtime, NOT repo):
 *   RERANK_ENABLED=false            # default: fusion-only slice, zero behavior change
 *   RERANK_ENDPOINT=https://<DEPLOY>.<REGION>.models.ai.azure.com/v1/rerank
 *     # paste the FULL URL from the Foundry deployment details, incl. /v1|/v2/rerank
 *   RERANK_KEY=<Foundry key>
 *   RERANK_MODEL=cohere-rerank-v4.0-fast # optional, this is the default
 *
 * Contract: fusion top-30 (raw chunk `content`, NOT snippets) -> rerank -> top-N.
 * ANY failure (disabled / env missing / non-200 / timeout / bad shape) returns null
 * and the caller keeps fusion order — rerank never 500s the chat path.
 */

const DEFAULT_MODEL = "cohere-rerank-v4.0-fast";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2; // retries on 429/5xx, honoring Retry-After
const MAX_RETRY_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Per-doc cap: Cohere rerank handles long docs, but chunks can be huge — bound cost. */
const MAX_DOC_CHARS = 4000;

export function isRerankEnabled(): boolean {
	return process.env.RERANK_ENABLED === "true";
}

/** Request-scoped rerank accounting (create one per chat turn, pass to applyRerank). */
export interface RerankUsage {
	/** Rerank API calls attempted (counts even when they fall back — provider may bill attempts). */
	calls: number;
	/** Total documents sent across calls. */
	documents: number;
	/** Calls that returned usable scores. */
	succeeded: number;
}

export function createRerankUsage(): RerankUsage {
	return { calls: 0, documents: 0, succeeded: 0 };
}

interface CohereRerankResult {
	index: number;
	relevance_score: number;
}

/**
 * Score `documents` against `query`. Returns index -> {rank (1-based), score},
 * or null when disabled / unconfigured / failed (caller falls back to fusion order).
 */
export async function rerankScores(
	query: string,
	documents: string[],
	opts?: { topN?: number; timeoutMs?: number; usage?: RerankUsage },
): Promise<Map<number, { rank: number; score: number }> | null> {
	if (!isRerankEnabled() || documents.length === 0 || !query.trim()) return null;
	const endpoint = process.env.RERANK_ENDPOINT;
	const key = process.env.RERANK_KEY;
	if (!endpoint || !key) {
		console.warn("[rerank] RERANK_ENABLED but RERANK_ENDPOINT/KEY missing — fusion fallback");
		return null;
	}
	if (opts?.usage) {
		opts.usage.calls++;
		opts.usage.documents += documents.length;
	}
	const topN = Math.min(opts?.topN ?? documents.length, documents.length);
	const body = JSON.stringify({
		model: process.env.RERANK_MODEL || DEFAULT_MODEL,
		query,
		documents: documents.map((d) => d.slice(0, MAX_DOC_CHARS)),
		top_n: topN,
	});
	for (let attempt = 0; ; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					// Azure serverless (MaaS) expects `api-key`; Cohere-native expects Bearer.
					"api-key": key,
					Authorization: `Bearer ${key}`,
				},
				body,
			});
			if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
					if (attempt >= MAX_RETRIES) {
						console.warn(`[rerank] HTTP ${res.status} after ${attempt} retries — fusion fallback`);
						return null;
					}
					// Honor Retry-After (seconds) when present, else exponential backoff.
					const retryAfter = Number(res.headers.get("retry-after"));
					const waitMs = Math.min(
						Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
						MAX_RETRY_WAIT_MS,
					);
					console.warn(`[rerank] HTTP ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1})`);
					await sleep(waitMs);
					continue;
			}
			if (!res.ok) {
				console.warn(`[rerank] HTTP ${res.status} — fusion fallback`);
				return null;
			}
			const data = (await res.json()) as { results?: CohereRerankResult[] };
			if (!Array.isArray(data.results)) {
				console.warn("[rerank] unexpected response shape — fusion fallback");
				return null;
			}
			const map = new Map<number, { rank: number; score: number }>();
			data.results.forEach((r, rank) => map.set(r.index, { rank: rank + 1, score: r.relevance_score }));
			if (opts?.usage) opts.usage.succeeded++;
			return map;
		} catch (err) {
			console.warn("[rerank] failed, fusion fallback:", err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Reorder `items` by rerank score and slice to topN. Returns [{item, rerank_score}]
 * in final order; `rerank_score` is undefined when rerank was skipped/failed
 * (fusion order kept).
 */
export async function applyRerank<T>(
	query: string,
	items: T[],
	opts: { getText: (item: T) => string; topN: number; usage?: RerankUsage },
): Promise<{ item: T; rerank_score?: number }[]> {
	const scores = await rerankScores(
		query,
		items.map(opts.getText),
		{ topN: Math.min(opts.topN, items.length), usage: opts.usage },
	);
	if (!scores) return items.slice(0, opts.topN).map((item) => ({ item }));
	return [...items.keys()]
		.filter((i) => scores.has(i))
		.sort((a, b) => scores.get(a)!.rank - scores.get(b)!.rank)
		.slice(0, opts.topN)
		.map((i) => ({ item: items[i], rerank_score: scores.get(i)!.score }));
}
