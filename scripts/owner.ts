import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { z } from "zod"
import { pool } from "@/db"

const input = z
  .object({
    OWNER_EMAIL: z.email(),
    OWNER_PASSWORD: z.string().min(12),
    OWNER_NAME: z.string().min(1).default("Owner"),
    OWNER_TIMEZONE: z.string().default("UTC"),
  })
  .parse(process.env)
new Intl.DateTimeFormat("en", { timeZone: input.OWNER_TIMEZONE })
const password = await hashPassword(input.OWNER_PASSWORD)
const client = await pool.connect()
try {
  await client.query("BEGIN")
  await client.query("SELECT pg_advisory_xact_lock(71261196)")
  const existing = await client.query("SELECT 1 FROM owners")
  if (existing.rowCount) throw new Error("Owner is already initialized")
  const userId = randomUUID()
  await client.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',
    [userId, input.OWNER_NAME, input.OWNER_EMAIL.toLowerCase()]
  )
  await client.query(
    'INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,\'credential\',$2,$3,now(),now())',
    [randomUUID(), userId, password]
  )
  await client.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,$2,now())",
    [userId, input.OWNER_TIMEZONE]
  )
  await client.query(
    "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'OwnDesk Assistant','Your private personal assistant','',NULL,$2,now(),now())",
    [randomUUID(), randomUUID()]
  )
  await client.query("COMMIT")
  console.log("Owner initialized. Public registration remains disabled.")
} catch (error) {
  await client.query("ROLLBACK")
  throw error
} finally {
  client.release()
  await pool.end()
}
