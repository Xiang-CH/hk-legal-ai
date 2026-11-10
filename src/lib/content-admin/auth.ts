import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
export class ContentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function authorize(request: Request) {
  const expected = process.env.CLIC_CONTENT_ADMIN_TOKEN;
  if (!expected || expected.length < 24)
    throw new ContentError("Content administration is not configured.", 503);
  const actual =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new ContentError("Invalid admin access key.", 401);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (origin && new URL(origin).host !== host)
    throw new ContentError("Cross-origin requests are not allowed.", 403);
}
export function failure(error: unknown) {
  const status =
    error instanceof ContentError
      ? error.status
      : error instanceof ZodError
        ? 400
        : 500;
  const message =
    error instanceof ContentError
      ? error.message
      : error instanceof ZodError
        ? "Invalid import data. Check the workbook and selection."
        : "Import step failed. Retry to resume; no partial content changes were committed.";
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
