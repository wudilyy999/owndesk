import assert from "node:assert/strict"
import test from "node:test"
import {
  addedLines,
  checkChanges,
  isProtectedPath,
  scanAddedLines,
  type ChangedFile,
} from "@/lib/evolution/policy"
import { labDockerfile, pageText } from "@/lib/evolution/evaluator"
import { reformerBrief } from "@/lib/evolution/runner"
import type { Improvement } from "@/lib/evolution/store"

const file = (path: string, status: ChangedFile["status"] = "M", lines = 5): ChangedFile => ({
  path,
  status,
  added: lines,
  removed: 0,
})
const rules = (files: ChangedFile[]) => checkChanges(files).map((item) => item.rule)

test("a change to the UI, behavior code and a new test passes the policy gate", () => {
  assert.deepEqual(
    checkChanges([
      file("app/companion/page.tsx"),
      file("components/memory.tsx"),
      file("lib/companion/push.ts"),
      file("worker/routines.ts"),
      file("tests/diary-search.test.ts", "A"),
    ]),
    []
  )
})

test("protected paths, dependencies, migrations and out-of-scope files are rejected", () => {
  assert.deepEqual(rules([file("lib/spend.ts")]), ["protected"])
  assert.deepEqual(rules([file("lib/evolution/policy.ts")]), ["protected"])
  assert.deepEqual(rules([file("worker/budgets.ts")]), ["protected"])
  assert.deepEqual(rules([file("lib/workstation.ts")]), ["protected"])
  assert.deepEqual(rules([file("workstation/controller/server.mjs")]), ["protected"])
  assert.deepEqual(rules([file("package.json")]), ["dependencies"])
  assert.deepEqual(rules([file("package-lock.json")]), ["dependencies"])
  assert.deepEqual(rules([file("db/migrations/0034_x.sql", "A")]), ["migration"])
  assert.deepEqual(rules([file("db/schema.ts")]), ["protected"])
  assert.deepEqual(rules([file("Dockerfile")]), ["protected"])
  assert.deepEqual(rules([file("README.md")]), ["scope"])
  assert.ok(isProtectedPath("lib/vault-schema.ts"))
  assert.ok(!isProtectedPath("lib/companion/chat.ts"))
})

test("existing tests are frozen: modifying, deleting or renaming one is rejected", () => {
  assert.deepEqual(rules([file("tests/objectives.test.ts")]), ["frozen-test"])
  assert.deepEqual(rules([file("tests/objectives.test.ts", "D")]), ["frozen-test"])
  assert.deepEqual(
    rules([{ ...file("tests/renamed.test.ts", "R"), from: "tests/objectives.test.ts" }]),
    ["frozen-test"]
  )
})

test("an empty change, path tricks, binaries and oversized diffs are rejected", () => {
  assert.deepEqual(rules([]), ["empty"])
  assert.ok(rules([file("app/../lib/spend.ts")]).includes("path"))
  assert.ok(rules([{ ...file("app/logo.png", "A"), binary: true }]).includes("binary"))
  assert.deepEqual(rules([file("app/page.tsx", "M", 1501)]), ["size"])
  assert.deepEqual(rules([file("app/page.tsx", "M", 1500)]), [])
})

test("the secret scan finds key shapes and this installation's own secrets in added lines", () => {
  const patch = [
    "diff --git a/lib/x.ts b/lib/x.ts",
    "--- a/lib/x.ts",
    "+++ b/lib/x.ts",
    "@@ -1,0 +10,3 @@",
    '+const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234"',
    "+const fine = 1",
    "+const own = 'installation-secret-value-xyz'",
  ].join("\n")
  const added = addedLines(patch)
  assert.deepEqual(
    added.map((line) => [line.path, line.line]),
    [
      ["lib/x.ts", 10],
      ["lib/x.ts", 11],
      ["lib/x.ts", 12],
    ]
  )
  const findings = scanAddedLines(added, ["installation-secret-value-xyz"])
  assert.deepEqual(
    findings.map((item) => [item.rule, item.line]),
    [
      ["openai-key", 10],
      ["installation-secret", 12],
    ]
  )
  assert.deepEqual(scanAddedLines(addedLines("+++ b/a.ts\n@@ -0,0 +1 @@\n+ok")), [])
})

test("the candidate build cuts the application build step off the network", () => {
  const trusted = "RUN npm ci\nCOPY . .\nRUN DATABASE_URL=postgresql://build \\\n npm run build\n"
  assert.equal(
    labDockerfile(trusted),
    "RUN npm ci\nCOPY . .\nRUN --network=none DATABASE_URL=postgresql://build \\\n npm run build\n"
  )
})

test("the reviewer reads visible text, form controls and links of a page", () => {
  const text = pageText(
    '<html><script>var s=1</script><body><h1>日记</h1><input type="date" aria-label="按日期搜索"><a href="/companion">聊天</a>&amp;</body></html>'
  )
  assert.equal(text, "日记 [input type=date aria-label=按日期搜索] [link /companion] 聊天 &")
})

test("the reformer brief carries the request, checklist and the previous failures", () => {
  const improvement = {
    request: "日记页加按日期搜索",
    checklist: ["日记页顶部有日期选择"],
  } as Improvement
  const brief = reformerBrief(
    improvement,
    { roundNo: 2, feedback: "The owner wants a clear button" } as never,
    {
      roundNo: 1,
      evaluation: {
        passed: false,
        stages: [{ name: "checks", status: "fail", detail: "typecheck 没通过", durationMs: 1 }],
        acceptance: [{ item: "日记页顶部有日期选择", status: "fail", note: "没看到" }],
      },
    } as never
  )
  assert.match(brief, /日记页加按日期搜索/)
  assert.match(brief, /1\. 日记页顶部有日期选择/)
  assert.match(brief, /typecheck 没通过/)
  assert.match(brief, /没看到/)
  assert.match(brief, /clear button/)
})
