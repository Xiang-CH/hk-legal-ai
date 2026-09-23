# Agentic search rollout

This runbook covers the guarded rollout from the fixed rewrite/fan-out pipeline to the model-driven search agent.

## Feature flags

| Variable | Default | Meaning |
|---|---:|---|
| `AGENTIC_SEARCH_ENABLED` | `false` | `true` selects the T13 agent loop. Any other value keeps the legacy rewrite/fan-out path. |
| `AGENTIC_MAX_STEPS` | `5` | Server default for agent steps. Request `maxSteps` overrides it, clamped to 1–8. |

Copy `.env.example` and set values in the deployment environment. Keep `AGENTIC_SEARCH_ENABLED=false` in production until the smoke suite and test-traffic measurements below pass.

## Test-traffic rollout

1. Deploy with `AGENTIC_SEARCH_ENABLED=true` and `AGENTIC_MAX_STEPS=5` on the test environment only.
2. Run `pnpm smoke:agentic` against that deployment. Set `SMOKE_BASE_URL` when it is not `http://localhost:3000`.
3. Inspect the 17 golden conversations: greetings and capability questions must call zero tools; CLIC questions must use `search_clic`; ordinance questions must call `search_legislation` and `get_ordinance_section`; case questions must call `search_judgments` and `get_case`; every sourced answer must contain an inline markdown citation.
4. Exercise the kill switch with `AGENTIC_SEARCH_ENABLED=false`, restart, and run `pnpm smoke:legacy`. The report must show `searchMode: legacy`, zero typed agent tools, and rewritten `searchQueries`.
5. After both suites pass, enable the flag for a small test cohort. Keep the legacy path deployed and revert immediately on routing regressions, source duplicates, missing citations, step-limit failures, or cost/latency outside the recorded envelope.

## Smoke and measurement

The smoke commands write a JSON report when `SMOKE_REPORT_PATH` is set:

```bash
SMOKE_REPORT_PATH=/tmp/agentic-smoke.json pnpm smoke:agentic
SMOKE_REPORT_PATH=/tmp/legacy-smoke.json pnpm smoke:legacy
```

The report records pass/fail status per conversation, observed tool names, source counts, step counts, p50/p95 end-to-end latency, p50/p95 tool counts, and estimated Foundry model cost from `message-metadata.usage.foundryCost`. Save the report with the rollout review; do not treat the estimate as an invoice.

### Langfuse dashboard

Keep the existing OTel/Langfuse spans and add these checks for agent traffic:

- Agent/model traces: filter spans with the model call name emitted by AI SDK telemetry and inspect `usage.inputTokens`, `usage.outputTokens`, `usage.cachedInputTokens`, `usage.totalTokens`, `usage.reasoningTokens`, and `usage.foundryCost`.
- Tool traces: filter span names `tool:search_clic`, `tool:search_judgments`, `tool:search_legislation`, `tool:get_ordinance_section`, and `tool:get_case`. Each span has tool input/output; use it to count calls and diagnose failed lookups.
- Legacy comparison: filter `rewrite-query`, `semantic-search`, `search-clic`, `search-judgment-summary`, `search-legislation-sql`, `rerank-clic`, and `rerank-judgment` spans.

Useful queries for the test window:

```text
span.name startsWith "tool:" | summarize count() by span.name
span.name startsWith "tool:" | summarize calls=count() by span.name, bin(timestamp, 1h)
input.metadata.searchMode == "agent" | summarize p50(duration), p95(duration), avg(toolCallCount)
input.metadata.searchMode == "agent" | summarize total(foundryCost), avg(stepCount), avg(toolCallCount)
```

Record the following table after each rollout stage. The worst-case agent cost/latency is approximately `maxSteps × (embedding + fusion search + rerank)` before answer generation.

| Stage | Date | Traffic | p50 latency | p95 latency | p50 tools | p95 tools | Foundry cost | Notes |
|---|---|---|---:|---:|---:|---:|---:|---|
| Smoke (17 queries) | 2026-09-22 | 17 local golden queries | 26.283s | 38.633s | 1 | 2 | 0.054126175 | Agent 17/17 passed, 21 tool calls; legacy control 17/17 passed |
| Test cohort day 1 |  |  |  |  |  |  |  |  |
| Test cohort day 2 |  |  |  |  |  |  |  |  |
| Wider test traffic |  |  |  |  |  |  |  |  |

## Kill switch

Set `AGENTIC_SEARCH_ENABLED=false` and restart the service. The route then keeps `searchDepth` (default `2`) and emits legacy `searchQueries`, source metadata, and final usage metadata. Verify with `pnpm smoke:legacy` after every switch.

## Cleanup schedule

Assuming the test rollout starts on 2026-09-22, schedule the cleanup review for **2026-09-29** (one clean week after the first enabled deployment). If rollout starts later, move the review to one clean week after that date. Cleanup is allowed only when both smoke modes pass, p95 latency and tool counts are recorded, and no kill-switch exercise is pending.

At cleanup:

1. Keep `AGENTIC_SEARCH_ENABLED=true` as the only supported chat search path and remove the flag toggle after deployment parity is confirmed.
2. Delete the legacy rewrite/fan-out branch from `src/app/api/chat/route.ts`.
3. Delete `src/lib/prompts/query-extend.ts` and its remaining imports.
4. Remove legacy-only request handling and the `searchDepth` compatibility field after clients have moved to `maxSteps`.
5. Keep `pnpm smoke:agentic` and the measurement report as the post-cutover regression gate.
