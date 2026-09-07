# T16 — Upgrade AI SDK 5 → 7 (ToolLoopAgent baseline)

- **Goal:** `ai@7.x` (+ `@ai-sdk/*` majors) running; streaming + types migrated; loop tickets build on `ToolLoopAgent`.
- **Scope/files:** `package.json`, `src/app/api/chat/route.ts`, `src/lib/types.ts` (`MyUIMessage`), `chat.tsx`/`message.tsx`/`multimodal-input.tsx`.
- **Steps:**
  1. Bump `ai` 5.0.0 → 7.x + `@ai-sdk/azure|openai|react` to matching majors; `npm audit`/build.
  2. **zod spike (known risk):** repo is on `zod@^4.3.6`, and Zod v4 breaks AI SDK v6 types — verify v7 compat first; downgrade to v3 if types break (tool schemas in T12 depend on this).
  3. Route: `createUIMessageStream/Response` → `agent.stream()` + `createAgentUIStreamResponse`; `MyUIMessage` → `InferAgentUIMessage<typeof agent>` (end-to-end tool type safety).
  4. Confirm `experimental_telemetry` + Langfuse spans unchanged (`ToolLoopAgent` is a thin wrapper over `streamText` — same OTel spans).
  5. `@ai-sdk/mcp` split (v6+) — N/A (no MCP use); v7 extras (HMAC tool approvals, `WorkflowAgent` durable runs) explicitly out of scope.
- **Acceptance:** `tsc` + lint clean; legacy fan-out route still streams identically on v7 (no behavior change yet); telemetry visible in Langfuse.
- **Depends on:** nothing (do first). **Blocks:** T12, T13, T14.
- **Size:** M.
