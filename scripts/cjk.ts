/**
 * Shared CJK tokenizer for pg lexical search (no zhparser on Flexible).
 * Used by T05 (chunk checkpointing), T06 (tsv/cjk fill), T07 (COPY build), T08 (query side).
 * Chinese runs -> overlapping bigrams; alnum runs -> lowercased words.
 * Query side MUST use the same function so q-grams match stored cjk_tokens.
 */
export function cjkTokens(s: string): string {
	const cjk = s.match(/[一-鿿㐀-䶿豈-﫿]+/gu) ?? [];
	const grams = cjk.flatMap((w) =>
		w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)),
	);
	const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return [...grams, ...words].join(" ");
}
