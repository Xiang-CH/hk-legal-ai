import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ZodError } from "zod";
import type pg from "pg";
import { withDatabase } from "./database";

export const SESSION_COOKIE = "clic_content_admin_session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export class ContentError extends Error {
  constructor(
    message: string,
    public status = 400,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
function adminKey() {
  const key = process.env.CLIC_CONTENT_ADMIN_TOKEN;
  if (!key || key.length < 24)
    throw new ContentError("Content administration is not configured.", 503);
  return key;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function keyVersion(key: string) {
  return createHmac("sha256", key)
    .update("clic-content-admin-session-v1")
    .digest("hex");
}
/** Cookie-authenticated mutations require an explicit same-origin browser request. */
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let matches = false;
  try {
    matches = origin !== null && new URL(origin).host === host;
  } catch {
    /* Invalid origins fail closed. */
  }
  if (
    (origin !== null && !matches) ||
    (!matches && !["GET", "HEAD"].includes(request.method)) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new ContentError("Cross-origin requests are not allowed.", 403);
}
function sessionToken(request: Request) {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE + "="))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
/** API access accepts a revocable session only; raw keys cannot bypass login throttling. */
export async function authorize(request: Request) {
  const expected = adminKey();
  checkOrigin(request);
  const token = sessionToken(request);
  if (!token)
    throw new ContentError("Please sign in to the content dashboard.", 401);
  await withDatabase(async (db) => {
    const result = await db.query(
      "SELECT 1 FROM content_admin_sessions WHERE token_hash=$1 AND key_hash=$2 AND expires_at > now()",
      [hash(token), keyVersion(expected)],
    );
    if (!result.rowCount)
      throw new ContentError(
        "Your session expired. Please sign in again.",
        401,
      );
  });
}
/** Reserve an attempt atomically before checking credentials, including concurrent requests. */
export async function login(db: pg.Client, request: Request) {
  const expected = adminKey();
  checkOrigin(request);
  const limit =
    await db.query(`INSERT INTO content_admin_login_limits (scope,attempts,reset_at)
    VALUES ('shared-dashboard',1,now()+interval '1 hour')
    ON CONFLICT (scope) DO UPDATE SET
      attempts=CASE WHEN content_admin_login_limits.reset_at <= now() THEN 1 ELSE content_admin_login_limits.attempts+1 END,
      reset_at=CASE WHEN content_admin_login_limits.reset_at <= now() THEN now()+interval '1 hour' ELSE content_admin_login_limits.reset_at END
    WHERE content_admin_login_limits.reset_at <= now() OR content_admin_login_limits.attempts < 5
    RETURNING attempts`);
  if (!limit.rowCount) {
    const reset = await db.query(
      "SELECT greatest(1,ceil(extract(epoch FROM (reset_at-now()))))::int AS seconds FROM content_admin_login_limits WHERE scope='shared-dashboard'",
    );
    const seconds: unknown = reset.rows[0]?.seconds;
    throw new ContentError(
      "Too many login attempts. Please try again in an hour.",
      429,
      typeof seconds === "number" ? seconds : 3600,
    );
  }
  const actual =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (
    actual.length > 4096 ||
    !timingSafeEqual(
      Buffer.from(hash(actual), "hex"),
      Buffer.from(hash(expected), "hex"),
    )
  )
    throw new ContentError("Invalid admin access key.", 401);
  const token = randomBytes(32).toString("hex");
  await db.query(
    "DELETE FROM content_admin_sessions WHERE expires_at <= now()",
  );
  await db.query(
    "INSERT INTO content_admin_sessions (token_hash,key_hash,expires_at) VALUES ($1,$2,now()+interval '7 days')",
    [hash(token), keyVersion(expected)],
  );
  return token;
}
export async function logout(db: pg.Client, request: Request) {
  checkOrigin(request);
  const token = sessionToken(request);
  if (token)
    await db.query("DELETE FROM content_admin_sessions WHERE token_hash=$1", [
      hash(token),
    ]);
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
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(error instanceof ContentError && error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : {}),
      },
    },
  );
}
