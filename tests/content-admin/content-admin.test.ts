import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import pg from "pg";
import ExcelJS from "exceljs";
import { parseIds, selection } from "../../src/lib/content-admin/schema";
import { readWorkbook } from "../../src/lib/content-admin/workbook";
import {
  markdown,
  prepare,
  advance,
  load,
} from "../../src/lib/content-admin/service";
import { authorize } from "../../src/lib/content-admin/auth";

const connection = process.env.CONTENT_ADMIN_TEST_DATABASE_URL;
if (
  connection &&
  !["127.0.0.1", "localhost"].includes(new URL(connection).hostname)
)
  throw new Error("Tests require an isolated local database.");
let db: pg.Client;
const provider = http.createServer(async (req, res) => {
  let text = "";
  for await (const part of req) text += part;
  const input: unknown = JSON.parse(text);
  if (
    !input ||
    typeof input !== "object" ||
    !("input" in input) ||
    !Array.isArray(input.input)
  )
    throw new Error("Invalid embedding input");
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      data: input.input.map((_, index) => ({
        index,
        embedding: Array(3072).fill(0.01),
      })),
      usage: { total_tokens: 1 },
    }),
  );
});
before(async () => {
  if (!connection) return;
  process.env.DATABASE_URL = connection;
  db = new pg.Client({ connectionString: connection });
  await db.connect();
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("Missing address");
  process.env.AZURE_OPENAI_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.AZURE_OPENAI_KEY = "test-only";
});
after(async () => {
  if (connection) {
    await db.end();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
test("ranges are inclusive, deduplicated, bounded, and cannot overlap actions", () => {
  assert.deepEqual(parseIds("1–2,11; 14, 2"), [1, 2, 11, 14]);
  for (const value of ["3-1", "0", "foo", "1-501", "1.5", "1-2-3"])
    assert.throws(() => parseIds(value));
  assert.throws(() => selection({ adds: "1", updates: "1", deletes: "" }));
});
test("removing a heading preserves text and discards executable HTML", () => {
  assert.match(markdown("Before<h2>Title</h2>After"), /Before\s+After/);
  assert.equal(
    markdown("<h2>Title</h2><p>Body</p><script>alert(1)</script>"),
    "Body",
  );
});
test("admin authorization denies missing config, wrong key and foreign origin", () => {
  delete process.env.CLIC_CONTENT_ADMIN_TOKEN;
  assert.throws(() => authorize(new Request("http://localhost/api")));
  process.env.CLIC_CONTENT_ADMIN_TOKEN =
    "content-test-key-at-least-24-characters";
  assert.throws(() =>
    authorize(
      new Request("http://localhost/api", {
        headers: { Authorization: "Bearer nope" },
      }),
    ),
  );
  assert.throws(() =>
    authorize(
      new Request("http://localhost/api", {
        headers: {
          Authorization: "Bearer " + process.env.CLIC_CONTENT_ADMIN_TOKEN,
          Origin: "https://other.example",
        },
      }),
    ),
  );
  authorize(
    new Request("http://localhost:3105/api", {
      headers: {
        Authorization: "Bearer " + process.env.CLIC_CONTENT_ADMIN_TOKEN,
        Host: "127.0.0.1:3105",
        Origin: "http://127.0.0.1:3105",
      },
    }),
  );
  authorize(
    new Request("http://localhost/api", {
      headers: {
        Authorization: "Bearer " + process.env.CLIC_CONTENT_ADMIN_TOKEN,
        Origin: "http://localhost",
      },
    }),
  );
});
test("Excel maps column C, rich text and missing nid without using row numbers", async () => {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("EN");
  s.addRow([
    "langcode",
    "1st_id",
    "2nd_id",
    "nid",
    "title",
    "full_path",
    "topic",
    "content",
    "Result",
  ]);
  s.addRow([
    "en",
    "",
    2759,
    3544,
    "Page",
    "https://clic.org.hk/en/topics/page",
    "Test",
    "<p>Body</p>",
    "",
  ]);
  s.addRow([
    "en",
    "",
    257,
    null,
    "Deleted",
    "https://clic.org.hk/en/topics/old",
    "Test",
    "",
    "Delete",
  ]);
  const buffer = await w.xlsx.writeBuffer();
  const result = await readWorkbook(new Uint8Array(buffer).buffer);
  assert.equal(result.rows[0]?.secondId, 2759);
  assert.equal(result.rows[0]?.nid, 3544);
  assert.equal(result.rows[1]?.nid, null);
  assert.equal(result.rows[1]?.excluded, true);
});
const live = { skip: !connection };
const row = (secondId: number, nid: number, title = "Page") => ({
  secondId,
  nid,
  title,
  url: `https://clic.org.hk/en/topics/page-${nid}`,
  topic: "Test",
  html: `<h2>${title}</h2><p>New searchable body.</p>`,
  excluded: false,
});
async function seed() {
  await db.query('TRUNCATE content_import_jobs,"ClicPage" CASCADE');
  await db.query(
    `INSERT INTO "ClicPage" (nid,title,content,topic,"languageCode",url,path,"contextualInformation","lastUpdatedAt") VALUES (10,'Old','Old body','Test','en','https://clic.org.hk/en/topics/page-10','/en/topics/page-10','Test',now()),(20,'Remove','Remove body','Test','en','https://clic.org.hk/en/topics/page-20','/en/topics/page-20','Test',now())`,
  );
}
test(
  "preview is read-only; resume atomically updates pages, references, chunks and deletes",
  live,
  async () => {
    await seed();
    const update = row(100, 10, "Updated");
    update.html += '<a href="/en/topics/page-30">New page</a>';
    const planned = await prepare(db, {
      fileName: "list.xlsx",
      adds: "300",
      updates: "100",
      deletes: "200",
      rows: [update, row(200, 20), row(300, 30, "Added")],
      links: [{ nid: 30, url: "https://clic.org.hk/en/topics/page-30" }],
    });
    assert.equal(
      (await db.query('SELECT title FROM "ClicPage" WHERE nid=10')).rows[0]
        .title,
      "Old",
    );
    const first = await advance(db, planned.id);
    assert.equal(first.status, "indexing");
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM "ClicPage" WHERE nid=30'))
        .rows[0].n,
      0,
    );
    const complete = await advance(db, planned.id);
    assert.equal(complete.status, "complete");
    assert.deepEqual(
      (await db.query('SELECT nid,title FROM "ClicPage" ORDER BY nid')).rows,
      [
        { nid: 10, title: "Updated" },
        { nid: 30, title: "Added" },
      ],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM clic_chunks WHERE embedding IS NOT NULL AND tsv IS NOT NULL",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int n FROM "_ClicPageRelationToClicPage"',
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await advance(db, planned.id)).status, "complete");
  },
);
test("a stale preview cannot overwrite a concurrent edit", live, async () => {
  await seed();
  const p = await prepare(db, {
    fileName: "list.xlsx",
    adds: "",
    updates: "100",
    deletes: "",
    rows: [row(100, 10)],
    links: [],
  });
  await advance(db, p.id);
  await db.query(
    "UPDATE \"ClicPage\" SET content='Concurrent edit' WHERE nid=10",
  );
  await assert.rejects(advance(db, p.id), /changed since preview/);
  assert.equal((await load(db, p.id)).status, "indexing");
  assert.equal(
    (await db.query('SELECT content FROM "ClicPage" WHERE nid=10')).rows[0]
      .content,
    "Concurrent edit",
  );
});
test(
  "failure during deletion rolls back the accompanying update and chunk writes",
  live,
  async () => {
    await seed();
    const p = await prepare(db, {
      fileName: "list.xlsx",
      adds: "",
      updates: "100",
      deletes: "200",
      rows: [row(100, 10), row(200, 20)],
      links: [],
    });
    await advance(db, p.id);
    await db.query(
      `CREATE OR REPLACE FUNCTION content_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER content_test_failure BEFORE DELETE ON "ClicPage" FOR EACH ROW EXECUTE FUNCTION content_test_fail()`,
    );
    try {
      await assert.rejects(advance(db, p.id));
      assert.equal(
        (await db.query('SELECT title FROM "ClicPage" WHERE nid=10')).rows[0]
          .title,
        "Old",
      );
      assert.equal((await load(db, p.id)).status, "indexing");
    } finally {
      await db.query(
        'DROP TRIGGER content_test_failure ON "ClicPage"; DROP FUNCTION content_test_fail()',
      );
    }
    assert.equal((await advance(db, p.id)).status, "complete");
  },
);
test(
  "real November workbook includes all 215 addition IDs",
  { skip: !process.env.CLIC_TEST_WORKBOOK },
  async () => {
    const buffer = await fs.readFile(process.env.CLIC_TEST_WORKBOOK ?? "");
    const workbook = await readWorkbook(new Uint8Array(buffer).buffer);
    assert.equal(
      workbook.rows.filter((r) => r.secondId >= 2759 && r.secondId <= 2973)
        .length,
      215,
    );
  },
);

test(
  "flagged rows show an explicit override warning and retain the topic key",
  live,
  async () => {
    await seed();
    const r = row(100, 10);
    r.excluded = true;
    const p = await prepare(db, {
      fileName: "list.xlsx",
      adds: "",
      updates: "100",
      deletes: "",
      rows: [r],
      links: [],
    });
    assert.match(p.changes[0]?.warnings[0] ?? "", /overrides/);
    assert.equal(p.changes[0]?.after?.topic, "page-10");
    assert.equal(p.changes[0]?.after?.contextualInformation, "Test");
  },
);
test(
  "deletion can resolve a missing nid by URL and aliases only delete once",
  live,
  async () => {
    await seed();
    const r = row(200, 20);
    const alias = { ...r, secondId: 201, nid: null };
    const p = await prepare(db, {
      fileName: "list.xlsx",
      adds: "",
      updates: "",
      deletes: "200-201",
      rows: [r, alias],
      links: [],
    });
    assert.equal(p.changes[1]?.nid, 20);
    assert.equal((await advance(db, p.id)).status, "complete");
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM "ClicPage" WHERE nid=20'))
        .rows[0].n,
      0,
    );
  },
);
test(
  "a concurrent insert cannot be overwritten by an add preview",
  live,
  async () => {
    await seed();
    const p = await prepare(db, {
      fileName: "list.xlsx",
      adds: "300",
      updates: "",
      deletes: "",
      rows: [row(300, 30)],
      links: [],
    });
    await advance(db, p.id);
    await db.query(
      `INSERT INTO "ClicPage" (nid,title,content,topic,"languageCode",url,path,"contextualInformation","lastUpdatedAt") VALUES (30,'Concurrent','Keep me','Test','en','https://clic.org.hk/en/topics/page-30','/en/topics/page-30','Test',now())`,
    );
    await assert.rejects(advance(db, p.id), /changed since preview/);
    assert.equal(
      (await db.query('SELECT content FROM "ClicPage" WHERE nid=30')).rows[0]
        .content,
      "Keep me",
    );
  },
);

test("HTML gateway errors provide status and resume guidance instead of JSON parser errors", async () => {
  const { readResponse } = await import("../../src/lib/content-admin/response");
  await assert.rejects(
    readResponse(new Response("<html>Timeout</html>", { status: 504 })),
    /504.*Recent batches/,
  );
  await assert.rejects(
    readResponse(new Response("not json", { status: 200 })),
    /Invalid server response/,
  );
  await assert.rejects(
    readResponse(
      Response.json({ error: "Page changed since preview" }, { status: 409 }),
    ),
    /Page changed since preview/,
  );
  assert.deepEqual(await readResponse(Response.json({ status: "complete" })), {
    status: "complete",
  });
});
test(
  "multiple embedding steps keep job metadata bounded and publish staged vectors inside Postgres",
  live,
  async () => {
    await seed();
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ...row(1000 + i, 1000 + i),
      html:
        "<h2>Title</h2><p>" +
        "Distinct searchable body text. ".repeat(400) +
        "</p>",
    }));
    const p = await prepare(db, {
      fileName: "large.xlsx",
      adds: "1000-1039",
      updates: "",
      deletes: "",
      rows,
      links: [],
    });
    const first = await advance(db, p.id);
    assert.equal(first.processed, 16);
    assert.ok(first.total > 32);
    const bytes = async () =>
      Number(
        (
          await db.query(
            "SELECT octet_length(payload::text)::int AS n FROM content_import_jobs WHERE id=$1",
            [p.id],
          )
        ).rows[0].n,
      );
    const firstBytes = await bytes();
    const next = await advance(db, p.id);
    assert.equal(next.processed, 32);
    assert.ok(Math.abs((await bytes()) - firstBytes) < 128);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM content_import_chunks WHERE job_id=$1 AND embedding IS NOT NULL",
          [p.id],
        )
      ).rows[0].n,
      32,
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM "ClicPage" WHERE nid>=1000',
        )
      ).rows[0].n,
      0,
    );
    let completed = next;
    for (let i = 0; completed.status !== "complete" && i < 100; i++)
      completed = await advance(db, p.id);
    assert.equal(completed.status, "complete");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM clic_chunks WHERE nid>=1000",
        )
      ).rows[0].n,
      first.total,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM content_import_chunks WHERE job_id=$1",
          [p.id],
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  "staging migration preserves legacy in-progress vectors and completed progress",
  live,
  async () => {
    const { randomUUID } = await import("node:crypto");
    const schema = "content_migration_" + randomUUID().replaceAll("-", "");
    await db.query(
      `CREATE SCHEMA ${schema}; SET search_path TO ${schema},public`,
    );
    try {
      await db.query(
        "CREATE TABLE content_import_jobs (id uuid PRIMARY KEY,payload jsonb NOT NULL)",
      );
      const vector = Array(3072).fill(0.01);
      const legacy = {
        changes: [
          {
            title: "Retain this metadata",
            chunks: [
              { nid: 10, number: 0, content: "Ready chunk", embedding: vector },
              { nid: 10, number: 1, content: "Pending chunk", embedding: null },
            ],
          },
        ],
      };
      const ongoing = randomUUID(),
        complete = randomUUID();
      for (const [id, status] of [
        [ongoing, "indexing"],
        [complete, "complete"],
      ])
        await db.query(
          "INSERT INTO content_import_jobs VALUES ($1,$2::jsonb)",
          [id, JSON.stringify({ ...legacy, status })],
        );
      await db.query(
        await fs.readFile(
          "prisma/migrations/20261110010000_content_import_chunks/migration.sql",
          "utf8",
        ),
      );
      const payload = (
        await db.query("SELECT payload FROM content_import_jobs WHERE id=$1", [
          ongoing,
        ])
      ).rows[0].payload;
      assert.equal(payload.total, 2);
      assert.equal(payload.processed, 1);
      assert.equal(payload.changes[0].title, "Retain this metadata");
      assert.equal("chunks" in payload.changes[0], false);
      assert.deepEqual(
        (
          await db.query(
            "SELECT count(*)::int n,count(embedding)::int ready FROM content_import_chunks WHERE job_id=$1",
            [ongoing],
          )
        ).rows[0],
        { n: 2, ready: 1 },
      );
      const done = (
        await db.query("SELECT payload FROM content_import_jobs WHERE id=$1", [
          complete,
        ])
      ).rows[0].payload;
      assert.equal(done.total, 2);
      assert.equal(done.processed, 2);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM content_import_chunks WHERE job_id=$1",
            [complete],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await db.query("ROLLBACK");
      await db.query("SET search_path TO public");
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  },
);
