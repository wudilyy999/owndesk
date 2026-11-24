import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Pool } from "pg"
import { z } from "zod"

// A candidate describes additions as data. All DDL comes from this trusted module.
export const extensionPath = /^db\/extensions\/[a-z][a-z0-9_-]{0,62}\.json$/
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
const table = identifier.refine((v) => !v.startsWith("pg_") && !v.startsWith("owndesk_"))
const column = z.strictObject({
  name: identifier,
  type: z.enum([
    "text",
    "integer",
    "bigint",
    "boolean",
    "jsonb",
    "timestamptz",
    "uuid",
    "date",
    "numeric",
  ]),
})
const operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("addColumn"), table, column }),
  z.strictObject({
    op: z.literal("createTable"),
    table,
    columns: z.array(column).min(1),
    primaryKey: identifier.optional(),
  }),
])
const manifest = z.strictObject({ operations: z.array(operation).min(1) })
const quote = (id: string) => `"${id}"`
export function extensionStatements(text: string) {
  return manifest.parse(JSON.parse(text)).operations.map((change) => {
    const relation = `public.${quote(change.table)}`
    if (change.op === "addColumn")
      return `ALTER TABLE ${relation} ADD COLUMN ${quote(change.column.name)} ${change.column.type}`
    const names = new Set(change.columns.map((c) => c.name))
    if (
      names.size !== change.columns.length ||
      (change.primaryKey && !names.has(change.primaryKey))
    )
      throw new Error("New table has duplicate columns or an unknown primary key")
    const columns = change.columns.map(
      (c) =>
        `${quote(c.name)} ${c.type}${c.name === change.primaryKey ? " PRIMARY KEY" : ""}`
    )
    return `CREATE TABLE ${relation} (${columns.join(", ")})`
  })
}

export async function migrateExtensions(pool: Pool, directory = "db/extensions") {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!entries.length) return
  const files = entries
    .map((e) => {
      if (!e.isFile() || !extensionPath.test(`db/extensions/${e.name}`))
        throw new Error(`Invalid extension migration: ${e.name}`)
      return e.name
    })
    .sort()
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('owndesk.extension_migrations'))"
    )
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.owndesk_extension_migrations (name text PRIMARY KEY, digest text NOT NULL)"
    )
    for (const name of files) {
      const raw = await readFile(path.join(directory, name))
      const digest = createHash("sha256").update(raw).digest("hex")
      const prior = await db.query<{ digest: string }>(
        "SELECT digest FROM public.owndesk_extension_migrations WHERE name=$1",
        [name]
      )
      if (prior.rowCount) {
        if (prior.rows[0].digest !== digest)
          throw new Error(`Applied extension migration changed: ${name}`)
        continue
      }
      for (const sql of extensionStatements(raw.toString("utf8"))) await db.query(sql)
      await db.query(
        "INSERT INTO public.owndesk_extension_migrations(name,digest) VALUES ($1,$2)",
        [name, digest]
      )
    }
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
}
