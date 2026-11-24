// Explicitly opt-in: guide the real isolated reformer and new upstream evaluator through a
// historical merge. The canonical main ref is replayed from a locally verified Git mirror.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile, appendFile } from "node:fs/promises"
import path from "node:path"
import { pool } from "@/db"
import { setSetting } from "@/lib/config"
import { setCustomPrice } from "@/lib/spend"
import { startOfficialMerge } from "@/lib/evolution/improvements"
import { discoverOfficial } from "@/lib/evolution/official"
import {
  readImprovement,
  setEvolutionEnabled,
  writeImprovement,
} from "@/lib/evolution/store"
import { advanceObjectives } from "@/lib/objectives"
import { idleForTests } from "@/lib/evolution/runner"
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/b3_merge_probe")
const out = process.env.B3_PROOF_DIR!,
  repo = path.join(process.env.EVOLUTION_DIR!, "versions.git"),
  wd = path.join(out, "edit"),
  remote = path.join(out, "official.git"),
  src = process.env.OWNDESK_HISTORY_REPO!,
  owner = "b3-proof-owner",
  agent = randomUUID(),
  old = "47f43bea021804e00ab307a0b9c8763177d1ccb1",
  revision = "47b2d0e8d224bd998324405cd002676b930fb095"
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      ...args,
    ],
    { encoding: "utf8" }
  ).trim()
const args = process.argv.slice(2)
assert.deepEqual(args, ["--live"])
const config = JSON.parse(
  await (async () => {
    let raw = ""
    for await (const b of process.stdin) raw += b
    return raw
  })()
)
assert(
  config.spec === "custom/gpt-6-luna" &&
    config.effort === "max" &&
    new URL(config.url).origin === "https://api.wudilyy666.top" &&
    config.price &&
    !config.budget
)
try {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM owners")).rows[0].n, 0)
  assert.equal(git("-C", src, "rev-parse", revision + "^1"), old)
  const objects = git(
    "-C",
    src,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects"
  )
  await mkdir(process.env.EVOLUTION_DIR!, { recursive: true })
  for (const dir of [repo, remote]) {
    git("init", "-q", "--bare", dir)
    await writeFile(path.join(dir, "objects/info/alternates"), objects + "\n")
  }
  git("--git-dir", remote, "update-ref", "refs/heads/main", revision)
  git(
    "--git-dir",
    repo,
    "config",
    `url.file://${remote}.insteadOf`,
    "https://github.com/wudilyy999/owndesk.git"
  )
  const base = git(
    "--git-dir",
    repo,
    "commit-tree",
    old + "^{tree}",
    "-m",
    "Imported official #34 source"
  )
  git("--git-dir", repo, "update-ref", "refs/heads/upstream", base)
  git("--git-dir", repo, "worktree", "add", "-q", "--detach", wd, base)
  const equivalentFile = "components/schedule-fields.tsx",
    file = "lib/schedule.ts"
  git("-C", wd, "checkout", revision, "--", equivalentFile)
  git("-C", wd, "commit", "-qm", "Scheduled objective form")
  const equivalent = git("-C", wd, "rev-parse", "HEAD")
  await appendFile(
    path.join(wd, file),
    '\nexport function describeObjectiveSchedule(plan?: {timeZone:string}) { return plan ? plan.timeZone : "自主推进" }\n'
  )
  git("-C", wd, "commit", "-qam", "Format the continuous objective with a personal label")
  const local = git("-C", wd, "rev-parse", "HEAD")
  git("--git-dir", repo, "update-ref", "refs/heads/cand/proof-local", local)
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Shanghai',now())",
    [owner]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'改进验收','Companion','test',$2,now(),now())",
    [agent, config.spec]
  )
  await setEvolutionEnabled(true)
  await setSetting("model.default", config.spec)
  await setSetting("provider.custom.apiKey", config.key)
  await setSetting("provider.custom.baseUrl", config.url)
  await setSetting("chat.reasoningEffort", config.effort)
  await setCustomPrice(config.spec, config.price)
  const ids = ["official0", "local1", "local2"]
  for (const [index, commit] of [base, equivalent, local].entries()) {
    await pool.query(
      "INSERT INTO agent_versions(id,parent_id,kind,label,source_revision,git_commit,web_image_id,worker_image_id,images,status,created_at) VALUES($1,$2,$3,$1,$4,$5,$6,$7,'{}',$8,now())",
      [
        ids[index],
        ids[index - 1] ?? null,
        index ? "local" : "upstream",
        index ? commit : old,
        commit,
        `fixture-web-${index}`,
        `fixture-worker-${index}`,
        index === 2 ? "active" : "retained",
      ]
    )
    if (index) {
      const request =
        index === 1
          ? "目标页允许选择按计划推进，显示每日的时间选择器。"
          : "未设置时间表的已创建目标在列表中显示「自主推进」；有时间表时保留官方的时间、时区与漏跑策略。"
      await writeImprovement({
        objectiveId: "source-" + index,
        agentId: agent,
        ownerId: owner,
        title: request,
        request,
        checklist: [
          index === 1
            ? "在目标页选择按计划推进，可以看到每天的时间输入。"
            : "创建一个未设置计划的合成目标后，目标条目的推进方式显示「自主推进」。",
        ],
        status: "adopted",
        baseVersionId: ids[index - 1],
        baseCommit: index === 1 ? base : equivalent,
        candidates: [
          {
            roundNo: 1,
            branch: `cand/${index}`,
            parent: index === 1 ? base : equivalent,
            commit,
            phase: "done",
            versionId: ids[index],
            taskId: randomUUID(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
  }
  const offer = await discoverOfficial(owner)
  assert.equal(offer.revision, revision)
  assert.equal(offer.requests.length, 2)
  assert.notEqual(offer.official, revision)
  assert.equal(
    git("--git-dir", repo, "rev-parse", offer.official + "^{tree}"),
    git("--git-dir", repo, "rev-parse", revision + "^{tree}")
  )
  const result = await startOfficialMerge(owner, revision, offer.fromId)
  await writeFile(
    path.join(out, "goal.json"),
    JSON.stringify({ objectiveId: result.objectiveId, repo, offer })
  )
  console.log("Historical merge objective", result.objectiveId, revision)
  await advanceObjectives()
  await idleForTests()
  const i = await readImprovement(result.objectiveId)
  assert(i)
  const c = i.candidates.at(-1)
  const attempts = (
    await pool.query(
      "select segment_no,status,count(*)::int n from task_model_attempts where task_id=$1 group by 1,2 order by 1,2",
      [c?.taskId]
    )
  ).rows
  const proof = {
    objectiveId: i.objectiveId,
    activeSeen: offer.fromId,
    official: revision,
    imported: offer.official,
    patches: i.replay,
    commit: c?.commit,
    task: c?.taskId,
    versionId: c?.versionId,
    state: i.status,
    stages: c?.evaluation?.stages.map((s) => ({
      name: s.name,
      status: s.status,
      counts: s.counts,
      detail: s.detail,
    })),
    acceptance: c?.evaluation?.acceptance,
    attempts,
  }
  await writeFile(path.join(out, "result.json"), JSON.stringify(proof, null, 2))
  console.log(
    JSON.stringify({
      state: i.status,
      task: c?.taskId,
      stages: proof.stages?.map((s) => [s.name, s.status]),
      attempts,
    })
  )
  assert.deepEqual(
    i.replay?.map((r) => r.outcome),
    ["upstream", "resolved"]
  )
  assert(attempts.some((a) => a.segment_no === 1 && a.status === "succeeded"))
  assert(c?.evaluation?.passed && c.versionId)
  assert.equal(c.evaluation.suiteRevision, offer.official)
} finally {
  await pool.end()
}
