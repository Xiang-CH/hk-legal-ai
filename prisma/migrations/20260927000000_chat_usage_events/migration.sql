-- Anonymous chat usage log: one row per turn, chained within a session via
-- turn_index / previous_id. The app writes this only in production (see
-- src/lib/usage-log.ts). IP is stored as an HMAC-SHA256 hash, never raw.
CREATE TABLE "chat_usage_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_index" INTEGER NOT NULL,
    "previous_id" TEXT,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "domain" TEXT,
    "search_mode" TEXT NOT NULL,
    "model" TEXT,
    "step_count" INTEGER,
    "tool_call_count" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "latency_ms" INTEGER,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_usage_events_session_id_turn_index_key" ON "chat_usage_events"("session_id", "turn_index");
CREATE INDEX "chat_usage_events_session_id_created_at_idx" ON "chat_usage_events"("session_id", "created_at");
CREATE INDEX "chat_usage_events_ip_hash_created_at_idx" ON "chat_usage_events"("ip_hash", "created_at");
CREATE INDEX "chat_usage_events_created_at_idx" ON "chat_usage_events"("created_at");

ALTER TABLE "chat_usage_events" ADD CONSTRAINT "chat_usage_events_previous_id_fkey" FOREIGN KEY ("previous_id") REFERENCES "chat_usage_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
