import assert from "node:assert/strict"
import { test } from "node:test"
import { extensionStatements } from "@/lib/evolution/extension-migrations"
import { checkChanges } from "@/lib/evolution/policy"

test("extension manifests add tables or nullable columns, and applied definitions cannot be edited", () => {
  const column = { name: "note", type: "text" }
  const compile = (...operations: unknown[]) =>
    extensionStatements(JSON.stringify({ operations }))
  const add = { op: "addColumn", table: "tasks", column }
  const create = {
    op: "createTable",
    table: "diary_tags",
    columns: [column],
    primaryKey: "note",
  }
  assert.deepEqual(compile(create, add), [
    'CREATE TABLE public."diary_tags" ("note" text PRIMARY KEY)',
    'ALTER TABLE public."tasks" ADD COLUMN "note" text',
  ])
  for (const invalid of [
    { ...add, op: "dropColumn" },
    { ...add, column: { ...column, nullable: false } },
    { ...add, column: { ...column, type: "arbitrary SQL" } },
    { ...add, table: "owndesk_extension_migrations" },
    { ...create, primaryKey: "absent" },
    { ...create, columns: [column, column] },
  ])
    assert.throws(() => compile(invalid))
  const file = {
    path: "db/extensions/diary.json",
    added: 1,
    removed: 0,
    status: "A" as const,
  }
  assert.deepEqual(checkChanges([file]), [])
  for (const status of ["M", "D", "R"] as const)
    assert(checkChanges([{ ...file, status }]).length > 0)
  assert(checkChanges([{ ...file, path: "db/extensions/raw.sql" }]).length > 0)
})
