# T13 — Agent loop in chat route + prompt rewrite

- **Goal:** `route.ts` runs a model-driven loop; fixed rewrite→fan-out→XML path retired behind flag.
- **Scope/files:** `src/app/api/chat/route.ts`, `src/lib/prompts/search.ts`, `src/lib/prompts/query-extend.ts`.
- **Steps:**
  1. Define `ToolLoopAgent({model: azure(LLM_MODEL), instructions: <new policy>, tools, stopWhen: stepCountIs(maxSteps)})` once; route calls `agent.stream(...)` + `createAgentUIStreamResponse`; `maxSteps` from request (default 5, cap 8; replaces `searchDepth`).
  2. Rewrite `search.ts`: tool-use policy (CLIC = plain-language, legislation = exact text, judgments = case examples; search before citing; no parametric HK-law answers); keep inline-citation + markdown rules.
  3. `AGENTIC_SEARCH_ENABLED=false` restores legacy fan-out (keep until T15 smoke passes); delete `query-extend.ts` once legacy path is removed.
- **Acceptance:** greeting turn makes 0 tool calls; ordinance question calls `search_legislation`/`get_ordinance_section`; case question reaches `search_judgments`/`get_case`; loop terminates ≤ maxSteps.
- **Depends on:** T16, T12. **Blocks:** T14, T15.
- **Size:** L.
