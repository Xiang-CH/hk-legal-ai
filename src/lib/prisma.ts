import { PrismaClient } from "@/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
	prisma?: PrismaClient;
};

function createClient(): PrismaClient {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not defined");
	}
	const adapter = new PrismaPg({ connectionString });
	const client = new PrismaClient({ adapter });
	if (process.env.NODE_ENV !== "production") {
		globalForPrisma.prisma = client;
	}
	return client;
}

// Lazy singleton: importing this module (e.g. when Next.js collects page
// data during `next build`) must not throw while DATABASE_URL is unset, as
// build workers typically have no DB env. The client is created on first
// actual use, at which point DATABASE_URL is required (i.e. at runtime).
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
	get(_target, prop, receiver) {
		const client = (globalForPrisma.prisma ??= createClient());
		return Reflect.get(client, prop, receiver);
	},
});
