import { authorize, ContentError, failure } from "@/lib/content-admin/auth";
import { prepare, withDatabase } from "@/lib/content-admin/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    authorize(request);
    return await withDatabase(async (db) => {
      const rows = await db.query(
        "SELECT id,payload->>'fileName' AS name,payload->>'status' AS status,created_at AS \"createdAt\" FROM content_import_jobs ORDER BY created_at DESC LIMIT 20",
      );
      return Response.json(
        { jobs: rows.rows },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    authorize(request);
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
