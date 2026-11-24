// Replays two consecutive real OwnDesk main revisions, with local-only fixture commits.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { replayPatches, type ReplayReceipt } from "../lib/evolution/rebase"
const old = "47f43bea021804e00ab307a0b9c8763177d1ccb1",
  official = "47b2d0e8d224bd998324405cd002676b930fb095"
const root = await mkdtemp(path.join(os.tmpdir(), "owndesk-historical-")),
  repo = path.join(root, "repo.git"),
  wd = path.join(root, "edit")
const git = (...a: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      ...a,
    ],
    { encoding: "utf8" }
  ).trimEnd()
try {
  const src = process.env.OWNDESK_HISTORY_REPO ?? process.cwd()
  assert.equal(git("-C", src, "rev-parse", `${official}^1`), old)
  git("init", "-q", "--bare", repo)
  const db = git(
    "-C",
    src,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects"
  )
  await writeFile(path.join(repo, "objects/info/alternates"), db + "\n")
  git("--git-dir", repo, "update-ref", "refs/heads/upstream", official)
  git("--git-dir", repo, "worktree", "add", "--quiet", "--detach", wd, old)
  const file = "worker/delegation.ts",
    schedule = "lib/schedule.ts"
  git("-C", wd, "checkout", official, "--", file)
  git(
    "-C",
    wd,
    "commit",
    "-qm",
    "Local cross-round file handoff already implemented upstream"
  )
  const equivalent = git("-C", wd, "rev-parse", "HEAD")
  await appendFile(
    path.join(wd, schedule),
    '\nexport function describeObjectiveSchedule(plan?: {timeZone:string}) { return plan ? plan.timeZone : "自主推进" }\n'
  )
  git("-C", wd, "commit", "-qam", "Personalized label for unscheduled objectives")
  const local = git("-C", wd, "rev-parse", "HEAD")
  const officialFile = execFileSync(
    "git",
    ["--git-dir", repo, "show", `${official}:${schedule}`],
    { encoding: "utf8" }
  )
  const wanted = officialFile.replace('"连续推进"', '"自主推进"')
  assert.notEqual(wanted, officialFile)
  for (let i = 0; i < 2; i++) {
    const receipts: ReplayReceipt[] = []
    let calls = 0
    const result = await replayPatches({
      repo,
      base: old,
      official,
      local,
      resolve: async (p, files) => {
        calls++
        assert.equal(i, 0)
        assert.equal(p, local)
        assert.deepEqual(
          files.map((f) => f.path),
          [schedule]
        )
        assert(files[0].text.includes("<<<<<<<"))
        return [{ path: schedule, text: wanted }]
      },
      save: async (r) => {
        receipts.push(r)
      },
    })
    assert.equal(calls, i === 0 ? 1 : 0)
    assert.deepEqual(
      receipts.map((r) => r.outcome),
      ["upstream", i === 0 ? "resolved" : "rerere"]
    )
    assert.equal(receipts[0].patch, equivalent)
    assert.equal(git("--git-dir", repo, "rev-parse", `${result}^`), official)
    assert.equal(
      git("--git-dir", repo, "show", `${result}:${schedule}`),
      wanted.trimEnd()
    )
    assert.equal(
      git("--git-dir", repo, "rev-parse", `${result}:${file}`),
      git("--git-dir", repo, "rev-parse", `${official}:${file}`)
    )
    const script = path.join(root, `schedule-${i}.mts`)
    await writeFile(
      script,
      git("--git-dir", repo, "show", `${result}:${schedule}`) +
        `\nimport assert from "node:assert/strict"; assert.equal(describeObjectiveSchedule(null),"自主推进");assert.equal(describeObjectiveSchedule({schedule:{kind:"daily",time:"08:30"},timeZone:"Asia/Shanghai",missedRunPolicy:"skip"}),"每天 08:30（Asia/Shanghai） · 漏跑跳过");`
    )
    execFileSync(process.execPath, [script])
    console.log(
      JSON.stringify({
        old,
        official,
        result,
        outcomes: receipts.map((r) => r.outcome),
        resolverCalls: calls,
      })
    )
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
