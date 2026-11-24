// Run against a fresh, temporary PostgreSQL database; never use the install's tables.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { migrateExtensions } from "@/lib/evolution/extension-migrations"

const connection = new URL(process.env.TEST_POSTGRES_URL!)
assert(
  ["localhost", "127.0.0.1"].includes(connection.hostname),
  "Use a local test Postgres"
)
const admin = new pg.Client({ connectionString: connection.href })
const name = `b2_test_${randomUUID().replaceAll("-", "")}`
const dir = await mkdtemp(path.join(os.tmpdir(), "b2-migration-"))
await admin.connect()
try {
  await admin.query(`CREATE DATABASE ${name}`)
  connection.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: connection.href })
  try {
    await pool.query(
      "CREATE TABLE prior(id text PRIMARY KEY); INSERT INTO prior VALUES ('original')"
    )
    const add = {
      op: "addColumn",
      table: "prior",
      column: { name: "note", type: "text" },
    }
    const create = { op: "createTable", table: "round_notes", columns: [add.column] }
    const write = (file: string, ...operations: unknown[]) =>
      writeFile(path.join(dir, file), JSON.stringify({ operations }))
    await write("a.json", add, create)
    await Promise.all([migrateExtensions(pool, dir), migrateExtensions(pool, dir)])
    await pool.query("INSERT INTO prior(id) VALUES ('later')")
    assert.deepEqual((await pool.query("SELECT * FROM prior ORDER BY id")).rows, [
      { id: "later", note: null },
      { id: "original", note: null },
    ])
    await write("b.json", { ...create, table: "must_rollback" }, add)
    await assert.rejects(migrateExtensions(pool, dir), { code: "42701" })
    assert.equal(
      (await pool.query("SELECT to_regclass('public.must_rollback') AS t")).rows[0].t,
      null
    )
    await write("a.json", create)
    await assert.rejects(
      migrateExtensions(pool, dir),
      /Applied extension migration changed/
    )
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM public.owndesk_extension_migrations"
        )
      ).rows[0].n,
      1
    )
    console.log(
      "PASS concurrent additive migration, old reader/writer, rollback and checksum"
    )
  } finally {
    await pool.end()
  }
} finally {
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  } finally {
    await admin.end()
    await rm(dir, { recursive: true, force: true })
  }
}
