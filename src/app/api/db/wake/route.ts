import { PrismaClient } from "@/prisma/client";

const prisma = new PrismaClient();

export async function GET() {
    try {
        await prisma.$connect();
        return new Response("OK", { status: 200 });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify(error), { status: 500 });
    }
}

// 200 OK: Successfully resumed the database.
// 202 Accepted: Resuming the database is in progress.
// Other Status Codes : Error occurred.