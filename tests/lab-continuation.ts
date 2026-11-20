// Separate processes, a bare Git repository and replaceable real lab containers; synthetic data only.
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { ModelMessage } from "ai"
const exec = promisify(execFile)
process.loadEnvFile(".env")
const childMode = process.argv[2]
await mkdir(path.resolve("data/experiments"), { recursive: true })
const root =
  process.env.OWNDESK_RESTART_FIXTURE ??
  (await mkdtemp(path.resolve("data/experiments/lab-restart-")))
process.env.EVOLUTION_DIR = path.join(root, "evolution")
await mkdir(process.env.EVOLUTION_DIR, { recursive: true })
const { openLabJournal, UnknownLabTurn } = await import("@/lib/evolution/journal")
const { captureLabCommit, loadCommit, startLab, stopLab, labExec } =
  await import("@/lib/evolution/lab")
const { repoDir } = await import("@/lib/evolution/repo")
const image = process.env.OWNDESK_RESTART_LAB_IMAGE
assert(image, "Specify the installed lab image")
const task = path.basename(root),
  scope = "fixture-parent",
  secret = "fixture-credential-to-mask"
const journal = () =>
  openLabJournal<{ commit: string }>(task, "reformer", scope, [secret])
if (childMode) {
  const j = await journal()
  const lab = await startLab(image, task)
  await j.begin()
  const base = (await readFile(path.join(root, "parent"), "utf8")).trim()
  await loadCommit(lab, j.last?.state.commit ?? base)
  const result = await labExec(
    lab,
    "printf 'one mutation\n' >> /lab/history.txt; cat /lab/history.txt"
  )
  assert.equal(result.code, 0)
  if (childMode === "--unknown") process.exit(43)
  const commit = await captureLabCommit(lab, base, task)
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "a",
          toolName: "edit_file",
          input: { path: "history.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "edit_file",
          output: { type: "text", value: `saved: ${secret}` },
        },
      ],
    },
  ]
  await j.seal({
    messages,
    state: { commit },
    checkpoint: { through: 1, summary: "first complete turn" },
  })
  process.exit(43)
}
const tmp = path.join(root, "seed")
await mkdir(tmp)
await exec("git", ["init", tmp])
await writeFile(path.join(tmp, "history.txt"), "initial\n")
await exec("git", ["-C", tmp, "add", "."])
await exec("git", [
  "-C",
  tmp,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@localhost",
  "commit",
  "-m",
  "seed",
])
await exec("git", ["clone", "--bare", tmp, repoDir()])
const base = (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim()
await writeFile(path.join(root, "parent"), base)
async function run(mode: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/lab-continuation.ts", mode],
    { env: { ...process.env, OWNDESK_RESTART_FIXTURE: root }, stdio: "inherit" }
  )
  const [code] = await once(child, "exit")
  assert.equal(code, 43)
}
let lab = await startLab(image, task)
try {
  await run("--writer")
  const saved = await journal()
  assert.equal(saved.turn, 2)
  assert.equal(saved.last?.checkpoint?.summary, "first complete turn")
  assert(!JSON.stringify(saved).includes(secret))
  assert.equal(saved.messages.length, 2)
  lab = await startLab(image, task)
  await loadCommit(lab, saved.last!.state.commit)
  assert.equal(
    (await labExec(lab, "cat /lab/history.txt")).output.trim(),
    "initial\none mutation"
  )
  const review = await openLabJournal(task, "reviewer", scope)
  assert.equal(review.messages.length, 0)
  await run("--unknown")
  await assert.rejects(journal, UnknownLabTurn)
  assert.equal(
    (await labExec(lab, "cat /lab/history.txt")).output.trim(),
    "initial\none mutation\none mutation"
  )
  console.log(
    "passed: separate process and replacement lab recover original bytes and sanitized paired receipts; unconfirmed write is never replayed"
  )
} finally {
  await stopLab(lab)
}
