import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { env } from "@/lib/env"
import * as schema from "./schema"

const globalForDb = globalThis as unknown as { agentPool?: pg.Pool }
export const pool = (globalForDb.agentPool ??= new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
}))
pool.on("error", (error) => {
  // pg-pool adds the client to this error. Its connection details must stay private.
  const code =
    "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : "unknown"
  console.error("PostgreSQL pool connection failed", { code })
})
export const db = drizzle(pool, { schema, casing: "snake_case" })
