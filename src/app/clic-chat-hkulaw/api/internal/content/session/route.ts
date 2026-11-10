import { NextResponse } from "next/server";
import {
  authorize,
  failure,
  login,
  logout,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "@/lib/content-admin/auth";
import { withDatabase } from "@/lib/content-admin/database";
import { APP_BASE_PATH } from "@/lib/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function response(token: string, maxAge: number) {
  const result = NextResponse.json(
    { authenticated: maxAge > 0 },
    { headers: { "Cache-Control": "no-store" } },
  );
  result.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: APP_BASE_PATH + "/api/internal/content",
    maxAge,
  });
  return result;
}
export async function GET(request: Request) {
  try {
    await authorize(request);
    return Response.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    return response(
      await withDatabase((db) => login(db, request)),
      SESSION_SECONDS,
    );
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    await withDatabase((db) => logout(db, request));
    return response("", 0);
  } catch (error) {
    return failure(error);
  }
}
