CREATE TABLE "content_admin_sessions" (
  "token_hash" CHAR(64) PRIMARY KEY,
  "key_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "content_admin_sessions_expires_at_idx" ON "content_admin_sessions" ("expires_at");

CREATE TABLE "content_admin_login_limits" (
  "scope" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL,
  "reset_at" TIMESTAMPTZ(6) NOT NULL
);
