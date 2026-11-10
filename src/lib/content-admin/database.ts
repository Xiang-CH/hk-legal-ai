import pg from "pg";

export async function withDatabase<T>(run: (db: pg.Client) => Promise<T>) {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
  });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}
