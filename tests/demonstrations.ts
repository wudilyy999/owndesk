import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
process.loadEnvFile(".env")
const database = `agent_demonstration_${randomUUID().replaceAll("-", "")}`,
  directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!),
  admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
let passed = false
const checks: string[] = []
try {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  await once(child, "exit")
  assert.equal(child.exitCode, 0)
  const { pool } = await import("@/db")
  try {
    const {
      startDemonstration,
      recordDemonstration,
      finishDemonstration,
      saveDemonstrationManual,
    } = await import("@/lib/demonstrations")
    const { manualSnapshot } = await import("@/lib/manuals"),
      { loadManual } = await import("@/lib/manual-schema")
    const { demonstrationEventSchema, demonstrationDraft } =
      await import("@/lib/demonstration-schema")
    const agent = randomUUID(),
      owner = "demo-owner"
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,created_at,updated_at) VALUES($1,'Demonstration','Assistant','fixture',now(),now())",
      [agent]
    )
    await pool.query(
      "INSERT INTO workstation_control(agent_id,container_name,connection_secret,mode,epoch,updated_at) VALUES($1,$2,'fixture','human',1,now())",
      [agent, `fixture-${agent}`]
    )
    const demo = await startDemonstration(owner, agent, "Create a report")
    await assert.rejects(startDemonstration(owner, agent, "Duplicate"), { status: 409 })
    const raw = {
      seq: 1,
      event: { kind: "protected_input", text: "password-never-recorded" },
    }
    const recorded = await recordDemonstration(owner, demo.id, raw)
    assert(!JSON.stringify(recorded).includes("password-never-recorded"))
    assert.deepEqual(await recordDemonstration(owner, demo.id, raw), recorded)
    await assert.rejects(
      recordDemonstration("other", demo.id, {
        seq: 2,
        event: { kind: "protected_input" },
      }),
      { status: 404 }
    )
    await assert.rejects(
      recordDemonstration(owner, demo.id, { seq: 3, event: { kind: "protected_input" } }),
      { status: 409 }
    )
    await recordDemonstration(owner, demo.id, {
      seq: 2,
      event: { kind: "checkpoint", note: "Create report.txt with the requested totals" },
    })
    await pool.query("UPDATE workstation_control SET epoch=2 WHERE agent_id=$1", [agent])
    await assert.rejects(
      recordDemonstration(owner, demo.id, { seq: 3, event: { kind: "protected_input" } }),
      { status: 409 }
    )
    const draft = await finishDemonstration(owner, demo.id)
    assert.match(draft.body, /report.txt/)
    assert.doesNotMatch(draft.body, /password-never-recorded/)
    assert.deepEqual(await finishDemonstration(owner, demo.id), draft)
    const manual = await saveDemonstrationManual(owner, demo.id, {
      ...draft,
      body: draft.body + "\n核对总计为 42。",
    })
    assert.equal(manual.sourceKind, "demonstration")
    assert(loadManual(await manualSnapshot(owner), demo.id).ok)
    assert.equal((await manualSnapshot("other")).length, 0)
    const projected = demonstrationDraft("Example", [
      { seq: 1, application: "Thunar", kind: "pointer", button: 0, x: 0.4, y: 0.6 },
    ])
    assert(!projected.body.includes("0.4"))
    assert.match(projected.body, /Thunar/)
    assert.equal(
      demonstrationEventSchema.safeParse({
        kind: "key",
        key: "p",
        ctrl: false,
        alt: false,
        shift: false,
      }).success,
      false
    )
    checks.push(
      "Recording sequence, owner/control epoch, input redaction, finish retry, edited manual save and enabled catalog reuse verified"
    )
    const capped = await startDemonstration(owner, agent, "Capped demonstration")
    for (let seq = 1; seq <= 150; seq++)
      await recordDemonstration(owner, capped.id, {
        seq,
        event: { kind: "checkpoint", note: `Step ${seq}` },
      })
    await assert.rejects(
      recordDemonstration(owner, capped.id, {
        seq: 151,
        event: { kind: "checkpoint", note: "Must not append" },
      }),
      { name: "ZodError" }
    )
    const prefix = await finishDemonstration(owner, capped.id)
    assert.match(prefix.body, /Step 150/)
    assert.doesNotMatch(prefix.body, /Must not append/)
    await saveDemonstrationManual(owner, capped.id, prefix)
    checks.push(
      "150 saved events survive rejection of event 151; prefix still finishes and saves as a manual"
    )
    passed = true
  } finally {
    await pool.end()
  }
} finally {
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed, checks, database }, null, 2)
  )
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
