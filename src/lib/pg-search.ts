/**
 * T08 — Postgres fusion search (pgvector + FTS + pg_trgm, RRF).
 *
 * Single Azure PG Flexible Server replaces Azure AI Search (index lost, rebuilt from source).
 * Ported from tickets/T08-fusion-draft.sql, generalized so ONE round-trip covers mixed
 * language lanes: `language_code = ANY($langs)` with per-row CASE on `language_code`
 * (instead of one query per ($lang) like the draft).
 *
 * Per (query × corpus): lexical LIMIT 15 + vector LIMIT 15 -> RRF 1/(60+rank) -> top-30,
 * snippet via ts_headline (lexical hits) / left(content,300) (vector-only hits).
 *
 * Params: $1 raw query, $2 cjkTokens(query), $3 embedding literal, $4 langs[],
 *         [$5 topics[] for clic_chunks only].
 * Embedding is app-side (getEmbeddings, text-embedding-3-large, 3072-d) so the caller
 * computes it ONCE per rewritten query and shares it across all three corpora.
 * (In-DB azure_openai.create_embeddings stays an option, but app-side keeps one code
 * path and avoids DB outbound/timeout coupling — see T08 ticket.)
 */
import { prisma } from "@/lib/prisma";
import { cjkTokens, containsCjk } from "@/lib/cjk";

export const EMBEDDING_DIM = 3072; // text-embedding-3-large
const LEX_LIMIT = 15;
const VEC_LIMIT = 15;
const RESULT_LIMIT = 30;

export interface PgSearchOpts {
	/** App-side embedding for the query (getEmbeddings output), shared across corpora. */
	embedding: number[];
	/** Override lanes; default auto-detect: CJK -> ['sc','tc'], else ['en']. */
	languageCodes?: string[];
	/** clic_chunks only; undefined/empty = no filter. */
	topics?: string[];
}

export interface PgScoredRow {
	lexical_rank: number | null;
	vector_distance: number | null;
	rrf_score: number;
	snippet: string;
}

export interface ClicChunkHit extends PgScoredRow {
	nid: number;
	chunk_no: number;
	title: string;
	content: string;
	url: string;
	topic: string;
	context: string | null;
}

export interface JudgmentChunkHit extends PgScoredRow {
	judgmentId: number;
	chunk_no: number;
	neutralCitation: string | null;
	courtName: string | null;
	year: number | null;
	date: Date | string | null;
	parties: string | null;
	content: string;
	summarySource: string | null;
	url: string | null;
}

export interface LegislationChunkHit extends PgScoredRow {
	sectionId: number;
	chunk_no: number;
	languageCode: string;
	capNumber: string;
	sectionNumber: string;
	subsectionNumber: string | null;
	heading: string | null;
	content: string;
	url: string;
	context: string | null;
}

export function resolveLanguageCodes(query: string, override?: string[]): string[] {
	if (override && override.length > 0) return override;
	return containsCjk(query) ? ["sc", "tc"] : ["en"];
}

function snippetSql(contentCol: string): string {
	return `CASE WHEN f.lexical_rank IS NOT NULL THEN ts_headline(
              CASE WHEN c.language_code = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
              ${contentCol},
              CASE WHEN c.language_code = 'en' THEN plainto_tsquery('english', $1)
                   ELSE plainto_tsquery('simple', $2) END,
              'MaxWords=60, MinWords=30, ShortWord=3')
            ELSE left(${contentCol}, 300) END AS snippet`;
}

async function runFusion<T>(args: {
	table: "clic_chunks" | "judgment_chunks" | "legislation_chunks";
	query: string;
	opts: PgSearchOpts;
	finalSelect: string;
}): Promise<T[]> {
	const cjk = cjkTokens(args.query);
	const langs = resolveLanguageCodes(args.query, args.opts.languageCodes);
	const emb = `[${args.opts.embedding.join(",")}]`;
	const params: unknown[] = [args.query, cjk, emb, langs];
	let topicClause = "";
	if (args.table === "clic_chunks" && args.opts.topics && args.opts.topics.length > 0) {
		params.push(args.opts.topics);
		topicClause = `AND topic = ANY($${params.length})`;
	}
	// NOTE: explicit ::int / ::float8 casts — raw numeric/bigint come back from pg as
	// string/bigint and would break JSON serialization downstream.
	const sql = `
WITH lex AS (
  SELECT id,
         CASE WHEN language_code = 'en'
           THEN ts_rank(tsv, plainto_tsquery('english', $1))
           ELSE 0.7 * ts_rank(to_tsvector('simple', cjk_tokens), plainto_tsquery('simple', $2))
              + 0.3 * similarity(cjk_tokens, $2)
         END AS score
  FROM ${args.table}
  WHERE language_code = ANY($4)
    AND (CASE WHEN language_code = 'en'
      THEN tsv @@ plainto_tsquery('english', $1)
      ELSE to_tsvector('simple', cjk_tokens) @@ plainto_tsquery('simple', $2)
        OR cjk_tokens % $2
    END)
  ${topicClause}
  ORDER BY score DESC
  LIMIT ${LEX_LIMIT}
),
lex_r AS (SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC) AS rnk FROM lex),
vec AS (
  SELECT id, embedding <=> $3::halfvec(${EMBEDDING_DIM}) AS dist
  FROM ${args.table}
  WHERE language_code = ANY($4)
  ${topicClause}
  ORDER BY embedding <=> $3::halfvec(${EMBEDDING_DIM})
  LIMIT ${VEC_LIMIT}
),
vec_r AS (SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist) AS rnk FROM vec),
fused AS (
  SELECT COALESCE(l.id, v.id) AS id,
         COALESCE(1.0 / (60 + l.rnk), 0) + COALESCE(1.0 / (60 + v.rnk), 0) AS rrf,
         l.rnk AS lexical_rank, v.dist AS vector_distance
  FROM lex_r l FULL OUTER JOIN vec_r v USING (id)
)
${args.finalSelect}
ORDER BY f.rrf DESC
LIMIT ${RESULT_LIMIT};`;
	return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

/** Q1: clic_chunks — lex 15 + vec 15 -> RRF top-30. */
export function searchClicChunks(query: string, opts: PgSearchOpts): Promise<ClicChunkHit[]> {
	return runFusion<ClicChunkHit>({
		table: "clic_chunks",
		query,
		opts,
		finalSelect: `SELECT c.nid, c.chunk_no AS "chunk_no", c.title, c.content, c.url, c.topic, c.context,
       f.lexical_rank::int AS "lexical_rank", f.vector_distance::float8 AS "vector_distance",
       f.rrf::float8 AS "rrf_score",
       ${snippetSql("c.content")}
FROM fused f JOIN clic_chunks c ON c.id = f.id`,
	});
}

/** Q2: judgment_chunks — same shape, no topic filter. */
export function searchJudgmentChunks(query: string, opts: PgSearchOpts): Promise<JudgmentChunkHit[]> {
	return runFusion<JudgmentChunkHit>({
		table: "judgment_chunks",
		query,
		opts,
		finalSelect: `SELECT c.judgment_id AS "judgmentId", c.chunk_no AS "chunk_no",
       c.neutral_citation AS "neutralCitation", c.court_name AS "courtName",
       c.year, c.date, c.parties, c.content,
       c.summary_source AS "summarySource", c.url,
       f.lexical_rank::int AS "lexical_rank", f.vector_distance::float8 AS "vector_distance",
       f.rrf::float8 AS "rrf_score",
       ${snippetSql("c.content")}
FROM fused f JOIN judgment_chunks c ON c.id = f.id`,
	});
}

/** Q3: legislation_chunks — same shape, no topic filter (tsv built from heading+content per T17). */
export function searchLegislationChunks(query: string, opts: PgSearchOpts): Promise<LegislationChunkHit[]> {
	return runFusion<LegislationChunkHit>({
		table: "legislation_chunks",
		query,
		opts,
		finalSelect: `SELECT c.section_id AS "sectionId", c.chunk_no AS "chunk_no",
       c.language_code AS "languageCode",
       c.cap_number AS "capNumber", c.section_number AS "sectionNumber",
       c.subsection_number AS "subsectionNumber",
       c.heading, c.content, c.url, c.context,
       f.lexical_rank::int AS "lexical_rank", f.vector_distance::float8 AS "vector_distance",
       f.rrf::float8 AS "rrf_score",
       ${snippetSql("c.content")}
FROM fused f JOIN legislation_chunks c ON c.id = f.id`,
	});
}
