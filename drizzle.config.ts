import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DRIZZLE_DATABASE_URL;
if (!databaseUrl) throw new Error("DRIZZLE_DATABASE_URL is required");

export default defineConfig({
 dialect: "postgresql",
 dbCredentials: { url: databaseUrl },
});
