/**
 * Shared CJK tokenizer for pg lexical search (no zhparser on Flexible).
 * Mirrors scripts/cjk.ts — app-side copy so the Next.js bundle does not import from scripts/.
 * Chinese runs -> overlapping bigrams; alnum runs -> lowercased words.
 * Query side MUST use the same function so q-grams match stored cjk_tokens.
 * Keep the two files in sync if this ever changes.
 */
export function cjkTokens(s: string): string {
	const cjk = s.match(/[一-鿿㐀-䶿豈-﫿]+/gu) ?? [];
	const grams = cjk.flatMap((w) =>
		w.length < 2 ? [w] : Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)),
	);
	const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return [...grams, ...words].join(" ");
}

/** True when the query contains any CJK character (lane detection for T08). */
export function containsCjk(s: string): boolean {
	return /[一-鿿㐀-䶿豈-﫿]/u.test(s);
}
