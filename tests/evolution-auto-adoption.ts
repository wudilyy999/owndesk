// Run on an empty, migrated auto_adopt_probe database. Only the external switch is stubbed.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mock } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/auto_adopt_probe")
const dir = await mkdtemp(path.join(os.tmpdir(), "auto-adopt-"))
process.env.EVOLUTION_DIR = dir
delete process.env.PA_DEPLOY_DIR
const { db, pool } = await import("@/db")
const { companionMessages } = await import("@/db/schema")
const { updateCompanion } = await import("@/lib/companion/store")
const { setEvolutionEnabled, readImprovement, updateImprovement } =
  await import("@/lib/evolution/store")
const switches: string[][] = []
const versions = await import("@/lib/versions")
mock.module(import.meta.resolve("../lib/versions.ts"), {
  namedExports: {
    ...versions,
    requestSwitch: async (...args: string[]) => {
      switches.push(args)
      return { started: true, deploymentId: "test-switch" }
    },
  },
})
const { confirmImprovementProposal, dispatchAutoAdoption } =
  await import("@/lib/evolution/improvements")
try {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM owners")).rows[0].n, 0)
  const repo = path.join(dir, "versions.git")
  execFileSync("git", ["init", "--bare", "-q", repo])
  const commit = execFileSync(
    "git",
    [
      "--git-dir",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "test baseline",
    ],
    { encoding: "utf8" }
  ).trim()
  const owner = "probe",
    agent = randomUUID(),
    task = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'UTC',now())",
    [owner]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'test','Companion','test','custom/test',now(),now())",
    [agent]
  )
  await updateCompanion(owner, agent, { typingPace: "off" })
  await pool.query(
    "INSERT INTO agent_versions(id,label,source_revision,git_commit,web_image_id,worker_image_id,images,status,created_at) VALUES('base','base',$1,$1,'web','worker','{}','active',now())",
    [commit]
  )
  await setEvolutionEnabled(true)
  async function ready(auto?: boolean, passed = true) {
    const [card] = await db
      .insert(companionMessages)
      .values({
        agentId: agent,
        role: "assistant",
        kind: "improvement_proposal",
        channel: "web",
        content: "proposal",
        metadata: {
          status: "pending",
          proposal: {
            title: "test",
            request: "add filter",
            checklist: ["filter works"],
            budget: {},
            autoAdopt: true,
          },
        },
      })
      .returning()
    await assert.rejects(confirmImprovementProposal("other", card.id, undefined, true), {
      status: 404,
    })
    const { id } = await confirmImprovementProposal(owner, card.id, undefined, auto)
    await confirmImprovementProposal(owner, card.id, undefined, true)
    assert.equal((await readImprovement(id))?.autoAdopt, auto ? "on_pass" : undefined)
    await pool.query("UPDATE objectives SET status='achieved' WHERE id=$1", [id])
    await updateImprovement(id, (i) => {
      i.status = passed ? "ready" : "working"
      i.candidates = [
        {
          phase: "done",
          taskId: task,
          parent: commit,
          branch: "cand/test",
          roundNo: 1,
          commit,
          versionId: id,
          evaluation: {
            passed,
            stages: [],
            acceptance: [],
            startedAt: new Date().toISOString(),
            suiteRevision: commit,
          },
        },
      ]
    })
    return id
  }
  const manual = await ready(),
    failed = await ready(true, false),
    automatic = await ready(true)
  await setEvolutionEnabled(false)
  await dispatchAutoAdoption()
  assert.equal(switches.length, 0)
  await setEvolutionEnabled(true)
  await pool.query(
    "INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,created_at,updated_at) VALUES($1,$2,$3,'improvement',$1,'{}','test','running','{}','{}','{}',now(),now())",
    [task, owner, agent]
  )
  await dispatchAutoAdoption()
  assert.equal((await readImprovement(automatic))?.autoAdopt, "on_pass")
  await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [task])
  await Promise.all([dispatchAutoAdoption(), dispatchAutoAdoption()])
  await dispatchAutoAdoption()
  assert.deepEqual(switches, [[automatic, "promote", "base"]])
  assert.equal((await readImprovement(automatic))?.adoption?.deploymentId, "test-switch")
  assert.equal((await readImprovement(manual))?.status, "ready")
  assert.equal((await readImprovement(failed))?.status, "working")
  const stale = await ready(true)
  await pool.query("UPDATE agent_versions SET git_commit=NULL WHERE id='base'")
  await dispatchAutoAdoption()
  await dispatchAutoAdoption()
  assert.equal((await readImprovement(stale))?.autoAdopt, "claimed")
  assert.equal(switches.length, 1)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM companion_messages WHERE kind='objective_update' AND metadata->>'objectiveId'=$1",
        [stale]
      )
    ).rows[0].n,
    1
  )
  console.log(
    "PASS: owner-only one-shot authorization, manual default, failed evaluation, disabled or busy instance, concurrent dispatch, stale source and single chat notice"
  )
} finally {
  await pool.end()
  await rm(dir, { recursive: true, force: true })
}
