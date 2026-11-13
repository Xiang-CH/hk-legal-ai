/**
 * Shared CJK tokenizer for pg lexical search (no zhparser on Flexible).
 * Used by T05 (chunk checkpointing), T06 (tsv/cjk fill), T07 (COPY build), T08 (query side).
 * Chinese runs -> overlapping bigrams; alnum runs -> lowercased words.
 * Query side MUST use the same function so q-grams match stored cjk_tokens.
 */
export function cjkTokens(s: string): string {
	const cjk = s.match(/\p{Script=Han}+/gu) ?? [];
	const grams = cjk.flatMap((w) => {
		const characters = Array.from(w);
		return characters.length < 2 ? [w] : characters.slice(0, -1).map((character, i) => character + characters[i + 1]);
	});
	const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return [...grams, ...words].join(" ");
}
