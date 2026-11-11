// Database integration: source chat/images, atomic admission, supplements and follow-up history.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import sharp from "sharp"

if (existsSync(".env")) process.loadEnvFile(".env")
const database = `agent_continuity_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  APP_URL: "http://127.0.0.1:17297",
  INSTALL_ID: randomUUID(),
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  CUSTOM_BASE_URL: "http://127.0.0.1:1/v1",
  CUSTOM_API_KEY: "local-fixture-key",
  OWNDESK_DEFAULT_MODEL: "custom/fixture",
})
const checks: string[] = []
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)
  const { pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  try {
    const { updateCompanion } = await import("@/lib/companion/store")
    const { confirmErrand, cancelErrand, syncErrands } =
      await import("@/lib/companion/errands")
    const { saveImage, deleteImageFile } = await import("@/lib/companion/images")
    const { freezeCompanionTaskContext, loadCompanionTaskImage } =
      await import("@/lib/companion/task-context")
    const { appendTaskSupplement, taskSupplements, hasTaskSupplement } =
      await import("@/lib/task-supplements")
    const { getTask, submitTask } = await import("@/lib/tasks")
    const { getThread } = await import("@/lib/threads")
    const { toolsForTask } = await import("@/lib/agent/tools")
    const owner = "continuity-owner",
      agent = randomUUID(),
      other = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Shanghai',now())",
      [owner]
    )
    for (const id of [agent, other]) {
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Assistant','Personal assistant','fixture','custom/fixture',now(),now())",
        [id]
      )
      await updateCompanion(owner, id, { typingPace: "off" })
    }
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer()
    const image = await saveImage(agent, png)
    const source = randomUUID(),
      proposal = randomUUID(),
      hidden = randomUUID()
    await pool.query(
      `INSERT INTO companion_messages(id,agent_id,role,kind,content,metadata,created_at) VALUES
      ($1,$2,'user','chat','Use Chinese headings and add a total column',$3,now()-interval '3 minutes'),
      ($4,$2,'assistant','chat','The previous unwanted draft','{}',now()-interval '2 minutes'),
      ($5,$2,'assistant','errand_proposal','Prepare the report',$6,now()-interval '1 minute')`,
      [
        source,
        agent,
        JSON.stringify({ imageId: image.id }),
        hidden,
        proposal,
        JSON.stringify({
          goal: "Prepare the report",
          status: "pending",
          sourceMessageId: source,
        }),
      ]
    )
    await pool.query("UPDATE companion_messages SET superseded_at=now() WHERE id=$1", [
      hidden,
    ])
    await pool.query(
      "INSERT INTO companion_messages(id,agent_id,role,content,created_at) VALUES($1,$2,'user','Later unrelated chat',now())",
      [randomUUID(), agent]
    )
    const context = await freezeCompanionTaskContext(owner, agent, proposal)
    assert.deepEqual(
      context.messages.map((m) => m.id),
      [source]
    )
    assert.deepEqual(
      context.images.map((m) => m.id),
      [image.id]
    )
    const picture = await loadCompanionTaskImage(context, image.id)
    assert(picture.available && picture.image)
    assert.equal(
      (await sharp(Buffer.from(picture.image!, "base64")).metadata()).width,
      16
    )
    await assert.rejects(freezeCompanionTaskContext("outsider", agent, proposal), {
      status: 404,
    })
    await assert.rejects(freezeCompanionTaskContext(owner, other, proposal), {
      status: 404,
    })
    await assert.rejects(loadCompanionTaskImage(context, randomUUID()), { status: 404 })
    checks.push(
      "Owned source chat preserves picture bytes, excludes later and superseded messages, rejects cross-agent/owner access"
    )
    const confirmed = await Promise.all(
      Array.from({ length: 4 }, () => confirmErrand(owner, proposal))
    )
    const taskId = confirmed[0].taskId
    assert(confirmed.every((task) => task.taskId === taskId))
    const task = await getTask(owner, taskId)
    assert(task.canSupplement)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n, 1)
    const saved = (
      await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [taskId])
    ).rows[0].config_snapshot
    assert.deepEqual(saved.companionContext, context)
    const linked = (
      await pool.query("SELECT metadata FROM companion_messages WHERE id=$1", [proposal])
    ).rows[0].metadata
    assert.equal(linked.status, "confirmed")
    assert.equal(linked.taskId, taskId)
    assert(Object.hasOwn(toolsForTask(saved), "load_task_image"))
    assert(!Object.hasOwn(toolsForTask({ lifeSession: {} }), "load_task_image"))
    assert.equal((await confirmErrand(owner, proposal)).reused, true)
    await assert.rejects(cancelErrand(owner, proposal), { status: 409 })
    checks.push(
      "Concurrent confirmations and lost-response retry create one Task; proposal link and admission persist together"
    )
    const input = { text: "Also save the total as a CSV", clientRequestId: randomUUID() }
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => appendTaskSupplement(owner, taskId, input))
    )
    assert(receipts.every((receipt) => receipt.seq === receipts[0].seq))
    const seq = receipts[0].seq
    assert.equal((await taskSupplements(taskId)).length, 1)
    assert.equal(await hasTaskSupplement(taskId, 0), true)
    assert.equal(await hasTaskSupplement(taskId, seq), false)
    await assert.rejects(
      appendTaskSupplement(owner, taskId, { ...input, text: "Changed text" }),
      { status: 409 }
    )
    await assert.rejects(appendTaskSupplement("outsider", taskId, input), { status: 404 })
    await assert.rejects(appendTaskSupplement(owner, taskId, { ...input, text: " " }))
    assert.equal(
      (await getThread(owner, task.threadId!)).turns[0].supplements[0].text,
      input.text
    )
    checks.push(
      "Supplements are ordered, durable, owned, idempotent and visible in thread history"
    )
    if (process.argv.includes("--ui")) {
      const { chromium } = await import("playwright")
      const { hashPassword } = await import("better-auth/crypto")
      const { createTaskRequest } = await import("@/worker/requests")
      const { setTimeout: delay } = await import("node:timers/promises")
      const password = randomUUID()
      await pool.query(
        `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Owner','continuity@fixture.test',true,now(),now())`,
        [owner]
      )
      await pool.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,'credential',$2,$3,now(),now())`,
        [randomUUID(), owner, await hashPassword(password)]
      )
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17297",
        ],
        { env: process.env, windowsHide: true, detached: process.platform !== "win32" }
      )
      let output = ""
      web.stdout!.on("data", (data) => {
        output += data
      })
      web.stderr!.on("data", (data) => {
        output += data
      })
      const browser = await chromium.launch({ headless: true })
      try {
        const deadline = Date.now() + 120000
        while (true) {
          if (web.exitCode !== null) throw new Error(output)
          try {
            if ((await fetch(`${process.env.APP_URL}/login`)).ok) break
          } catch {}
          assert(Date.now() < deadline, output)
          await delay(250)
        }
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
        page.setDefaultTimeout(45000)
        const login = await page.request.post(
          `${process.env.APP_URL}/api/auth/sign-in/email`,
          {
            data: { email: "continuity@fixture.test", password },
            headers: { origin: process.env.APP_URL! },
          }
        )
        assert(login.ok(), await login.text())
        await page.goto(`${process.env.APP_URL}/companion`)
        const card = page.getByRole("region", { name: "聊天任务" })
        await card.getByText("排队中", { exact: true }).waitFor()
        const uploaded = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes("/api/uploads?")
        )
        await card.locator('input[type="file"]').setInputFiles({
          name: "chat-input.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("name,total\nchat,42\n"),
        })
        const uploadResponse = await uploaded
        assert(uploadResponse.ok(), await uploadResponse.text())
        const upload = await uploadResponse.json()
        assert.equal(
          (await fetch(`${process.env.APP_URL}/api/uploads/${upload.id}`)).status,
          401
        )
        await card.getByRole("link", { name: "chat-input.csv", exact: true }).waitFor()

        await card
          .getByLabel("补充当前任务", { exact: true })
          .fill("Keep the original headings from chat")
        await card.getByRole("button", { name: "补充当前任务", exact: true }).click()
        await card
          .getByText("你的补充：Keep the original headings from chat", { exact: false })
          .waitFor()
        assert(
          (await taskSupplements(taskId)).some((note) =>
            note.attachments?.some((file) => file.id === upload.id)
          )
        )
        const requestId = `${taskId}-ui-question`
        await createTaskRequest(taskId, 1, requestId, "approval", {
          purpose: "question",
          question: "Choose the report language",
        })
        await card.getByLabel("请求答复", { exact: true }).fill("Use Chinese")
        await card.getByRole("button", { name: "确认并继续", exact: true }).click()
        await card.getByRole("button", { name: "正在处理决定…", exact: true }).waitFor()
        const response = (
          await pool.query("SELECT response,status FROM task_requests WHERE id=$1", [
            requestId,
          ])
        ).rows[0]
        assert.equal(response.response.answer, "Use Chinese")
        assert.equal(response.status, "decided")
        await mkdir(process.env.ARTIFACT_DIR!, { recursive: true })
        const report = "name,total\nfixture,42\n"
        await writeFile(path.join(process.env.ARTIFACT_DIR!, "report.csv"), report)
        const artifactId = randomUUID()
        await pool.query(
          "INSERT INTO artifacts(id,task_id,name,storage_path,media_type,size,verification,created_at) VALUES($1,$2,'report.csv','report.csv','text/csv',$3,'{}',now())",
          [artifactId, taskId, Buffer.byteLength(report)]
        )
        const downloadReady = page.waitForEvent("download")
        await card.getByRole("link", { name: "report.csv", exact: true }).click()
        const download = await downloadReady
        assert.equal(download.suggestedFilename(), "report.csv")
        await download.saveAs(path.join(directory, "downloaded.csv"))
        assert.equal(
          await readFile(path.join(directory, "downloaded.csv"), "utf8"),
          report
        )
        await page.screenshot({
          path: path.join(directory, "companion-desktop.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({
          path: path.join(directory, "companion-mobile.png"),
          fullPage: true,
        })
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1
          ),
          "Mobile page overflows"
        )
        await card.getByRole("link", { name: "打开工作现场", exact: true }).click()
        await page.waitForURL(`${process.env.APP_URL}/?task=${taskId}`)
        const composer = page.locator("form").filter({
          has: page.getByRole("button", { name: "补充当前任务", exact: true }),
        })
        const workspaceUpload = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes("/api/uploads?")
        )
        await composer.locator('input[type="file"]').setInputFiles({
          name: "workspace-input.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("name,total\nworkspace,84\n"),
        })
        assert((await workspaceUpload).ok())
        await composer
          .getByRole("link", { name: "workspace-input.csv", exact: true })
          .waitFor()
        await composer.getByRole("textbox").fill("Include a second copy from workspace")
        const supplementSaved = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/api/tasks/${taskId}/supplements`)
        )
        await composer.getByRole("button", { name: "补充当前任务", exact: true }).click()
        const savedSupplement = await supplementSaved
        assert(savedSupplement.ok(), await savedSupplement.text())
        await page
          .getByText("Include a second copy from workspace", { exact: false })
          .first()
          .waitFor()
        assert(
          (await taskSupplements(taskId)).some(
            (note) =>
              note.text === "Include a second copy from workspace" &&
              note.attachments?.[0].name === "workspace-input.csv"
          )
        )
        const denied = await page.request.post(
          `${process.env.APP_URL}/api/tasks/${taskId}/supplements`,
          {
            data: { text: "wrong origin", clientRequestId: randomUUID() },
            headers: { origin: "https://untrusted.example" },
          }
        )
        assert.equal(denied.status(), 403)
        const { startMcpFixture } = await import("./fixtures/mcp-server.mjs")
        const connectionFixture = await startMcpFixture()
        try {
          await page.goto(`${process.env.APP_URL}/settings`)
          const settings = page.locator("#connections")
          await settings.getByLabel("连接名称", { exact: true }).fill("UI MCP")
          await settings
            .getByLabel("MCP 地址", { exact: true })
            .fill(connectionFixture.url + "/mcp")
          await settings
            .getByLabel("访问令牌（可选）", { exact: true })
            .fill("fixture-access")
          await settings
            .getByRole("checkbox", { name: /允许此连接访问本机回环地址/ })
            .check()
          await settings.getByRole("button", { name: "保存连接", exact: true }).click()
          const item = settings.locator("article").filter({ hasText: "UI MCP" })
          await item.getByRole("button", { name: "发现工具", exact: true }).click()
          await item.getByText("UI MCP · 已停用 · 2 个工具", { exact: true }).waitFor()
          await item.getByRole("button", { name: "启用", exact: true }).click()
          await item.getByRole("button", { name: "停用", exact: true }).waitFor()
          const connections = await page.request.get(
            `${process.env.APP_URL}/api/connections`
          )
          assert(!(await connections.text()).includes("fixture-access"))
          await page.screenshot({
            path: path.join(directory, "connections-mobile.png"),
            fullPage: true,
          })
          await item.getByRole("button", { name: "断开", exact: true }).click()
          await item.getByRole("button", { name: "启用", exact: true }).waitFor()
        } finally {
          await connectionFixture.close()
        }
        await page.goto(`${process.env.APP_URL}/routines`)
        await page.getByLabel("名称", { exact: true }).fill("UI event")
        await page.getByLabel("每次要做的工作", { exact: true }).fill("Process UI event")
        await page.getByLabel("触发方式", { exact: true }).selectOption("webhook")
        await page.getByRole("button", { name: "创建计划", exact: true }).click()
        await page.getByRole("button", { name: "生成事件令牌", exact: true }).click()
        const tokenText = await page.getByRole("status").innerText()
        assert(tokenText.includes("Bearer token："))
        await page.getByRole("button", { name: "收起令牌", exact: true }).click()
        await pool.query(
          "INSERT INTO workstation_control(agent_id,container_name,connection_secret,mode,epoch,updated_at) VALUES($1,$2,'fixture','human',1,now())",
          [agent, `fixture-${agent}`]
        )
        const demonstration = await page.request.post(
          `${process.env.APP_URL}/api/demonstrations`,
          {
            headers: { origin: process.env.APP_URL! },
            data: { action: "start", agentId: agent, name: "UI Demonstration" },
          }
        )
        assert(demonstration.ok())
        const demo = await demonstration.json()
        for (const [index, event] of [
          { kind: "protected_input", text: "never-saved" },
          { kind: "checkpoint", note: "Prepare UI report and verify totals" },
        ].entries())
          assert(
            (
              await page.request.post(`${process.env.APP_URL}/api/demonstrations`, {
                headers: { origin: process.env.APP_URL! },
                data: { action: "record", id: demo.id, seq: index + 1, event },
              })
            ).ok()
          )
        assert(
          (
            await page.request.post(`${process.env.APP_URL}/api/demonstrations`, {
              headers: { origin: process.env.APP_URL! },
              data: { action: "finish", id: demo.id },
            })
          ).ok()
        )
        await page.goto(`${process.env.APP_URL}/manuals`)
        const editor = page.getByRole("form", { name: "审阅操作手册" })
        await editor
          .getByLabel("操作步骤与结果检查", { exact: true })
          .fill("Prepare the requested report and verify totals equal 42.")
        await editor.getByRole("checkbox").check()
        await editor.getByRole("button", { name: "保存并启用手册", exact: true }).click()
        await page
          .getByText("Prepare the requested report and verify totals equal 42.", {
            exact: true,
          })
          .waitFor({ state: "attached" })
        checks.push(
          "Actual authenticated desktop/mobile UI: upload and supplement in both views, answer request, download artifact and reject unauthenticated files/foreign origin"
        )
      } finally {
        await browser.close()
        if (web.exitCode === null && web.pid) {
          const exited = once(web, "exit")
          if (process.platform === "win32")
            spawnSync("taskkill.exe", ["/PID", String(web.pid), "/T", "/F"], {
              windowsHide: true,
            })
          else process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "web.log"), output)
      }
    }
    await pool.query("UPDATE tasks SET status='completed',result=$2 WHERE id=$1", [
      taskId,
      JSON.stringify({ summary: "Prepared report", files: [] }),
    ])
    await assert.rejects(
      appendTaskSupplement(owner, taskId, {
        text: "Late instruction",
        clientRequestId: randomUUID(),
      }),
      { status: 409 }
    )
    assert.equal((await appendTaskSupplement(owner, taskId, input)).reused, true)
    const follow = await submitTask(owner, "test", {
      agentId: agent,
      threadId: task.threadId!,
      goal: "Continue",
      clientRequestId: randomUUID(),
      budget: { maxSteps: 5 },
      completionContract: { requireHumanReview: false },
    })
    const followConfig = (
      await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [follow.taskId])
    ).rows[0].config_snapshot
    assert.match(
      JSON.stringify(followConfig.conversation),
      /Also save the total as a CSV/
    )
    assert.equal(await syncErrands(), 1)
    assert.equal(await syncErrands(), 0)
    await deleteImageFile(image)
    assert.equal((await loadCompanionTaskImage(context, image.id)).available, false)
    checks.push(
      "Late supplements cannot alter completion; follow-up receives accepted instructions; deleted image is unavailable"
    )
    // A failed admission leaves the card pending, and a replaced card cannot be accepted.
    const invalid = randomUUID()
    await pool.query(
      "INSERT INTO companion_messages(id,agent_id,role,kind,content,metadata,created_at) VALUES($1,$2,'assistant','errand_proposal','Invalid',$3,now())",
      [invalid, agent, JSON.stringify({ goal: " ", status: "pending" })]
    )
    await assert.rejects(confirmErrand(owner, invalid))
    assert.equal(
      (
        await pool.query(
          "SELECT metadata->>'status' AS status FROM companion_messages WHERE id=$1",
          [invalid]
        )
      ).rows[0].status,
      "pending"
    )
    await pool.query("UPDATE companion_messages SET superseded_at=now() WHERE id=$1", [
      invalid,
    ])
    await assert.rejects(cancelErrand(owner, invalid), { status: 409 })
    checks.push("Failed admission remains actionable; replaced proposals cannot execute")
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
assert(passed)
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
