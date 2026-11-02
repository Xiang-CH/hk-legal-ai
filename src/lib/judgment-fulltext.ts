import { z as _schema } from "zod";
import { prisma } from "@/lib/prisma";

export const fulltextEnabled = () => process.env.JUDGMENT_FULLTEXT_ENABLED === "true";
const span = _schema.object({ position: _schema.number().int(), label: _schema.string().nullable(), anchor: _schema.string().nullable(), start: _schema.number().int(), end: _schema.number().int() });
export const sourceFields = {
 contentType: _schema.literal("fulltext").optional(),
 startPosition: _schema.number().optional(), endPosition: _schema.number().optional(),
 startOffset: _schema.number().optional(), endOffset: _schema.number().optional(),
 documentId: _schema.string().optional(), languageCode: _schema.string().optional(),
 sourceAnchor: _schema.string().nullable().optional(), spans: _schema.array(span).optional(),
};
const hitSchema = _schema.object({
 judgmentId: _schema.number(), chunk_no: _schema.number(), content: _schema.string(), snippet: _schema.string(),
 neutralCitation: _schema.string().nullable(), courtName: _schema.string().nullable(), year: _schema.number().nullable(),
 date: _schema.union([_schema.date(), _schema.string()]).nullable(), parties: _schema.string().nullable(),
 summarySource: _schema.string().nullable(), url: _schema.string().nullable(),
 lexical_rank: _schema.number().nullable(), vector_distance: _schema.number().nullable(), rrf_score: _schema.number(),
 ...sourceFields,
});
export async function searchFulltext(query: string, tokens: string, embedding: number[] | null, languages: string[]) {
 if (embedding && (embedding.length !== 3072 || !embedding.every(Number.isFinite))) throw new Error("Invalid query embedding");
 const rows = await prisma.$queryRawUnsafe<unknown>(`
 WITH current AS NOT MATERIALIZED (
 SELECT c.* FROM judgment_fulltext_chunks c
 JOIN judgment_fulltext_active a ON a.document_id=c.document_id AND a.generation=c.generation
 JOIN judgment_documents d ON d.id=c.document_id AND d.generation::text=c.document_generation
 WHERE c.language_code=ANY($4)
 ), lex AS (
 SELECT id, row_number() OVER(ORDER BY (ts_rank(tsv,plainto_tsquery('english',$1))+ts_rank(to_tsvector('simple',cjk_tokens),plainto_tsquery('simple',$2))) DESC,id) AS rank
 FROM current WHERE tsv @@ plainto_tsquery('english',$1)
 OR to_tsvector('simple',cjk_tokens) @@ plainto_tsquery('simple',$2) ORDER BY rank,id LIMIT 15
 ), vec AS (
 SELECT id, embedding <=> $3::halfvec AS distance FROM current WHERE embedding IS NOT NULL AND status='ready' AND $3::halfvec IS NOT NULL
 AND model='text-embedding-3-large' AND deployment=$5 AND model_version=$6
 ORDER BY embedding <=> $3::halfvec,id LIMIT 15
 ), vr AS (SELECT *,row_number() OVER(ORDER BY distance,id) AS rank FROM vec)
 SELECT c.judgment_id AS "judgmentId",c.chunk_no,c.content,left(c.content,600) AS snippet,
 c.neutral_citation AS "neutralCitation",c.court_name AS "courtName",c.year,to_char(c.date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS date,c.parties,
 c.summary_source AS "summarySource",c.url,
 lex.rank::int AS lexical_rank,vr.distance::float8 AS vector_distance,
 (coalesce(1.0/(60+lex.rank),0)+coalesce(1.0/(60+vr.rank),0))::float8 AS rrf_score,
 'fulltext' AS "contentType",c.document_id::text AS "documentId",c.language_code AS "languageCode",
 c.start_position AS "startPosition",c.end_position AS "endPosition",
 c.start_offset AS "startOffset",c.end_offset AS "endOffset",c.spans,
 jsonb_path_query_first(c.spans,'$[*] ? (@.anchor != null)')->>'anchor' AS "sourceAnchor"
 FROM current c LEFT JOIN lex ON lex.id=c.id LEFT JOIN vr ON vr.id=c.id
 WHERE lex.id IS NOT NULL OR vr.id IS NOT NULL ORDER BY rrf_score DESC,c.id LIMIT 30
 `,query,tokens,embedding ? JSON.stringify(embedding) : null,languages,process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? 'text-embedding-3-large',process.env.JUDGMENT_EMBEDDING_VERSION ?? '1');
 return _schema.array(hitSchema).parse(rows).map(hit => ({
 ...hit, url: hit.url && hit.sourceAnchor ? hit.url.split("#")[0] + "#" + hit.sourceAnchor.replace(/^#/, "") : hit.url,
 }));
}
const paragraphSchema = _schema.object({ id:_schema.string(), position:_schema.number(), label:_schema.string().nullable(), anchor:_schema.string().nullable(), block_type:_schema.string(), content:_schema.string(), truncated:_schema.boolean().optional() });
const occurrenceSchema=_schema.object({id:_schema.string(),reference_id:_schema.string(),evidence_key:_schema.string(),paragraph_id:_schema.string().nullable(),anchor:_schema.string().nullable(),evidence:_schema.record(_schema.string(),_schema.unknown())});
const legislationSchema=_schema.object({id:_schema.string(),source_id:_schema.number(),original:_schema.string(),status:_schema.string(),cap_id:_schema.number().nullable(),section_id:_schema.number().nullable(),capNumber:_schema.string().nullable(),sectionNumber:_schema.string().nullable(),targetUrl:_schema.string().nullable(),heading:_schema.string().nullable(),provenance:_schema.record(_schema.string(),_schema.unknown())});
export const documentOutputSchema = _schema.object({
 cases:_schema.array(_schema.object({caseAct:_schema.string(),title:_schema.string(),judgments:_schema.array(_schema.object({id:_schema.number(),chunk_no:_schema.literal(0),neutralCitation:_schema.string(),courtName:_schema.string(),year:_schema.number(),date:_schema.string(),url:_schema.string(),summary:_schema.string().nullable()}))})),
 document: _schema.object({id:_schema.string(), judgment_id:_schema.number(), generation:_schema.string(), source_path:_schema.string(), parser_version:_schema.string(),url:_schema.string(),neutralCitation:_schema.string()}),
 paragraphs:_schema.array(paragraphSchema),
 references:_schema.array(_schema.object({id:_schema.string(),source_id:_schema.number(),target_id:_schema.number().nullable(),kind:_schema.string(),original:_schema.string(),normalized:_schema.string(),status:_schema.string()})),
 occurrences:_schema.array(occurrenceSchema),
 legislation:_schema.array(legislationSchema),
 nextReferenceId:_schema.string().nullable(),
 nextLegislationId:_schema.string().nullable(),
 truncated:_schema.boolean(),
});
export async function getFulltext(id:number,start:number,end:number,direction:"incoming"|"outgoing"|"both"|"none",limit:number,referenceAfter="0",legislationAfter="0") {
 const documents = _schema.array(documentOutputSchema.shape.document).parse(await prisma.$queryRawUnsafe<unknown>(
 'SELECT d.id::text,d.judgment_id,d.generation::text,d.source_path,d.parser_version,j.url,j."neutralCitation" FROM judgment_documents d JOIN "Judgment" j ON j.id=d.judgment_id WHERE d.judgment_id=$1',id));
 const document=documents[0];
 if(!document) throw new Error("Judgment document not found");
 const rows=_schema.array(paragraphSchema).parse(await prisma.$queryRawUnsafe<unknown>(
 'SELECT id::text,position,label,anchor,block_type,left(content,30000) AS content,length(content)>30000 AS truncated FROM judgment_paragraphs WHERE document_id=$1::bigint AND position BETWEEN $2 AND $3 ORDER BY position LIMIT 100',document.id,start,end));
 let remaining=30000;
 const paragraphs: _schema.infer<typeof paragraphSchema>[]=[];
 for(const row of rows) {
  if(remaining<=0) break;
  const content=row.content.slice(0,remaining);
  paragraphs.push({...row,content,truncated:row.truncated || content.length<row.content.length});
  remaining-=content.length;
 }
 const referenceRows=direction==="none"?[]:_schema.array(documentOutputSchema.shape.references.element).parse(await prisma.$queryRawUnsafe<unknown>(
 `SELECT r.id::text,r.source_id,r.target_id,r.kind,r.original,r.normalized,r.status FROM judgment_references r
 JOIN judgment_documents d ON d.judgment_id=r.source_id AND r.provenance->>'generation'=d.generation::text WHERE
 r.id>$4::bigint AND (status<>'self') AND (($2 IN ('outgoing','both') AND source_id=$1) OR ($2 IN ('incoming','both') AND target_id=$1 AND status='resolved'))
 ORDER BY r.id LIMIT $3`,id,direction,limit+1,referenceAfter));
 const references=referenceRows.slice(0,limit);
 const occurrences=references.length?_schema.array(occurrenceSchema).parse(await prisma.$queryRawUnsafe<unknown>(
 `SELECT id::text,reference_id::text,evidence_key,paragraph_id::text,anchor,evidence FROM (
 SELECT *,row_number() OVER(PARTITION BY reference_id ORDER BY id) AS occurrence_rank FROM judgment_reference_occurrences WHERE reference_id=ANY($1::bigint[])
 ) occurrences WHERE occurrence_rank<=3 ORDER BY reference_id,id LIMIT $2`,references.map(reference=>reference.id),limit*3)):[];
 const legislationRows=direction==='incoming' || direction==='none'?[]:_schema.array(legislationSchema).parse(await prisma.$queryRawUnsafe<unknown>(
 `SELECT r.id::text,r.source_id,r.original,r.status,r.cap_id,r.section_id,r.provenance,
 coalesce(cap."capNumber",section."capNumber") AS "capNumber",section."sectionNumber" AS "sectionNumber",
 coalesce(section.url,cap.url) AS "targetUrl",coalesce(section."sectionHeading",cap.title) AS heading
 FROM judgment_legislation_references r JOIN judgment_documents d ON d.judgment_id=r.source_id AND r.provenance->>'generation'=d.generation::text
 LEFT JOIN "LegislationCap" cap ON cap.id=r.cap_id LEFT JOIN "LegislationSection" section ON section.id=r.section_id
 WHERE r.source_id=$1 AND r.id>$3::bigint ORDER BY r.id LIMIT $2`,id,limit+1,legislationAfter));
 const legislation=legislationRows.slice(0,limit);
 return {cases:[],document,paragraphs,references,occurrences,legislation,nextReferenceId:referenceRows.length>limit ? references.at(-1)?.id??null : null,nextLegislationId:legislationRows.length>limit ? legislation.at(-1)?.id??null : null,truncated:paragraphs.length<rows.length || paragraphs.some(paragraph=>paragraph.truncated)};
}
