# Ticket index (plan.md → tickets)

Order: T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11; T16 first, then T12 → T13 → T14 → T15.

| Done | Ticket | Title | Blocks |
|---|---|---|---|
| [x] | T01 | Provision Flexible Server + extensions (azure_ai, no zhparser) | T02–T08 |
| [x] | T02 | Prisma SQL Server → Postgres port | T03, T04 |
| [x] | T03 | Chunk DDL + baseline migration | T07 |
| [ ] | T04 | Relational backfill (insert scripts → pg) | T05 |
| [ ] | T05 | Re-chunk pipeline (index lost) | T06 |
| [ ] | T06 | Re-embed (app batch or in-DB create_embeddings, EN cache) | T07 |
| [ ] | T07 | COPY + HNSW/GIN/tsv build | T08 |
| [ ] | T08 | Fusion search SQL (RRF, snippets, in-DB embeddings) | T09, T10 |
| [ ] | T09 | Rerank: azure_ai.rank primary + app fallback + flag | T10 |
| [ ] | T10 | Runtime rewrite + deletion | T11 |
| [ ] | T11 | UI contract + cutover + swap | — |
| [ ] | T12 | Agent tool library (pg search tools) | T13, T14 |
| [ ] | T13 | Agent loop in chat route + prompt rewrite | T14, T15 |
| [ ] | T14 | Streaming sources + UI for tool states | T15 |
| [ ] | T15 | Agentic rollout: flags, smoke, kill-switch | — |
| [ ] | T16 | Upgrade AI SDK 5 → 7 (ToolLoopAgent baseline) | T12–T14 |

Source of truth: `plan.md` (§10 for agentic). Ticket files are the actionable split; update both if scope changes.
