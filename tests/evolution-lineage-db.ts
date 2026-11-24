// Run against a fresh, migrated disposable database, never an existing installation.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/b3_lineage_probe")
const dir = await mkdtemp(path.join(os.tmpdir(), "b3-db-proof-"))
process.env.EVOLUTION_DIR = dir
const { pool } = await import("@/db")
const { setEvolutionEnabled, readImprovement, updateImprovement } =
  await import("@/lib/evolution/store")
const { createImprovement, abandonImprovement, forkImprovement } =
  await import("@/lib/evolution/improvements")
const { listVersions } = await import("@/lib/versions")
const { commitTree } = await import("@/lib/evolution/repo")
try {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM owners")).rows[0].n, 0)
  const repo = path.join(dir, "versions.git"),
    tree = path.join(dir, "source")
  await mkdir(tree)
  execFileSync("git", ["init", "--bare", "-q", repo])
  const base = execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "--git-dir",
      repo,
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "baseline",
    ],
    { encoding: "utf8" }
  ).trim()
  await writeFile(path.join(tree, "hello.txt"), "archived proof")
  const candidate = await commitTree(tree, base, "cand/old-1", "Earlier candidate")
  const owner = "b3-owner",
    agent = randomUUID(),
    task = randomUUID(),
    requestId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Shanghai',now())",
    [owner]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'test','Companion','test','custom/test',now(),now())",
    [agent]
  )
  await pool.query(
    "INSERT INTO agent_versions(id,label,source_revision,git_commit,web_image_id,worker_image_id,images,status,created_at) VALUES('base','upstream',$1,$1,'web','worker','{}','active',now())",
    [base]
  )
  await setEvolutionEnabled(true)
  const original = await createImprovement(owner, agent, {
    title: "原目标",
    request: "保留日记",
    checklist: ["可读"],
    budget: { maxRounds: 3 },
  })
  await pool.query(
    "INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,objective_id,created_at,updated_at) VALUES($1,$2,$3,'improvement',$1,'{}','test','completed','{}','{}','{}',$4,now(),now())",
    [task, owner, agent, original.id]
  )
  await pool.query(
    "INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,price_snapshot,cost_micros,started_at) VALUES($1,1,1,1,'custom/test','succeeded','{}',1234,now()),($1,1,2,1,'custom/test','unknown','{}',NULL,now())",
    [task]
  )
  await updateImprovement(original.id, (i) => {
    i.candidates.push({
      parent: base,
      commit: candidate,
      taskId: task,
      roundNo: 1,
      phase: "done",
      branch: "cand/old-1",
      evaluation: {
        suiteRevision: base,
        startedAt: new Date().toISOString(),
        passed: false,
        acceptance: [],
        stages: [
          { name: "checks", status: "fail", durationMs: 22, detail: "test failure" },
        ],
      },
    })
  })
  await abandonImprovement(owner, original.id)
  const view = await listVersions(owner)
  assert.equal(view.lineage.length, 1)
  const n = view.lineage[0]
  assert.equal(n.passed, false)
  assert.equal(n.parent, base)
  assert.equal(n.commit, candidate)
  assert.equal(n.abandoned, true)
  assert.equal(n.request, "保留日记")
  assert.equal(n.costMicros, "1234")
  assert.equal(n.unknownCosts, 1)
  assert.equal((await listVersions("other-owner")).lineage.length, 0)
  await assert.rejects(
    forkImprovement("other-owner", original.id, 1, "continue", requestId),
    { status: 404 }
  )
  const fork = await forkImprovement(owner, original.id, 1, "日记增加日期", requestId)
  assert.deepEqual(
    await forkImprovement(owner, original.id, 1, "日记增加日期", requestId),
    fork
  )
  const record = await readImprovement(fork.objectiveId)
  assert.equal(record?.fork?.commit, candidate)
  assert.equal(record?.request, "日记增加日期")
  assert.equal((await readImprovement(original.id))?.status, "abandoned")
  assert.equal(
    (await pool.query("SELECT budget FROM objectives WHERE id=$1", [fork.objectiveId]))
      .rows[0].budget.maxRounds,
    3
  )
  console.log(
    JSON.stringify({
      original: original.id,
      fork: fork.objectiveId,
      archivedCommit: candidate,
      parent: base,
      knownCostMicros: n.costMicros,
      unknownAttempts: n.unknownCosts,
      duplicateCreated: false,
      originalState: "abandoned",
      otherOwnerDenied: true,
    })
  )
} finally {
  await pool.end()
  await rm(dir, { recursive: true, force: true })
}
