# Ticket index (plan.md → tickets)

Order: T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11; T17 alongside T05–T07 (feeds T08); T16 first, then T12 → T13 → T14 → T15.

| Done | Ticket | Title | Blocks |
|---|---|---|---|
| [x] | T01 | Provision Flexible Server + extensions (azure_ai, no zhparser) | T02–T08 |
| [x] | T02 | Prisma SQL Server → Postgres port | T03, T04 |
| [x] | T03 | Chunk DDL + baseline migration | T07 |
| [x] | T04 | Relational backfill (insert scripts → pg) | T05 |
| [x] | T05 | Re-chunk pipeline (index lost) | T06 |
| [x] | T06 | Re-embed (app batch or in-DB create_embeddings, EN cache) | T07 |
| [x] | T07 | COPY + HNSW/GIN/tsv build | T08 |
| [x] | T08 | Fusion search SQL (RRF, snippets, app-side embeddings) | T09, T10 |
| [x] | T09 | Rerank: app-side Cohere (global, flagged) + cost | T10 |
| [x] | T10 | Runtime rewrite + deletion | T11 |
| [x] | T11 | UI contract + cutover + swap | — |
| [x] | T12 | Agent tool library (pg search tools) | T13, T14 |
| [x] | T13 | Agent loop in chat route + prompt rewrite | T14, T15 |
| [x] | T14 | Streaming sources + UI for tool states | T15 |
| [x] | T15 | Agentic rollout: flags, smoke, kill-switch | — |
| [x] | T16 | Upgrade AI SDK 5 → 7 (ToolLoopAgent baseline) | T12–T14 |
| [ ] | T17 | Legislation chunks (EN 205,779 indexed; sc/tc pending) | T08 |

Source of truth: `plan.md` (§10 for agentic). Ticket files are the actionable split; update both if scope changes.
