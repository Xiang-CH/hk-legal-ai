import { SqlManagementClient } from "@azure/arm-sql";
import { DefaultAzureCredential } from "@azure/identity";
import { PrismaClient } from "@/prisma/client";
import { NextResponse } from "next/server";

const subscriptionId = process.env.AZURE_SQL_DB_SUBSCRIPTION_ID;
const resourceGroupName = process.env.AZURE_RESOURCE_GROUP_NAME;
const serverName = process.env.AZURE_SQL_SERVER_NAME;
const databaseName = process.env.AZURE_SQL_DATABASE_NAME;

if (!subscriptionId || !resourceGroupName || !serverName || !databaseName) {
  console.error("Azure credentials are not properly configured. Provide: AZURE_SQL_DB_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP_NAME, AZURE_SQL_SERVER_NAME, AZURE_SQL_DATABASE_NAME");
  throw new Error("Missing Azure SQL Database configuration");
}

// Initialize Prisma Client
const prisma = new PrismaClient();
const credentials = new DefaultAzureCredential();
const client = new SqlManagementClient(credentials, subscriptionId);

// Function to check management status
const checkDatabaseManagementStatus = async (): Promise<string | undefined> => {
  
  try {
    const database = await client.databases.get(resourceGroupName, serverName, databaseName);

    // Try to wake up the database if it's paused
    if (database.status == "Paused") {
      prisma.$connect().catch((error) => {
        console.error("Prisma connection error:", error.message);
      });
      setTimeout(async () => {
         const database = await client.databases.get(resourceGroupName, serverName, databaseName);
         return database.status;
      }, 500);
    }

    return database.status;
  } catch (error: unknown) {
    console.error("Error checking management status:", (error as Error).message);
    return undefined;
  }
};

// Function to test database connection with Prisma
const testDatabaseConnection = async (): Promise<boolean> => {
  try {
    // Run a simple raw query to test connectivity
    await prisma.$queryRaw`SELECT 1 AS test`;
    return true;
  } catch {
    return false;
  }
};

export async function GET() {
  try {
    // Check management status
    const currentStatus = await checkDatabaseManagementStatus();
    const isOnline = currentStatus === "Online";

    let isConnected = false;

    // Test connection if management status is Online or undefined
    if (isOnline || !currentStatus) {
      isConnected = await testDatabaseConnection();
    } else {
      console.log(`Database is not online. Management status: ${currentStatus}`);
    }

    return NextResponse.json({
      status: currentStatus,
      isConnected,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    console.error("Critical error in status check:", (error as Error).message);
    return NextResponse.json(
      { 
        error: "Failed to check database status",
        message: (error as Error).message
      },
      { status: 500 }
    );
  }
}
