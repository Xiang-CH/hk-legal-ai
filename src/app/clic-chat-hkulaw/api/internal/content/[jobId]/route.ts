import { authorize, failure } from "@/lib/content-admin/auth";
import {
  advance,
  load,
  publicJob,
  withDatabase,
} from "@/lib/content-admin/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    authorize(request);
    const { jobId } = await context.params;
    return await withDatabase(async (db) =>
      Response.json(
        { id: jobId, ...publicJob(await load(db, jobId)) },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    authorize(request);
    const { jobId } = await context.params;
    return await withDatabase(async (db) =>
      Response.json(await advance(db, jobId), {
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (e) {
    return failure(e);
  }
}
