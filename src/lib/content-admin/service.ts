import { randomUUID } from "node:crypto";
import pg from "pg";
import Turndown from "turndown";
import { TokenTextSplitter } from "@langchain/textsplitters";
import OpenAI from "openai";
import { z } from "zod";
import {
  jobSchema,
  pageSchema,
  requestSchema,
  selection,
  type Job,
  type Change,
} from "./schema";
import { ContentError } from "./auth";

export async function withDatabase<T>(run: (db: pg.Client) => Promise<T>) {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
  });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}
const pagesSchema = z.array(pageSchema);
const columns = 'id,nid,title,content,topic,url,path,"contextualInformation"';
export function markdown(html: string) {
  const converter = new Turndown({
    headingStyle: "atx",
    bulletListMarker: "*",
  });
  converter.remove(["script", "style"]);
  return converter
    .turndown(html.replace(/<h2\b[^>]*>[\s\S]*?<\/h2\s*>/i, "<br><br>"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function references(html: string) {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(
    (x) => x[1].replace(/&amp;/g, "&"),
  );
}
const pathKey = (url: string) => {
  try {
    const u = new URL(url, "https://clic.org.hk");
    return u.pathname.replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
};
export async function prepare(db: pg.Client, raw: unknown) {
  const input = requestSchema.parse(raw);
  const wanted = selection(input);
  const requestedNids = input.rows.flatMap((r) =>
    r.nid === null ? [] : [r.nid],
  );
  const requestedUrls = input.rows.map((r) => r.url);
  const existing = pagesSchema.parse(
    (
      await db.query(
        `SELECT ${columns} FROM "ClicPage" WHERE "languageCode"='en' AND (nid=ANY($1::int[]) OR url=ANY($2::text[]))`,
        [requestedNids, requestedUrls],
      )
    ).rows,
  );
  const changes: Change[] = [];
  const used = new Map<number, string>();
  for (const entry of wanted) {
    const matches = input.rows.filter((r) => r.secondId === entry.secondId);
    if (matches.length !== 1)
      throw new ContentError(
        `Page ${entry.secondId} must appear exactly once in the workbook.`,
      );
    const row = matches[0];
    if (!row) throw new ContentError("Missing workbook row.");
    const beforeMatches = existing.filter((p) =>
      row.nid === null ? p.url === row.url : p.nid === row.nid,
    );
    if (beforeMatches.length > 1)
      throw new ContentError(
        `Page ${entry.secondId} matches multiple records.`,
      );
    const before = beforeMatches[0] ?? null;
    const nid = row.nid ?? before?.nid ?? null;
    if (nid !== null) {
      const previous = used.get(nid);
      if (previous && !(previous === "delete" && entry.action === "delete"))
        throw new ContentError(`Multiple actions target nid ${nid}.`);
      used.set(nid, entry.action);
    }
    if (entry.action === "add" && before)
      throw new ContentError(
        `Page ${entry.secondId} already exists. Select Update instead.`,
      );
    if (entry.action === "update" && !before)
      throw new ContentError(
        `Page ${entry.secondId} does not exist. Select Add instead.`,
      );
    const warnings: string[] = [];
    let after: Change["after"] = null;
    if (entry.action !== "delete") {
      if (!nid)
        throw new ContentError(`Page ${entry.secondId} has no valid nid.`);
      if (row.excluded)
        warnings.push(
          `Workbook marks this row deleted or struck through. Your selected action (${entry.action}) overrides that mark.`,
        );
      const content = markdown(row.html);
      let url: URL;
      try {
        url = new URL(row.url);
      } catch {
        throw new ContentError(`Page ${entry.secondId} has an invalid URL.`);
      }
      if (
        url.protocol !== "https:" ||
        url.hostname !== "clic.org.hk" ||
        !url.pathname.startsWith("/en/topics/") ||
        !content ||
        !row.title
      )
        throw new ContentError(
          `Page ${entry.secondId} needs an English CLIC article URL, title and body.`,
        );
      after = {
        nid,
        title: row.title,
        content,
        topic: url.pathname.split("/topics/")[1]?.split("/")[0] ?? row.topic,
        url: url.href,
        path: url.pathname,
        contextualInformation: row.topic,
      };
    } else if (!before) warnings.push("Already absent; nothing to delete.");
    const changed =
      entry.action === "delete"
        ? !!before
        : !before ||
          (!!after &&
            Object.entries(after).some(
              ([k, v]) => Reflect.get(before, k) !== v,
            ));
    changes.push({
      secondId: entry.secondId,
      action: entry.action,
      nid,
      before,
      after,
      changed,
      warnings,
      refs: references(row.html),
    });
  }
  const job: Job = {
    fileName: input.fileName,
    status: "preview",
    changes,
    warnings: [],
    links: input.links,
    createdAt: new Date().toISOString(),
    processed: 0,
    total: 0,
  };
  if (Buffer.byteLength(JSON.stringify(publicJob(job)), "utf8") > 2_800_000)
    throw new ContentError(
      "The before/after preview is too large. Use a smaller batch.",
      413,
    );
  const id = randomUUID();
  await db.query(
    "INSERT INTO content_import_jobs (id,payload) VALUES ($1,$2::jsonb)",
    [id, JSON.stringify(job)],
  );
  return { id, ...publicJob(job) };
}
export function publicJob(job: Job) {
  return {
    fileName: job.fileName,
    status: job.status,
    createdAt: job.createdAt,
    warnings: job.warnings,
    processed: job.processed,
    total: job.total,
    changes: job.changes.map(({ refs: _, ...c }) => c),
  };
}
export async function load(db: pg.Client, id: string, lock = false) {
  if (!z.uuid().safeParse(id).success)
    throw new ContentError("Invalid import ID.");
  const r = await db.query<{ payload: unknown }>(
    "SELECT payload FROM content_import_jobs WHERE id=$1" +
      (lock ? " FOR UPDATE NOWAIT" : ""),
    [id],
  );
  if (!r.rows[0]) throw new ContentError("Import not found.", 404);
  return jobSchema.parse(r.rows[0].payload);
}
async function save(db: pg.Client, id: string, job: Job) {
  await db.query(
    "UPDATE content_import_jobs SET payload=$2::jsonb,updated_at=now() WHERE id=$1",
    [id, JSON.stringify(job)],
  );
}
async function apply(db: pg.Client, job: Job, id: string) {
  // Serialize commits. Recheck every reviewed snapshot while holding page locks.
  await db.query("SELECT pg_advisory_xact_lock(724193)");
  const ids = job.changes
    .flatMap((c) => (c.nid === null ? [] : [c.nid]))
    .sort((a, b) => a - b);
  const snapshots = pagesSchema.parse(
    (
      await db.query(
        `SELECT ${columns} FROM "ClicPage" WHERE "languageCode"='en' AND nid=ANY($1::int[]) ORDER BY nid FOR UPDATE`,
        [ids],
      )
    ).rows,
  );
  for (const c of job.changes) {
    const now = snapshots.find((p) => p.nid === c.nid) ?? null;
    if (JSON.stringify(now) !== JSON.stringify(c.before))
      throw new ContentError(
        `Page ${c.secondId} changed since preview. Create a fresh preview.`,
        409,
      );
  }
  const deleting = new Set(
    job.changes
      .filter((c) => c.action === "delete" && c.nid !== null)
      .map((c) => c.nid),
  );
  const changed = job.changes.filter((c) => c.changed);
  const pageType =
    "nid int,title text,content text,topic text,url text,path text,context text";
  const data = (action: "add" | "update") =>
    JSON.stringify(
      changed.flatMap((c) =>
        c.action === action && c.after
          ? [{ ...c.after, context: c.after.contextualInformation }]
          : [],
      ),
    );
  await db.query(
    `INSERT INTO "ClicPage" (nid,title,content,topic,"languageCode",url,path,"contextualInformation","lastUpdatedAt") SELECT x.nid,x.title,x.content,x.topic,'en',x.url,x.path,x.context,now() FROM jsonb_to_recordset($1::jsonb) AS x(${pageType})`,
    [data("add")],
  );
  await db.query(
    `UPDATE "ClicPage" p SET title=x.title,content=x.content,topic=x.topic,url=x.url,path=x.path,"contextualInformation"=x.context,"lastUpdatedAt"=now() FROM jsonb_to_recordset($1::jsonb) AS x(${pageType}) WHERE p.nid=x.nid AND p."languageCode"='en'`,
    [data("update")],
  );
  const all = z
    .array(pageSchema.pick({ id: true, nid: true, url: true }))
    .parse(
      (
        await db.query(
          `SELECT id,nid,url FROM "ClicPage" WHERE "languageCode"='en'`,
        )
      ).rows,
    );
  const byPath = new Map<string, number>();
  const byNid = new Map(all.map((p) => [p.nid, p.id]));
  for (const p of all) byPath.set(pathKey(p.url), p.nid);
  for (const l of job.links) byPath.set(pathKey(l.url), l.nid);
  const affected = changed.flatMap((c) => (c.nid === null ? [] : [c.nid]));
  const affectedIds = affected.flatMap((n) => {
    const id = byNid.get(n);
    return id === undefined ? [] : [id];
  });
  const deleteIds = [...deleting].flatMap((n) => {
    if (n === null) return [];
    const id = byNid.get(n);
    return id === undefined ? [] : [id];
  });
  await db.query(
    `DELETE FROM clic_chunks WHERE language_code='en' AND nid=ANY($1::int[])`,
    [affected],
  );
  await db.query(
    'DELETE FROM "_ClicPageRelationToClicPage" WHERE "B"=ANY($1::int[]) OR "A"=ANY($2::int[])',
    [affectedIds, deleteIds],
  );
  for (const t of [
    "_ClicPageToLegislationSection",
    "_ClicPageToLegislationCap",
  ])
    await db.query(`DELETE FROM "${t}" WHERE "A"=ANY($1::int[])`, [
      affectedIds,
    ]);
  await db.query('DELETE FROM "_ClicPageToJudgment" WHERE "A"=ANY($1::int[])', [
    deleteIds,
  ]);
  await db.query('DELETE FROM "ClicPage" WHERE id=ANY($1::int[])', [deleteIds]);
  const caps = z
    .array(z.object({ id: z.number(), capNumber: z.string() }))
    .parse(
      (
        await db.query(
          'SELECT id,"capNumber" FROM "LegislationCap" WHERE "languageCode"=\'en\'',
        )
      ).rows,
    );
  const sections = z
    .array(
      z.object({
        id: z.number(),
        capNumber: z.string(),
        sectionNumber: z.string(),
      }),
    )
    .parse(
      (
        await db.query(
          'SELECT id,"capNumber","sectionNumber" FROM "LegislationSection" WHERE "languageCode"=\'en\'',
        )
      ).rows,
    );
  const capMap = new Map(caps.map((c) => [c.capNumber, c.id]));
  const sectionMap = new Map<string, number[]>();
  for (const sec of sections) {
    const key = sec.capNumber + "/" + sec.sectionNumber.replace(/^s/i, "");
    sectionMap.set(key, [...(sectionMap.get(key) ?? []), sec.id]);
  }
  const pp: { a: number; b: number }[] = [],
    ss: { a: number; b: number }[] = [],
    cc: { a: number; b: number }[] = [];
  for (const c of changed) {
    if (c.action === "delete" || !c.after) continue;
    const a = c.after,
      pid = byNid.get(a.nid);
    if (pid === undefined) throw new Error("Missing written page");
    for (const ref of new Set(c.refs)) {
      let u: URL;
      try {
        u = new URL(ref, "https://clic.org.hk");
      } catch {
        continue;
      }
      if (u.hostname === "clic.org.hk" && u.pathname.includes("/topics/")) {
        const nid = byPath.get(pathKey(u.href)),
          target = nid === undefined ? undefined : byNid.get(nid);
        if (target !== undefined && nid !== undefined && !deleting.has(nid))
          pp.push({ a: target, b: pid });
        else
          job.warnings.push(
            `Page ${c.secondId}: unresolved CLIC link ${u.pathname}`,
          );
      }
      if (/(^|\.)hklii\.hk$/.test(u.hostname)) {
        const match = /\/(ord|reg|instrument)\/([^/]+)(?:\/([^/]+))?/.exec(
          u.pathname,
        );
        if (match) {
          const cap =
            match[1] === "instrument" && /^\d+$/.test(match[2])
              ? "A" + match[2]
              : match[2];
          const section = (match[3] ?? "")
            .replace(/\.html$/, "")
            .replace(/^s/i, "");
          const targets = sectionMap.get(cap + "/" + section) ?? [];
          if (section && targets.length)
            for (const id of targets) ss.push({ a: pid, b: id });
          else {
            const capId = capMap.get(cap);
            if (capId !== undefined) cc.push({ a: pid, b: capId });
            else
              job.warnings.push(
                `Page ${c.secondId}: unresolved legislation ${cap}/${section}`,
              );
          }
        } else if (u.pathname.includes("/cases/"))
          job.warnings.push(
            `Page ${c.secondId}: case link retained; existing case relationships preserved.`,
          );
      }
    }
  }
  for (const [table, edges] of [
    ["_ClicPageRelationToClicPage", pp],
    ["_ClicPageToLegislationSection", ss],
    ["_ClicPageToLegislationCap", cc],
  ] satisfies [string, { a: number; b: number }[]][]) {
    await db.query(
      `INSERT INTO "${table}" ("A","B") SELECT a,b FROM jsonb_to_recordset($1::jsonb) AS x(a int,b int) ON CONFLICT DO NOTHING`,
      [JSON.stringify(edges)],
    );
  }
  const staged = await db.query<{ total: number; ready: number }>(
    "SELECT count(*)::int AS total,count(embedding)::int AS ready FROM content_import_chunks WHERE job_id=$1",
    [id],
  );
  const counts = staged.rows[0];
  if (!counts || counts.total !== job.total || counts.ready !== job.total)
    throw new Error("Incomplete staged search data");
  const published = await db.query(
    `INSERT INTO clic_chunks (nid,chunk_no,language_code,title,content,url,topic,context,embedding,tsv)
    SELECT s.nid,s.chunk_no,'en',p.title,s.content,p.url,p.topic,p."contextualInformation",s.embedding,to_tsvector('english',p.title||' '||s.content)
    FROM content_import_chunks s JOIN "ClicPage" p ON p.nid=s.nid AND p."languageCode"='en' WHERE s.job_id=$1`,
    [id],
  );
  if (published.rowCount !== job.total)
    throw new Error("Published chunk count mismatch");
}
export async function advance(db: pg.Client, id: string) {
  await db.query("BEGIN");
  try {
    const job = await load(db, id, true);
    if (job.status === "complete") {
      await db.query("COMMIT");
      return { id, ...publicJob(job) };
    }
    if (job.status === "preview") {
      const splitter = new TokenTextSplitter({
        chunkSize: 512,
        chunkOverlap: 128,
        encodingName: "o200k_base",
      });
      const chunks: { nid: number; number: number; content: string }[] = [];
      for (const c of job.changes.filter((c) => c.changed && c.after)) {
        const page = c.after;
        if (!page) continue;
        const texts = await splitter.splitText(page.content);
        if (!texts.length)
          throw new ContentError(`Page ${c.secondId} has an empty body.`);
        chunks.push(
          ...texts.map((content, number) => ({
            nid: page.nid,
            number,
            content,
          })),
        );
      }
      await db.query(
        `INSERT INTO content_import_chunks (job_id,nid,chunk_no,content) SELECT $1::uuid,nid,number,content FROM jsonb_to_recordset($2::jsonb) AS x(nid int,number int,content text)`,
        [id, JSON.stringify(chunks)],
      );
      job.total = chunks.length;
      job.status = "indexing";
    }
    const batch = z
      .array(
        z.object({ nid: z.number(), number: z.number(), content: z.string() }),
      )
      .parse(
        (
          await db.query(
            "SELECT nid,chunk_no AS number,content FROM content_import_chunks WHERE job_id=$1 AND embedding IS NULL ORDER BY nid,chunk_no LIMIT 16",
            [id],
          )
        ).rows,
      );
    if (batch.length) {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, "");
      if (!endpoint || !process.env.AZURE_OPENAI_KEY)
        throw new ContentError("Embedding service is not configured.", 503);
      const client = new OpenAI({
        apiKey: process.env.AZURE_OPENAI_KEY,
        baseURL: endpoint.replace(/\/openai\/v1$/, "") + "/openai/v1/",
        timeout: 45000,
        maxRetries: 1,
        ...(/\.services\.ai\.azure\.com/.test(endpoint)
          ? {}
          : { defaultQuery: { "api-version": "preview" } }),
      });
      const result = await client.embeddings.create({
        model:
          process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ||
          "text-embedding-3-large",
        input: batch.map((c) => c.content),
        encoding_format: "float",
      });
      if (result.data.length !== batch.length)
        throw new Error("Incomplete embeddings");
      const seen = new Set<number>();
      const vectors = result.data.map((item) => {
        const chunk = batch[item.index];
        if (!chunk || seen.has(item.index))
          throw new Error("Invalid embedding index");
        seen.add(item.index);
        const embedding = z
          .array(z.number().finite())
          .length(3072)
          .parse(item.embedding);
        return {
          nid: chunk.nid,
          number: chunk.number,
          embedding: "[" + embedding.join(",") + "]",
        };
      });
      const written = await db.query(
        `UPDATE content_import_chunks s SET embedding=x.embedding::halfvec FROM jsonb_to_recordset($2::jsonb) AS x(nid int,number int,embedding text) WHERE s.job_id=$1 AND s.nid=x.nid AND s.chunk_no=x.number AND s.embedding IS NULL`,
        [id, JSON.stringify(vectors)],
      );
      if (written.rowCount !== vectors.length)
        throw new Error("Staging write mismatch");
      job.processed += vectors.length;
    } else {
      await apply(db, job, id);
      job.status = "complete";
      await db.query("DELETE FROM content_import_chunks WHERE job_id=$1", [id]);
    }
    await save(db, id, job);
    await db.query("COMMIT");
    return { id, ...publicJob(job) };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
