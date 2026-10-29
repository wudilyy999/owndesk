import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { env } from "@/lib/env"
import * as schema from "./schema"

const globalForDb = globalThis as unknown as { agentPool?: pg.Pool }
export const pool = (globalForDb.agentPool ??= new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
}))
pool.on("error", (error) => console.error("PostgreSQL pool connection failed", error))
export const db = drizzle(pool, { schema, casing: "snake_case" })
