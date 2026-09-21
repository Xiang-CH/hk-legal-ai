-- T08 DRAFT — Postgres fusion search (RRF over lexical + vector), one query per corpus.
-- Status: draft for review, NOT wired into helper.ts yet. Assumes T07 indexes exist:
--   HNSW (embedding halfvec_cosine_ops), GIN(tsv), GIN(cjk_tokens gin_trgm_ops), GIN(content gin_trgm_ops)
-- Params (all three queries): $query TEXT (raw user query), $cjkquery TEXT (app-side
--   cjkTokens($query) — CJK bigrams + alnum words, see scripts/cjk.ts / T07 impl),
--   $lang TEXT ('en'|'sc'|'tc'), $emb TEXT ('[0.1,0.2,...]' 3072-d from app getEmbeddings()),
--   $topics TEXT[] (CLIC only, NULL = no filter).
-- In-DB embedding alternative (needs T01 azure_ai settings): replace $emb with
--   azure_openai.create_embeddings('<DEPLOYMENT>', $query)::halfvec(3072)  (single round-trip).
-- Contract out: top-30 rows per query with {keys, title/url/content, lexical_rank,
--   vector_distance, rrf_score, snippet}. Drops Azure-only rerankerScore/captionHighlights.
-- Snippet: ts_headline for lexical hits, left(content,300) for vector-only hits.

-- ============ Q1: clic_chunks (lex 15 + vec 15 -> RRF top-30) ============
WITH lex AS (
  SELECT id,
         CASE WHEN $lang = 'en'
           THEN ts_rank(tsv, plainto_tsquery('english', $query))
           ELSE 0.7 * ts_rank(to_tsvector('simple', cjk_tokens), plainto_tsquery('simple', $cjkquery))
              + 0.3 * similarity(cjk_tokens, $cjkquery)
         END AS score
  FROM clic_chunks
  WHERE language_code = $lang
    AND ($topics IS NULL OR topic = ANY($topics))
    AND CASE WHEN $lang = 'en'
      THEN tsv @@ plainto_tsquery('english', $query)
      ELSE to_tsvector('simple', cjk_tokens) @@ plainto_tsquery('simple', $cjkquery)
        OR cjk_tokens % $cjkquery
    END
  ORDER BY score DESC
  LIMIT 15
),
lex_r AS (SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC) AS rnk FROM lex),
vec AS (
  SELECT id, embedding <=> $emb::halfvec(3072) AS dist
  FROM clic_chunks
  WHERE language_code = $lang
    AND ($topics IS NULL OR topic = ANY($topics))
  ORDER BY embedding <=> $emb::halfvec(3072)
  LIMIT 15
),
vec_r AS (SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist) AS rnk FROM vec),
fused AS (
  SELECT COALESCE(l.id, v.id) AS id,
         COALESCE(1.0 / (60 + l.rnk), 0) + COALESCE(1.0 / (60 + v.rnk), 0) AS rrf,
         l.rnk AS lexical_rank, v.dist AS vector_distance
  FROM lex_r l FULL OUTER JOIN vec_r v USING (id)
)
SELECT c.nid, c.chunk_no, c.title, c.content, c.url, c.topic, c.context,
       f.lexical_rank, f.vector_distance, f.rrf AS rrf_score,
       CASE WHEN f.lexical_rank IS NOT NULL THEN ts_headline(
              CASE WHEN $lang = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
              c.content,
              CASE WHEN $lang = 'en' THEN plainto_tsquery('english', $query)
                   ELSE plainto_tsquery('simple', $cjkquery) END,
              'MaxWords=60, MinWords=30, ShortWord=3')
            ELSE left(c.content, 300) END AS snippet
FROM fused f JOIN clic_chunks c ON c.id = f.id
ORDER BY f.rrf DESC
LIMIT 30;

-- ============ Q2: judgment_chunks (same shape, no topic filter) ============
-- WITH lex AS (
--   SELECT id,
--          CASE WHEN $lang = 'en'
--            THEN ts_rank(tsv, plainto_tsquery('english', $query))
--            ELSE 0.7 * ts_rank(to_tsvector('simple', cjk_tokens), plainto_tsquery('simple', $cjkquery))
--               + 0.3 * similarity(cjk_tokens, $cjkquery)
--          END AS score
--   FROM judgment_chunks
--   WHERE language_code = $lang
--     AND CASE WHEN $lang = 'en'
--       THEN tsv @@ plainto_tsquery('english', $query)
--       ELSE to_tsvector('simple', cjk_tokens) @@ plainto_tsquery('simple', $cjkquery)
--         OR cjk_tokens % $cjkquery
--     END
--   ORDER BY score DESC
--   LIMIT 15
-- ),
-- lex_r AS (SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC) AS rnk FROM lex),
-- vec AS (
--   SELECT id, embedding <=> $emb::halfvec(3072) AS dist
--   FROM judgment_chunks
--   WHERE language_code = $lang
--   ORDER BY embedding <=> $emb::halfvec(3072)
--   LIMIT 15
-- ),
-- vec_r AS (SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist) AS rnk FROM vec),
-- fused AS (
--   SELECT COALESCE(l.id, v.id) AS id,
--          COALESCE(1.0 / (60 + l.rnk), 0) + COALESCE(1.0 / (60 + v.rnk), 0) AS rrf,
--          l.rnk AS lexical_rank, v.dist AS vector_distance
--   FROM lex_r l FULL OUTER JOIN vec_r v USING (id)
-- )
-- SELECT c.judgment_id, c.chunk_no, c.neutral_citation, c.court_name, c.year, c.date,
--        c.parties, c.content, c.summary_source, c.url,
--        f.lexical_rank, f.vector_distance, f.rrf AS rrf_score,
--        CASE WHEN f.lexical_rank IS NOT NULL THEN ts_headline(
--               CASE WHEN $lang = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
--               c.content,
--               CASE WHEN $lang = 'en' THEN plainto_tsquery('english', $query)
--                    ELSE plainto_tsquery('simple', $cjkquery) END,
--               'MaxWords=60, MinWords=30, ShortWord=3')
--             ELSE left(c.content, 300) END AS snippet
-- FROM fused f JOIN judgment_chunks c ON c.id = f.id
-- ORDER BY f.rrf DESC
-- LIMIT 30;

-- ============ Q3: legislation_chunks (same shape; tsv built from heading+content per T17 loader) ============
-- WITH lex AS (
--   SELECT id,
--          CASE WHEN $lang = 'en'
--            THEN ts_rank(tsv, plainto_tsquery('english', $query))
--            ELSE 0.7 * ts_rank(to_tsvector('simple', cjk_tokens), plainto_tsquery('simple', $cjkquery))
--               + 0.3 * similarity(cjk_tokens, $cjkquery)
--          END AS score
--   FROM legislation_chunks
--   WHERE language_code = $lang
--     AND CASE WHEN $lang = 'en'
--       THEN tsv @@ plainto_tsquery('english', $query)
--       ELSE to_tsvector('simple', cjk_tokens) @@ plainto_tsquery('simple', $cjkquery)
--         OR cjk_tokens % $cjkquery
--     END
--   ORDER BY score DESC
--   LIMIT 15
-- ),
-- lex_r AS (SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC) AS rnk FROM lex),
-- vec AS (
--   SELECT id, embedding <=> $emb::halfvec(3072) AS dist
--   FROM legislation_chunks
--   WHERE language_code = $lang
--   ORDER BY embedding <=> $emb::halfvec(3072)
--   LIMIT 15
-- ),
-- vec_r AS (SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist) AS rnk FROM vec),
-- fused AS (
--   SELECT COALESCE(l.id, v.id) AS id,
--          COALESCE(1.0 / (60 + l.rnk), 0) + COALESCE(1.0 / (60 + v.rnk), 0) AS rrf,
--          l.rnk AS lexical_rank, v.dist AS vector_distance
--   FROM lex_r l FULL OUTER JOIN vec_r v USING (id)
-- )
-- SELECT c.section_id, c.chunk_no, c.cap_number, c.section_number, c.subsection_number,
--        c.heading, c.content, c.url, c.context,
--        f.lexical_rank, f.vector_distance, f.rrf AS rrf_score,
--        CASE WHEN f.lexical_rank IS NOT NULL THEN ts_headline(
--               CASE WHEN $lang = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
--               c.content,
--               CASE WHEN $lang = 'en' THEN plainto_tsquery('english', $query)
--                    ELSE plainto_tsquery('simple', $cjkquery) END,
--               'MaxWords=60, MinWords=30, ShortWord=3')
--             ELSE left(c.content, 300) END AS snippet
-- FROM fused f JOIN legislation_chunks c ON c.id = f.id
-- ORDER BY f.rrf DESC
-- LIMIT 30;

-- ============ Verify (run any time, read-only) ============
-- Counts per corpus/lang must match JSON/shard totals:
--   SELECT language_code, count(*) FROM clic_chunks GROUP BY 1;
--   SELECT language_code, count(*) FROM judgment_chunks GROUP BY 1;
--   SELECT language_code, count(*) FROM legislation_chunks GROUP BY 1;
-- Indexes present (\di): hnsw on embedding + GIN(tsv) + GIN(cjk_tokens) + GIN(content) per table.
-- Smoke (T08 acceptance): run Q1-Q3 on ~10 sample queries en+sc/tc; check top-30 non-empty,
--   dedupe by (nid,chunk_no)/(judgment_id,chunk_no)/(section_id,chunk_no), sc/tc returns rows,
--   and in-DB-embed vs app-embed top-15 equivalent.
