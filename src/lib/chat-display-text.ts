const searchArgumentKeys = /^(query|queries|topic|languageCode|searchDepth|keywords|capNumber|sectionNumber)$/;

function isSearchArgumentLine(line: string): boolean {
  if (!line.startsWith("{") || !line.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const fields = Object.entries(parsed);
    if (!fields.every(([key]) => searchArgumentKeys.test(key))) return false;
    return ("query" in parsed && typeof parsed.query === "string" &&
        ("topic" in parsed || "languageCode" in parsed)) ||
      ("queries" in parsed && Array.isArray(parsed.queries) && parsed.queries.every((query) => typeof query === "string"));
  } catch {
    return false;
  }
}

/** Hide bare tool arguments echoed as assistant text, while retaining prose and fenced examples. */
export function assistantDisplayText(text: string, streaming: boolean): string {
  let fence: string | undefined;
  return text.split("\n").filter((line, index, lines) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return true;
    }
    if (fence) return true;
    const candidate = line.trim();
    if (isSearchArgumentLine(candidate)) return false;
    // Hold an unfinished search object until it can be classified.
    if (!streaming || index !== lines.length - 1 || !candidate.startsWith("{") || candidate.endsWith("}")) return true;
    const afterBrace = candidate.slice(1).trimStart();
    return !['"query"', '"queries"'].some((key) => key.startsWith(afterBrace) || afterBrace.startsWith(key));
  }).join("\n");
}
