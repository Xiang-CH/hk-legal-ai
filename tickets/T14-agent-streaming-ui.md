# T14 — Streaming sources + UI for tool states

- **Goal:** sources and progress stream correctly under the agent loop.
- **Scope/files:** `route.ts` (tool-result → `source-url` mapping), `chat.tsx`, `groundings-display.tsx`.
- **Steps:**
  1. Map each tool result to `source-url` parts (`clic-{nid}-{chunk_no}`, `judgment-{id}-{chunk_no}`, `cap-{n}-{s}`) with `{rrf_score, rerank_score, snippet}` (no `caption` — see T11 contract).
  2. Render tool-invocation states as searching… indicators (replace today's notification writes); `createAgentUIStreamResponse` forwards typed tool parts (`InferAgentUIMessage<typeof agent>`) — handle them in UI state.
  3. Keep final `message-metadata` (usage) write on finish.
- **Acceptance:** sources appear incrementally per tool call; no duplicate sourceIds; reasoning + tool states render without breaking existing message history.
- **Depends on:** T16, T12, T13. **Blocks:** T15.
- **Size:** M.
