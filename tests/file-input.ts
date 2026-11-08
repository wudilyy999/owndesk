import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import sharp from "sharp"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_files_${randomUUID().replaceAll("-", "")}`,
  directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!),
  admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  CUSTOM_BASE_URL: "http://127.0.0.1:1/v1",
  CUSTOM_API_KEY: "fixture",
  OWNDESK_DEFAULT_MODEL: "custom/fixture",
})
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
  const { pool } = await import("@/db"),
    { closeDurableClient } = await import("@/lib/durable")
  try {
    const { saveUpload, ownedUploads, readUpload, MAX_FILE_BYTES } =
      await import("@/lib/uploads")
    const { submitTask, getTask } = await import("@/lib/tasks")
    const { appendTaskSupplement } = await import("@/lib/task-supplements")
    const { companionChat } = await import("@/lib/companion/chat")
    const { confirmErrand } = await import("@/lib/companion/errands")
    const owner = "files-owner",
      agent = randomUUID(),
      other = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'UTC',now())",
      [owner]
    )
    for (const id of [agent, other])
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Files','Assistant','fixture','custom/fixture',now(),now())",
        [id]
      )
    const generated = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      ["tests/fixtures/input-files.py", directory],
      { encoding: "utf8", windowsHide: true }
    )
    assert.equal(generated.status, 0, generated.stderr)
    const files = []
    for (const name of [
      "values.csv",
      "instructions.docx",
      "totals.xlsx",
      "reference.pdf",
    ]) {
      const bytes = await readFile(path.join(directory, name)),
        file = await saveUpload(owner, agent, name, bytes)
      files.push(file)
      assert((await readUpload(owner, file.id)).bytes.equals(bytes))
    }
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
    const picture = await saveUpload(owner, agent, "picture.png", png)
    files.push(picture)
    assert.equal(
      (await sharp((await readUpload(owner, picture.id)).bytes).metadata()).format,
      "jpeg"
    )
    const task = await submitTask(owner, "web", {
      agentId: agent,
      goal: "Read every input",
      clientRequestId: randomUUID(),
      attachmentIds: files.map((f) => f.id),
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 10 },
    })
    assert.deepEqual((await getTask(owner, task.taskId)).attachments, files)
    checks.push(
      "Real PDF/DOCX/XLSX/CSV bytes retained; image validated and converted; task owns all five attachments"
    )
    const note = {
      text: "Use the spreadsheet too",
      clientRequestId: randomUUID(),
      attachmentIds: [files[2].id],
    }
    await appendTaskSupplement(owner, task.taskId, note)
    assert((await appendTaskSupplement(owner, task.taskId, note)).reused)
    await assert.rejects(
      appendTaskSupplement(owner, task.taskId, { ...note, attachmentIds: [files[0].id] }),
      { status: 409 }
    )
    await assert.rejects(ownedUploads(owner, other, [files[0].id]), { status: 404 })
    await assert.rejects(readUpload("other-owner", files[0].id), { status: 404 })
    await assert.rejects(saveUpload(owner, agent, "../escape.csv", Buffer.from("x")), {
      status: 400,
    })
    await assert.rejects(saveUpload(owner, agent, "stream:bad.csv", Buffer.from("x")), {
      status: 400,
    })
    await assert.rejects(
      saveUpload(owner, agent, "huge.csv", Buffer.alloc(MAX_FILE_BYTES + 1)),
      { status: 413 }
    )
    for (const name of [
      "fake.pdf",
      "fake.docx",
      "fake.xlsx",
      "fake.doc",
      "fake.xls",
      "program.exe",
    ])
      await assert.rejects(saveUpload(owner, agent, name, Buffer.from("plain text")), {
        status: 415,
      })
    checks.push(
      "Owned attachment isolation, supplement idempotency, filename/size/type validation enforced"
    )
    let calls = 0
    const chat = await companionChat(
      {
        ownerId: owner,
        agentId: agent,
        text: "Read this file",
        attachmentIds: [files[0].id],
      },
      {
        price: { kind: "local" },
        model: new MockLanguageModelV3({
          doStream: async (options) => {
            assert.match(JSON.stringify(options.prompt), /values.csv/)
            const parts =
              calls++ === 0
                ? [
                    {
                      type: "tool-call",
                      toolCallId: "proposal",
                      toolName: "propose_errand",
                      input: JSON.stringify({ goal: "Read uploaded values" }),
                    },
                  ]
                : [
                    { type: "text-start", id: "text" },
                    { type: "text-delta", id: "text", delta: "已准备好。" },
                    { type: "text-end", id: "text" },
                  ]
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] })
                  for (const part of parts) controller.enqueue(part as never)
                  controller.enqueue({
                    type: "finish",
                    finishReason: {
                      unified: parts[0].type === "tool-call" ? "tool-calls" : "stop",
                      raw: undefined,
                    },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  })
                  controller.close()
                },
              }),
            }
          },
        }),
      }
    )
    const proposal = chat.replies.find((message) => message.kind === "errand_proposal")!
    assert(proposal)
    const errand = await confirmErrand(owner, proposal.id)
    assert.deepEqual((await getTask(owner, errand.taskId)).attachments, [files[0]])
    checks.push(
      "Companion chat preserves attachment metadata, model sees file reference and confirmed errand receives same input"
    )
    passed = true
  } finally {
    await closeDurableClient()
    await pool.end()
  }
} finally {
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { passed, checks, database, recordedAt: new Date().toISOString() },
      null,
      2
    )
  )
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
