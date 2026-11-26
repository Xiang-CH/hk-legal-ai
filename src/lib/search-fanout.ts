import type { createJudgmentSearchDebug } from "@/lib/judgment-search-debug";
import { PARALLEL_RETRIEVAL_BUDGET_MS, withTimeout } from "@/lib/tools/shared";

export async function retrieveSearchQueries<C, J>(
	queries: string[],
	debug: Pick<ReturnType<typeof createJudgmentSearchDebug>, "forQuery">,
	search: {
		embed: (query: string) => Promise<number[]>;
		clic: (query: string, embedding: number[]) => Promise<C[]>;
		judgments: (
			query: string,
			embedding: number[],
			queryDebug: ReturnType<typeof debug.forQuery>,
			onPartial: () => void,
		) => Promise<J[]>;
	},
) {
	const deadline = performance.now() + PARALLEL_RETRIEVAL_BUDGET_MS;
	const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
	const results = await Promise.all(queries.map(async (query, index) => {
		const queryDebug = debug.forQuery(index);
		const embedding = await queryDebug.stage("embedding", () =>
			withTimeout(search.embed(query), remaining(), "embedding"),
		).catch(() => null);
		if (!embedding) return { clic: [], judgments: [], completed: 0, incomplete: true };

		let judgmentPartial = false;
		const [clic, judgments] = await Promise.allSettled([
			queryDebug.stage("clic_retrieval", () =>
				withTimeout(search.clic(query, embedding), remaining(), "clic retrieval"),
			(hits) => ({ hitCount: hits.length })),
			queryDebug.stage("hybrid_retrieval", () =>
				withTimeout(search.judgments(query, embedding, queryDebug, () => { judgmentPartial = true; }),
					remaining(), "judgment retrieval"),
			(hits) => ({ hitCount: hits.length })),
		]);
		return {
			clic: clic.status === "fulfilled" ? clic.value : [],
			judgments: judgments.status === "fulfilled" ? judgments.value : [],
			completed: Number(clic.status === "fulfilled") + Number(judgments.status === "fulfilled"),
			incomplete: judgmentPartial || clic.status === "rejected" || judgments.status === "rejected",
		};
	}));
	return {
		clicLists: results.map((row) => row.clic),
		judgmentLists: results.map((row) => row.judgments),
		completed: results.reduce((count, row) => count + row.completed, 0),
		partial: results.some((row) => row.incomplete),
	};
}
