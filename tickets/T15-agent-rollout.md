# T15 — Agentic rollout: flags, smoke, kill-switch

- **Goal:** safe cutover from fan-out to agent loop with measured cost/latency.
- **Scope/files:** env (`AGENTIC_SEARCH_ENABLED`, `AGENTIC_MAX_STEPS`), smoke script, Langfuse dashboard notes.
- **Steps:**
  1. Deploy with `AGENTIC_SEARCH_ENABLED=true` for test traffic; legacy fan-out intact as fallback.
  2. Smoke set (≥15 golden queries: greeting/no-search, CLIC-only, ordinance-exact, case-law, sc/tc language, follow-up needing context): assert correct tools called, citations present, steps ≤ max.
  3. Record p50/p95 latency + per-turn tool-call counts + Foundry cost; worst case ≈ maxSteps × (embed + fusion + rerank).
  4. Kill-switch: `AGENTIC_SEARCH_ENABLED=false` restores legacy; remove legacy path + `query-extend.ts` after 1 clean week.
- **Acceptance:** smoke 100% pass; p95 recorded; kill-switch verified (toggle returns fan-out behavior); cleanup scheduled.
- **Depends on:** T13, T14. **Blocks:** nothing.
- **Size:** M.
