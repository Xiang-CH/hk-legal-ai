# clic-chat

An AI chat system for community legal education. Given a plain-language question about
Hong Kong law, it retrieves and cites three corpora — CLIC explainer pages, HKLII case
judgments, and Hong Kong legislation — then answers through a tool-calling LLM loop.

The app is a Next.js App Router project deployed as an Azure Static Web Apps "hybrid"
Next.js app. It is physically mounted at `/clic-chat-hkulaw` on a shared domain and
proxied under that path (see [Routing & deployment](#routing--deployment)).

## Contents

- [Architecture](#architecture)
- [Search pipeline](#search-pipeline)
- [Chat modes and agent tools](#chat-modes-and-agent-tools)
- [HTTP API](#http-api)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Data pipeline scripts](#data-pipeline-scripts)
- [Smoke tests](#smoke-tests)
- [Observability](#observability)
- [Routing & deployment](#routing--deployment)
- [Project layout](#project-layout)
- [Documentation](#documentation)

## Architecture

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Agent runtime | AI SDK 7 `ToolLoopAgent` (`streamText` + tools + `stopWhen`) |
| Relational + search | PostgreSQL (Prisma 6, `driverAdapters` + `@prisma/adapter-pg`) |
| Vector search | `pgvector` `halfvec(3072)`, HNSW (`halfvec_cosine_ops`) |
| Lexical search | `tsvector` + GIN; CJK bigrams + `pg_trgm` for `sc`/`tc` |
| Embeddings | Azure OpenAI `text-embedding-3-large` (3072-d) |
| Rerank | Cohere `cohere-rerank-v4.0-fast` via Azure AI Foundry (app-side HTTP, flagged) |
| LLM | Azure OpenAI deployment (`LLM_MODEL`) |
| Tracing | OpenTelemetry → Langfuse |
| UI | shadcn/ui (new-york), Tailwind CSS v4, Radix primitives |

There is **no external search service**. Postgres is both the relational store and the
hybrid index; the old Azure AI Search index is gone (see `plan.md` for the migration
history and rationale).

## Search pipeline

Each search tool/helper runs:

1. **Embed** the query with `text-embedding-3-large`.
2. **Hybrid fusion in Postgres** (`src/lib/pg-search.ts`): lexical (tsvector, top 15) and
   vector (ANN, top 15) run in parallel and are fused with Reciprocal Rank Fusion
   (`1/(60+rank)`) into a top-30 candidate set per corpus.
3. **Rerank** the fused candidates with Cohere `cohere-rerank-v4.0-fast`, scoring against the original
   user question, then keep the final top-N (CLIC 10, judgments 8, legislation 10).
   Controlled by `RERANK_ENABLED`; when off/failing, fusion order is used and
   `rerank_score` is `null`.
4. **Snippets** come from `ts_headline` (lexical hits) or a content prefix (vector-only);
   the UI reads `{rrf_score, rerank_score, snippet}`.

`sc`/`tc` have no `zhparser` on Azure Flexible Server, so CJK tokenization is done
app-side as bigrams (`src/lib/cjk.ts`, `scripts/cjk.ts`) alongside `simple` + `pg_trgm`.
Embeddings are stored as `halfvec(3072)` because HNSW on `vector` caps at 2000 dimensions.

## Chat modes and agent tools

`POST /api/chat` selects a mode at request time:

- **Agentic** (`AGENTIC_SEARCH_ENABLED=true` and the request does not opt out) — a single
  `ToolLoopAgent` loop (`src/lib/chat-agent.ts`). The model decides when and what to
  search; there is no mandatory query rewrite or fan-out. `maxSteps` defaults to
  `AGENTIC_MAX_STEPS` (5) and is clamped to 1–8. On the final step tools are disabled so
  the model must answer.
- **Legacy** — the fixed pipeline in `src/app/clic-chat-hkulaw/api/chat/route.ts`:
  `rewriteQuery` (≤3 queries) → parallel CLIC/judgment fusion → global rerank → a
  Prisma graph walk over referencing legislation sections → one XML-stuffed `streamText`
  call. Kept as a kill-switch fallback.

Tool set (`src/lib/tools/`):

| Tool | Purpose |
|---|---|
| `search_clic` | Top-10 CLIC chunks for plain-language explanations |
| `search_judgments` | Top-8 HKLII judgment chunks as case examples |
| `search_legislation` | Ranked legislation sections (replaces the legacy nid graph walk) |
| `get_ordinance_section` | Full text of a Cap/section |
| `get_case` | Full judgment/summary by action number or case name |
| `full_search` | Combined multi-corpus search |
| `ask_question` | Clarifying question to the user |

Each search tool internally does fuse → rerank and returns only post-rerank results, so
downstream UI never sees raw candidates. Tool outputs are mapped to `source-url` stream
parts in `src/lib/agent-stream.ts`; conversation metadata records `searchMode`, step/tool
counts, token usage, and estimated cost.

## HTTP API

All endpoints live under the mount path (constants in `src/lib/routes.ts`):

- `POST /clic-chat-hkulaw/api/chat` — chat turn (streamed UI message protocol). Body:
  `{messages, maxSteps?, searchDepth?, agenticSearchEnabled?, systemPrompt?, sessionId?, userId?}`.
- `POST /clic-chat-hkulaw/api/clic/search` — direct CLIC search. Body:
  `{query, language?|language_code?, top?, skip?, filter?}`. Returns `{results, clicPages}`.
- `GET /clic-chat-hkulaw/c` — chat page (`/chat` and `/api/*` redirect here).

## Getting started

Prerequisites: Node 20+, pnpm, a PostgreSQL instance with `vector` and `pg_trgm`
extensions, and Azure OpenAI credentials.

```bash
pnpm install          # runs prisma generate via postinstall
pnpm db:generate      # regenerate the Prisma client into src/prisma/client
pnpm db:push          # apply the schema to DATABASE_URL
pnpm dev              # http://localhost:3000/clic-chat-hkulaw/c
```

Inspect data with `pnpm db:studio` (also available in-app at `/_internal/studio`).

Other scripts: `pnpm build` (next build + copy prefixed `_next` assets, see deployment),
`pnpm start`, `pnpm lint`.

## Environment variables

Copy `.env.example` and fill in a `.env` at the repo root (the pipeline scripts read it
directly). Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (runtime + scripts) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_KEY` | Azure OpenAI endpoint/key |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Embedding deployment (default `text-embedding-3-large`) |
| `LLM_MODEL` | Chat model deployment (default `gpt-5.4-mini`) |
| `HKLII_BASEURL` | Base URL prefixed to judgment result URLs |
| `RERANK_ENABLED` | `true` enables Cohere rerank; otherwise fusion order |
| `RERANK_ENDPOINT` / `RERANK_KEY` | Foundry Cohere rerank endpoint/key |
| `RERANK_MODEL` | Rerank model deployment (default `cohere-rerank-v4.0-fast`) |
| `RERANK_COST_PER_CALL` | Optional per-call cost for usage accounting (default 0) |
| `AGENTIC_SEARCH_ENABLED` | Server-side kill switch for the agent loop |
| `AGENTIC_MAX_STEPS` | Default agent step budget (1–8) |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Tracing |
| `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_RELEASE` | Optional trace labels |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGDATABASE` / `PGPASSWORD` | Used by pipeline scripts |
| `DATABASE_URL_SQLSERVER_BACKUP` | Read-only legacy SQL Server, for `copy-legacy-to-pg.mjs` only |

`smoke:*` scripts also read `SMOKE_BASE_URL`, `SMOKE_MAX_STEPS`, `SMOKE_REPORT_PATH`.

## Database

Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/` (a fresh Postgres
baseline; SQL Server migrations were intentionally not replayed).

Models fall into two groups:

- **Relational**: `ClicPage`, `LegislationCap`, `LegislationSection`, `Interpretation`,
  `Judgment`, `ParallelCitations`, `Case`, plus their junction relations.
- **Chunks** (search units): `ClicChunk`, `JudgmentChunk`, `LegislationChunk` — each with
  `embedding halfvec(3072)`, `tsv tsvector`, optional `cjk_tokens`, and an FK to its parent.

Commands: `pnpm db:generate`, `pnpm db:push`, `pnpm db:format`, `pnpm db:studio`. A DBML
diagram is generated under `prisma/dbml/`.

## Data pipeline scripts

`scripts/` contains the migration/rebuild pipeline (run in order; all are idempotent and
log to `/tmp` unless overridden):

| Script | Stage |
|---|---|
| `copy-legacy-to-pg.mjs` | Copy relational data from legacy Azure SQL, preserving IDs |
| `insert-clic.ts` / `insert-legislation.ts` / `insert-judgment.ts` | Insert from source JSON |
| `index-clic.ts` / `index-judgment-summary.ts` | Chunk CLIC pages / judgment summaries |
| `embed-clic-judgment.mjs` | Fill embeddings with a resumable sidecar cache |
| `chunk-legislation.mjs` | Chunk legislation into sharded JSONL |
| `embed-legislation.mjs` | Embed legislation shards (per-shard sidecars) |
| `load-existing-chunks.mjs` / `load-legislation-chunks.mjs` | COPY chunks, build tsv + HNSW/GIN |
| `cjk.ts` | Shared CJK bigram tokenizer |
| `copy-next-static.mjs` | Post-build asset copy for the SWA mount path |
| `upsert_clic_selection.py` | `pnpm upsert-clic` — import a CLIC selection spreadsheet |
| `smoke-agentic.mjs` | Golden-conversation smoke suite |

## Smoke tests

The suite runs 17 golden conversations against a deployed instance and checks routing,
tool selection, citation presence, step counts, and latency/cost:

```bash
SMOKE_BASE_URL=http://localhost:3000 pnpm smoke:agentic   # agent mode
pnpm smoke:legacy                                          # legacy control
SMOKE_REPORT_PATH=/tmp/agentic-smoke.json pnpm smoke:agentic
```

Set `AGENTIC_SEARCH_ENABLED=true` on the target for `smoke:agentic` and `false` for
`smoke:legacy`. See `docs/agentic-rollout.md` for the full rollout and kill-switch
runbook.

## Observability

Tracing is wired through OpenTelemetry into Langfuse (`src/instrumentation.ts`,
`@langfuse/otel`). Chat traces carry `searchMode`, `maxSteps`, `searchDepth`, session and
user IDs. Both modes emit nested spans (`semantic-search`, `search-clic`,
`search-judgment-summary`, `search-legislation-sql`, `rerank-*`) and agent tool calls
(`tool:<name>`). Traces are force-flushed when the response stream closes, which matters
on serverless.

## Routing & deployment

The app is mounted at `/clic-chat-hkulaw` and proxied on a shared domain. Next's
`basePath` cannot be used because Azure SWA's hybrid Next.js runtime rejects it at deploy
time. Instead:

- Pages/APIs come from the physical folder `src/app/clic-chat-hkulaw/`.
- `assetPrefix` (set only outside dev) rewrites `_next/static` URLs to the mount path.
- `pnpm build` runs `scripts/copy-next-static.mjs`, which duplicates the built static
  assets under the prefixed path so any host (SWA default hostname or custom domain)
  serves them without an edge rewrite.
- `output: "standalone"` keeps the bundle under SWA's 250 MB cap.

CI/CD: `.github/workflows/azure-static-web-apps-proud-sand-02b2ed11e.yml` deploys `main`
and PRs via `Azure/static-web-apps-deploy`. Source of truth for paths is
`src/lib/routes.ts`.

## Project layout

```
src/
  app/
    clic-chat-hkulaw/        # mounted app: page, /c chat page, api/chat, api/clic/search
    layout.tsx, globals.css
  components/                # chat, citations, groundings, sidebar, shadcn ui/*
  hooks/                     # conversations, dev mode, mobile, scroll
  lib/
    agent-stream.ts          # agent stream -> UI chunks + source mapping
    chat-agent.ts            # ToolLoopAgent factories (agent + legacy)
    pg-search.ts             # pg fusion (RRF) queries
    rerank.ts, pricing.ts
    clic-api.ts              # re-export entry for the chat helper
    routes.ts                # APP_BASE_PATH + route constants
    prompts/                 # search, source, query-extend prompts
    tools/                   # one file per agent tool
prisma/                      # schema + migrations + dbml
scripts/                     # data pipeline, loaders, smoke, build helpers
tickets/                     # T01–T17 task breakdown
```

## Documentation

- `plan.md` — the single-Postgres + agentic-search migration plan (decisions, risks).
- `tickets/` — actionable task breakdown (T01–T17); `tickets/INDEX.md` has status.
- `docs/agentic-rollout.md` — feature flags, rollout stages, kill switch, cleanup.

Known pending work: T17 legislation chunks are indexed for `en` only; `sc`/`tc` are not
yet loaded.
