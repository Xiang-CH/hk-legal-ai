import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewMessage } from "../../src/components/message";
import { DevModeProvider } from "../../src/hooks/use-dev-mode";
import type { MyUIMessage } from "../../src/lib/types";

const callArguments = JSON.stringify({
  query: "search-only-marker",
  topic: "copyright",
  languageCode: "en",
});

function renderMessage(parts: MyUIMessage["parts"], role: MyUIMessage["role"] = "assistant") {
  return renderToStaticMarkup(createElement(DevModeProvider, null,
    createElement(PreviewMessage, { message: { id: "message", role, parts } }),
  ));
}

test("assistant text preserves standalone and partial JSON as it streams", () => {
  const html = renderMessage([
    { type: "text", text: callArguments },
    { type: "text", text: `${callArguments}\n\nAnswer based on the sources.` },
    { type: "text", text: '{"que', state: "streaming" },
  ]);
  assert.match(html, /Answer based on the sources/);
  assert.match(html, /search-only-marker/);
  assert.match(html, /&quot;que/);
});

test("fenced JSON examples and user input remain visible", () => {
  const fenced = ["```json", callArguments, "```"].join("\n");
  assert.match(renderMessage([{ type: "text", text: fenced }]), /search-only-marker/);
  assert.match(renderMessage([{ type: "text", text: callArguments }], "user"), /search-only-marker/);
});

test("failed tool output uses a failure icon and is excluded from completed count", () => {
  const html = renderMessage(Array.from({ length: 5 }, (_, i) => ({
    type: "tool-search_legislation" as const,
    state: "output-available" as const,
    toolCallId: `call-${i}`,
    input: { keywords: "copyright" },
    output: { error: "fixture rejected" },
  })));
  assert.match(html, /0\/5 completed · 5 failed/);
  assert.match(html, /lucide-x/);
  assert.doesNotMatch(html, /lucide-check/);
});
