import { z } from "zod";
import { historySchema } from "@/lib/content-admin/schema";
import { authorize, ContentError, failure } from "@/lib/content-admin/auth";
import { prepare, withDatabase } from "@/lib/content-admin/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Page through durable batches in a stable creation-time/ID order, including older interrupted work. */
export async function GET(request: Request) {
  try {
    await authorize(request);
    return await withDatabase(async (db) => {
      const before = new URL(request.url).searchParams.get("before");
      if (before !== null && !z.uuid().safeParse(before).success)
        throw new ContentError("Invalid history cursor.");
      const rows = await db.query(
        "SELECT id,payload->>'fileName' AS name,payload->>'status' AS status,created_at AS \"createdAt\" FROM content_import_jobs WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM content_import_jobs WHERE id=$1::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21",
        [before],
      );
      const jobs = historySchema.shape.jobs.element
        .extend({ createdAt: z.date() })
        .array()
        .parse(rows.rows)
        .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
      return Response.json(
        historySchema.parse({
          jobs: jobs.slice(0, 20),
          nextCursor: jobs.length > 20 ? jobs[19]?.id : null,
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (e) {
    return failure(e);
  }
}
/** Bound the selected-row JSON stream before parsing and creating a read-only import preview. */
export async function POST(request: Request) {
  try {
    await authorize(request);
    const reader = request.body?.getReader();
    if (!reader) throw new ContentError("Missing workbook data.");
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3_000_000) {
        await reader.cancel();
        throw new ContentError(
          "The selected pages are too large. Use a smaller batch.",
          413,
        );
      }
      parts.push(value);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new ContentError("Invalid workbook data.");
    }
    return await withDatabase(async (db) =>
      Response.json(await prepare(db, raw), {
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (e) {
    return failure(e);
  }
}
