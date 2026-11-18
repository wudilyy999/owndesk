// Real database recovery, including the generic worker startup's prior unknown marking.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"

process.loadEnvFile(".env")
const database = `agent_evolution_recovery_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)
  const { pool } = await import("@/db")
  const { createObjective } = await import("@/lib/objectives")
  const { setCustomPrice } = await import("@/lib/spend")
  const { beginAttempt } = await import("@/lib/evolution/meter")
  const { writeImprovement, readImprovement } = await import("@/lib/evolution/store")
  const { resumeImprovementRounds, idleForTests } = await import("@/lib/evolution/runner")
  const owner = "recovery-owner",
    agentId = randomUUID(),
    spec = "custom/recovery-fixture"
  try {
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'UTC',now())",
      [owner]
    )
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Recovery','Synthetic recovery','r',$2,now(),now())",
      [agentId, spec]
    )
    await setCustomPrice(spec, { input: 1, output: 1 })
    const fixtures = []
    for (const initiallyUnknown of [false, true]) {
      const objective = await createObjective(
        owner,
        {
          agentId,
          title: "Interrupted improvement",
          objective: "Synthetic interrupted evaluation",
          budget: { roundMaxSteps: 40 },
        },
        `improvement:${randomUUID()}`
      )
      const taskId = randomUUID(),
        at = new Date().toISOString()
      await pool.query(
        `INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,objective_id,created_at,updated_at) VALUES($1,$2,$3,'improvement',$1,'{}','Recovery','running','{}',$4,'{}',$5,now(),now())`,
        [
          taskId,
          owner,
          agentId,
          JSON.stringify({
            model: spec,
            runtime: "agent",
            instructions: "",
            memories: [],
          }),
          objective.id,
        ]
      )
      await pool.query(
        "INSERT INTO objective_rounds(id,objective_id,round_no,input,task_id,started_at) VALUES($1,$2,1,'{}',$3,now())",
        [randomUUID(), objective.id, taskId]
      )
      await writeImprovement({
        objectiveId: objective.id,
        ownerId: owner,
        agentId,
        title: "Recovery",
        request: "Synthetic",
        checklist: ["No automatic replay"],
        baseVersionId: null,
        baseCommit: "synthetic-source",
        status: "working",
        candidates: [
          {
            roundNo: 1,
            taskId,
            branch: "cand/recovery",
            parent: "synthetic-source",
            commit: "synthetic-candidate",
            phase: "evaluating",
            files: [],
          },
        ],
        createdAt: at,
        updatedAt: at,
      })
      const receipt = await beginAttempt(taskId, 2, spec)
      if (initiallyUnknown)
        await pool.query(
          "UPDATE task_model_attempts SET status='unknown',error='Worker stopped during model request' WHERE id=$1",
          [receipt.id]
        )
      fixtures.push({
        objectiveId: objective.id,
        taskId,
        receiptId: receipt.id,
        initiallyUnknown,
      })
    }
    await resumeImprovementRounds()
    await idleForTests()
    for (const fixture of fixtures) {
      const {
        rows: [task],
      } = await pool.query("SELECT status,result FROM tasks WHERE id=$1", [
        fixture.taskId,
      ])
      assert.equal(task.status, "completed")
      assert.equal(task.result.objective.end, "cost")
      const { rows: attempts } = await pool.query(
        "SELECT id::text,status,cost_micros,reconciled_cost_micros,error FROM task_model_attempts WHERE task_id=$1",
        [fixture.taskId]
      )
      assert.equal(attempts.length, 1, "Recovery makes no additional model request")
      assert.equal(attempts[0].id, fixture.receiptId)
      assert.equal(attempts[0].status, "unknown")
      assert.equal(attempts[0].cost_micros, null)
      assert.equal(attempts[0].reconciled_cost_micros, null)
      if (fixture.initiallyUnknown)
        assert.equal(attempts[0].error, "Worker stopped during model request")
      const improvement = await readImprovement(fixture.objectiveId)
      assert.equal(improvement?.candidates[0].phase, "done")
      assert.equal(improvement?.candidates[0].evaluation, undefined)
    }
    passed = true
    console.log(
      "PASS: pending and startup-marked unknown receipts both stop automatic evaluation replay; original receipts and unknown costs remain unchanged"
    )
  } finally {
    await pool.end()
  }
} finally {
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  else console.error(`Recovery evidence database retained: ${database}`)
  await admin.end()
}
