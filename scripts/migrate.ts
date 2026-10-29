import { DBOS } from "@dbos-inc/dbos-sdk"
import { getMigrations } from "better-auth/db/migration"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { db, pool } from "@/db"
import { auth } from "@/lib/auth"
import { env } from "@/lib/env"

try {
  await migrate(db, { migrationsFolder: "./db/migrations" })
  const authMigration = await getMigrations(auth.options)
  await authMigration.runMigrations()
  await DBOS.migrate(env.DATABASE_URL)
  console.log("Business, authentication and DBOS migrations applied")
} finally {
  await pool.end()
}
