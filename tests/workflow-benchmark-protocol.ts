import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

// Admission/transport pinning only. No worker, Docker desktop or model API.
process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_benchprotocol_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${core.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, { DATABASE_URL: url.toString(), INSTALL_ID: randomUUID() })
const { pool } = await import("@/db")
const { freezeBenchmark, submitBenchmarkCase, readBenchmarkTask } =
  await import("@/lib/workflow-benchmark-db")
const { setSettings } = await import("@/lib/config")
const { requestCancellation } = await import("@/lib/task-control")
const { closeDurableClient } = await import("@/lib/durable")
let passed = false
const checks: string[] = []
const taskIds: string[] = []
try {
  const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  const agentIds = { baseline: randomUUID(), checked: randomUUID(), repair: randomUUID() }
  for (const id of Object.values(agentIds))
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Protocol Fixture','Transport pinning','','custom/protocol-fixture',$2,now(),now())",
      [id, randomUUID()]
    )
  const endpoint = "http://127.0.0.1:17991/v1"
  await setSettings([
    { key: "provider.custom.apiKey", value: `local-protocol-${randomUUID()}` },
    { key: "provider.custom.baseUrl", value: endpoint },
  ])
  const cases = Array.from({ length: 10 }, (_, index) => ({
    id: `case-${index}`,
    parameters: {
      parentName: `Protocol-parent-${index}`,
      draftName: `Draft-${index}`,
      readyName: `Ready-${index}`,
    },
  }))
  const versionId = core.results[0].input.workflowExecution.versionId
  await assert.rejects(
    () =>
      freezeBenchmark(
        owner,
        {
          baseline: agentIds.baseline,
          checked: agentIds.baseline,
          repair: agentIds.repair,
        },
        versionId,
        cases
      ),
    /independent desktop/
  )
  const manifest = await freezeBenchmark(owner, agentIds, versionId, cases)
  assert.equal(manifest.providerEndpoint, endpoint)
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 }
  )
  await setSettings([
    { key: "provider.custom.baseUrl", value: "http://127.0.0.1:17992/v1" },
  ])
  for (const arm of ["baseline", "repair"] as const)
    await assert.rejects(
      () => submitBenchmarkCase(manifest, arm, "case-0"),
      /endpoint changed/
    )
  const { providerEndpoint, ...earlier } = manifest
  await assert.rejects(
    () => submitBenchmarkCase(earlier, "baseline", "case-0"),
    /earlier protocol/
  )
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS count FROM tasks WHERE source LIKE $1", [
        `benchmark:${manifest.id}:%`,
      ])
    ).rows[0].count,
    0
  )
  checks.push(
    "fresh protocol freezes exact provider endpoint; changed endpoint/legacy unpinned model arm/shared desktop reject before admission"
  )
  const checked = await submitBenchmarkCase(manifest, "checked", "case-0")
  taskIds.push(checked.taskId)
  assert((await submitBenchmarkCase(manifest, "checked", "case-0")).reused)
  const config = (
    await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [checked.taskId])
  ).rows[0].config_snapshot
  assert.equal(config.model, "workflow/deterministic")
  assert.equal(config.workstationChannel, "desktop")
  await requestCancellation(owner, checked.taskId)
  checks.push(
    "provider-free deterministic arm remains admissible after endpoint change; same source key reuses Task and queued cancellation creates no effects"
  )
  await setSettings([{ key: "provider.custom.baseUrl", value: endpoint }])
  const baseline = await submitBenchmarkCase(manifest, "baseline", "case-0")
  taskIds.push(baseline.taskId)
  const baselineConfig = (
    await pool.query(
      "SELECT config_snapshot,completion_contract FROM tasks WHERE id=$1",
      [baseline.taskId]
    )
  ).rows[0]
  assert.equal(baselineConfig.config_snapshot.model, "custom/protocol-fixture")
  assert.equal(baselineConfig.config_snapshot.workstationChannel, "desktop")
  assert.equal(
    baselineConfig.completion_contract.directoryTree.root,
    "/home/agent/Protocol-parent-0"
  )
  await requestCancellation(owner, baseline.taskId)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=ANY($1::text[])",
        [taskIds]
      )
    ).rows[0].count,
    0
  )
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=ANY($1::text[])",
        [taskIds]
      )
    ).rows[0].count,
    0
  )
  checks.push(
    "matching endpoint admits baseline with frozen model/channel/bound contract; both admitted Tasks cancelled in queue with zero model/action records"
  )
  passed = true
} finally {
  const results = []
  for (const id of taskIds) results.push(await readBenchmarkTask(pool, id, "control"))
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    checks,
    results,
    cloudRequests: 0,
    scope:
      "C4 fresh-protocol transport/admission checks; two queued-cancelled Tasks, no desktop/model execution or performance comparison",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-benchmark-protocol.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
