import pg from "pg";

/** Own one connection and reject on disconnect, including during non-database work. */
export async function withDatabase<T>(run: (db: pg.Client) => Promise<T>) {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
  });
  // Keep a listener for the connection's entire lifetime: idle errors must not
  // become uncaught EventEmitter exceptions while an import awaits embeddings.
  const disconnected = new Promise<never>((_, reject) => {
    db.on("error", reject);
  });
  try {
    return await Promise.race([
      (async () => {
        await db.connect();
        return await run(db);
      })(),
      disconnected,
    ]);
  } finally {
    // Closing also prevents the callback from writing after a disconnect wins
    // the race. Promise.race observes any later callback rejection.
    await db.end();
  }
}
