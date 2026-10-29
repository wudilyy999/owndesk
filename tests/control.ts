import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { connectVnc } from "./helpers/vnc"

process.loadEnvFile(".env")
const baseUrl = new URL(process.env.DATABASE_URL!)
const database = `agent_control_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: baseUrl.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
baseUrl.pathname = `/${database}`
process.env.DATABASE_URL = baseUrl.toString()
process.env.INSTALL_ID = randomUUID()
process.env.APP_URL = "http://127.0.0.1:16997"
process.env.WORKER_PORT = "16998"
process.env.WORKSTATION_MEMORY_MB = "2048"
process.env.ARTIFACT_DIR = path.join(directory, "artifacts")
process.env.OWNER_EMAIL = "control@fixture.test"
process.env.OWNER_PASSWORD = randomUUID()
const containmentOnly = process.argv[2] === "containment"
const desktopOnly = process.argv[2] === "desktop"
const transportOnly = process.argv[2] === "transport"
const checks: { check: string; detail?: unknown }[] = []
const agentIds: string[] = []
let worker: ChildProcess | undefined,
  round = 0,
  passed = false

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  name: string,
  timeout = 60000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${name}`)
}
async function run(file: string) {
  const child = spawn(process.execPath, ["--import", "tsx", file], { env: process.env })
  let output = ""
  child.stdout!.on("data", (data) => {
    output += data
  })
  child.stderr!.on("data", (data) => {
    output += data
  })
  const [code] = await once(child, "exit")
  await writeFile(path.join(directory, `${path.basename(file)}.log`), output)
  assert.equal(code, 0, output)
}
async function start() {
  let output = ""
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/control-worker.ts"],
    { env: process.env, detached: true }
  )
  const log = path.join(directory, `worker-${++round}.log`)
  worker.stdout!.on("data", (data) => {
    output += data
  })
  worker.stderr!.on("data", (data) => {
    output += data
  })
  worker.on("exit", () => {
    void writeFile(log, output).catch((error) =>
      console.error("Worker evidence write failed", error)
    )
  })
  await until(async () => {
    if (worker!.exitCode !== null) throw new Error(output)
    return output.includes("Worker ready")
  }, "worker ready")
}
async function stop(signal: NodeJS.Signals = "SIGKILL") {
  assert(worker?.pid)
  const exited = once(worker, "exit")
  process.kill(-worker.pid, signal)
  await exited
  worker = undefined
}

try {
  await run("scripts/migrate.ts")
  await run("scripts/owner.ts")
  const { pool } = await import("@/db")
  const { auth, requireOwner } = await import("@/lib/auth")
  const { submitTask } = await import("@/lib/tasks")
  const { durableClient, closeDurableClient } = await import("@/lib/durable")
  const { requestCancellation, requestTakeover, respondToRequest } =
    await import("@/lib/task-control")
  const { issueDesktopTicket } = await import("@/lib/desktop")
  const {
    workstationName,
    workstationVolume,
    viewerName,
    displayVolume,
    workspaceRow,
    controller,
    ensureWorkstation,
    workstationHealth,
  } = await import("@/lib/workstation")
  const { executeAction } = await import("@/worker/actions")
  const { docker, dockerRaw } = await import("@/lib/docker")
  const sockets: { terminate(): void }[] = []
  try {
    await start()
    const login = await auth.api.signInEmail({
      body: { email: process.env.OWNER_EMAIL!, password: process.env.OWNER_PASSWORD! },
      asResponse: true,
    })
    assert.equal(login.status, 200, await login.clone().text())
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")
    const headers = new Headers({ Cookie: cookie, Origin: process.env.APP_URL! })
    const owner = await requireOwner(headers)
    const identity = { userId: owner.userId, sessionId: owner.sessionId }
    const durable = await durableClient()
    async function task(goal: string) {
      const agentId = randomUUID()
      agentIds.push(agentId)
      await pool.query(
        "INSERT INTO agents(id,name,role,model,glyph,created_at,updated_at) VALUES($1,'Control fixture','Test','fixture/durable-report','test',now(),now())",
        [agentId]
      )
      const { taskId } = await submitTask(owner.userId, "test", {
        agentId,
        goal,
        clientRequestId: randomUUID(),
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 40 },
      })
      await until(async () => {
        const result = await pool.query(
          "SELECT mode,last_error FROM workstation_control WHERE agent_id=$1",
          [agentId]
        )
        if (result.rows[0]?.mode === "quarantined")
          throw new Error(result.rows[0].last_error)
        return result.rows[0]?.mode === "agent"
      }, `${goal} workspace acquired`)
      return { taskId, agentId }
    }
    async function state(taskId: string) {
      return (await pool.query("SELECT * FROM tasks WHERE id=$1", [taskId])).rows[0]
    }
    async function ready(taskId: string) {
      await until(async () => (await state(taskId)).result?.fixtureReady, "fixture ready")
    }
    async function position(agentId: string) {
      return (
        await docker([
          "exec",
          workstationName(agentId),
          "xdotool",
          "getmouselocation",
          "--shell",
        ])
      ).stdout
        .toString()
        .replace(/^WINDOW=.*\n?/m, "")
    }
    async function fixture(agentId: string) {
      const name = workstationName(agentId)
      await docker([
        "cp",
        "tests/fixtures/effects-site.mjs",
        `${name}:/tmp/effects-site.mjs`,
      ])
      await docker(["exec", "-d", name, "node", "/tmp/effects-site.mjs"])
      await until(
        async () =>
          (
            await dockerRaw([
              "exec",
              name,
              "curl",
              "-fsS",
              "http://127.0.0.1:8082/health",
            ])
          ).exitCode === 0,
        "effects fixture"
      )
    }
    async function cancel(taskId: string) {
      await requestCancellation(owner.userId, taskId)
      await until(
        async () => (await state(taskId)).status === "cancelled",
        "confirmed cancellation"
      )
      await until(
        async () => !(await state(taskId)).cancel_workflow_pending,
        "native workflow cancellation"
      )
    }

    if (!containmentOnly && !desktopOnly) {
      if (process.argv[2] !== "recovery") {
        const handoff = await task("handoff")
        await ready(handoff.taskId)
        for (const name of [
          workstationName(handoff.agentId),
          viewerName(handoff.agentId),
        ]) {
          const [container] = JSON.parse(
            (await docker(["inspect", name])).stdout.toString()
          )
          assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0)
          if (name === viewerName(handoff.agentId))
            assert.equal(container.HostConfig.NetworkMode, "none")
        }
        checks.push({
          check:
            "Desktop transport: zero published guest/viewer ports; immutable viewer has no network",
        })
        await assert.rejects(issueDesktopTicket(identity, handoff.agentId, "control"), {
          status: 409,
        })
        const watchTicket = await issueDesktopTicket(identity, handoff.agentId, "watch")
        const watch = await connectVnc(watchTicket, process.env.APP_URL!, cookie)
        sockets.push(watch.socket)
        const before = await position(handoff.agentId)
        watch.pointer(37, 58)
        watch.key(0x61, true)
        watch.key(0x61, false)
        await delay(300)
        assert.equal(await position(handoff.agentId), before)
        await assert.rejects(connectVnc(watchTicket, process.env.APP_URL!, cookie))
        checks.push({
          check:
            "G03: server-enforced readonly accepts a raw input-capable RFB client but discards its input; control ticket denied; ticket single-use",
        })

        const takeover = await requestTakeover(
          handoff.taskId,
          "Test manual login",
          undefined,
          owner.userId
        )
        await until(
          async () => (await workspaceRow(handoff.agentId)).mode === "human",
          "human control ready"
        )
        await until(async () => watch.closed, "old watch connection revoked")
        const controlTicket = await issueDesktopTicket(
          identity,
          handoff.agentId,
          "control"
        )
        const staleTicket = await issueDesktopTicket(identity, handoff.agentId, "control")
        const control = await connectVnc(controlTicket, process.env.APP_URL!, cookie)
        sockets.push(control.socket)
        control.pointer(123, 234)
        await until(
          async () => (await position(handoff.agentId)).includes("X=123\nY=234"),
          "real human input"
        )
        const humanEpoch = controlTicket.epoch
        control.key(0xffe1, true) // Hold Shift and mouse down across the handback.
        control.pointer(123, 234, 1)
        await delay(100)
        await respondToRequest(owner.userId, takeover.requestId, "handback", 1, {})
        await until(
          async () => (await workspaceRow(handoff.agentId)).mode === "agent",
          "agent handback"
        )
        await until(
          async () => control.closed,
          "manual connection closed before handback"
        )
        await assert.rejects(connectVnc(staleTicket, process.env.APP_URL!, cookie))
        const stale = await executeAction(
          handoff.taskId,
          1,
          90,
          "key_type",
          { text: "stale input must not run" },
          humanEpoch
        )
        assert.equal(stale.stale, true)
        const keys = await docker(
          ["exec", "-i", workstationName(handoff.agentId), "python3", "-"],
          {
            input: `import ctypes,json
x=ctypes.CDLL('libX11.so.6'); x.XOpenDisplay.restype=ctypes.c_void_p
x.XQueryKeymap.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
x.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong]+[ctypes.c_void_p]*7
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x.XDefaultRootWindow.restype=ctypes.c_ulong
d=x.XOpenDisplay(None); keys=(ctypes.c_ubyte*32)(); x.XQueryKeymap(d,keys)
r=ctypes.c_ulong(); c=ctypes.c_ulong(); rx=ctypes.c_int(); ry=ctypes.c_int(); wx=ctypes.c_int(); wy=ctypes.c_int(); mask=ctypes.c_uint()
x.XQueryPointer(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(c),ctypes.byref(rx),ctypes.byref(ry),ctypes.byref(wx),ctypes.byref(wy),ctypes.byref(mask))
print(json.dumps({'keys':list(keys),'mask':mask.value}))`,
          }
        )
        const inputState = JSON.parse(keys.stdout.toString())
        assert(inputState.keys.every((n: number) => n === 0))
        assert.equal(inputState.mask & (1 | 256 | 512 | 1024), 0)
        checks.push({
          check:
            "G03: manual input works only after human-ready; handback revokes old socket/ticket, releases held keys/buttons and rejects stale model epoch",
        })

        for (let reconnect = 0; reconnect < 3; reconnect++) {
          const watching = await connectVnc(
            await issueDesktopTicket(identity, handoff.agentId, "watch"),
            process.env.APP_URL!,
            cookie
          )
          sockets.push(watching.socket)
          if (reconnect === 2) watching.socket.send("text frames are not desktop bytes")
          else watching.socket.terminate()
          await until(async () => watching.closed, "watch disconnect")
          await until(
            async () =>
              !(
                await docker(["top", viewerName(handoff.agentId), "-eo", "pid,args"])
              ).stdout.includes("Desktop loopback relay failed"),
            "watch relay process exit"
          )
        }
        checks.push({
          check:
            "Desktop transport: reconnects clean up remote relays; nonbinary client frames terminate",
        })

        const watchAfter = await connectVnc(
          await issueDesktopTicket(identity, handoff.agentId, "watch"),
          process.env.APP_URL!,
          cookie
        )
        sockets.push(watchAfter.socket)
        await auth.api.signOut({ headers })
        await until(async () => watchAfter.closed, "logout revokes desktop", 6000)
        checks.push({ check: "G03: logout revokes an existing desktop connection" })
        await cancel(handoff.taskId)

        if (transportOnly) {
          const legacy = randomUUID()
          agentIds.push(legacy)
          await pool.query(
            "INSERT INTO agents(id,name,role,model,glyph,created_at,updated_at) VALUES($1,'Legacy transport fixture','Test','fixture/durable-report','test',now(),now())",
            [legacy]
          )
          const labels = ["--label", `personal-agent.install=${process.env.INSTALL_ID}`]
          const image = process.env.WORKSTATION_IMAGE ?? "owndesk-workstation:0.4.0"
          await docker([
            "create",
            "--name",
            workstationName(legacy),
            ...labels,
            "--label",
            "personal-agent.protocol=6",
            "--publish",
            "127.0.0.1::6081/tcp",
            "--entrypoint",
            "/bin/true",
            image,
          ])
          await assert.rejects(ensureWorkstation(legacy), /legacy published ports/)
          assert.equal(
            (
              await docker([
                "inspect",
                "--format",
                "{{.State.Running}}",
                workstationName(legacy),
              ])
            ).stdout
              .toString()
              .trim(),
            "false"
          )
          await docker(["rm", workstationName(legacy)])
          await docker([
            "create",
            "--name",
            viewerName(legacy),
            ...labels,
            "--publish",
            "127.0.0.1::6080/tcp",
            "--entrypoint",
            "/bin/true",
            image,
          ])
          await assert.rejects(ensureWorkstation(legacy), /legacy networking/)
          assert.equal(
            (
              await docker([
                "inspect",
                "--format",
                "{{.State.Running}}",
                viewerName(legacy),
              ])
            ).stdout
              .toString()
              .trim(),
            "false"
          )
          await docker(["rm", viewerName(legacy)])
          await ensureWorkstation(legacy)
          checks.push({
            check:
              "Desktop transport upgrade: legacy published guest/viewer rejected before start; explicit recreation succeeds",
          })
          const beforeIdleRestart = await workspaceRow(legacy)
          await docker(["stop", "--time", "10", workstationName(legacy)])
          await ensureWorkstation(legacy)
          const afterIdleRestart = await workspaceRow(legacy)
          const idleHealth = await workstationHealth(legacy)
          assert.notEqual(afterIdleRestart.bootId, beforeIdleRestart.bootId)
          assert.equal(afterIdleRestart.bootId, idleHealth.bootId)
          assert.equal(afterIdleRestart.epoch, idleHealth.epoch)
          assert(afterIdleRestart.epoch > beforeIdleRestart.epoch)
          assert.equal(afterIdleRestart.mode, "idle")
          assert.equal(idleHealth.mode, "idle")
          assert.equal(afterIdleRestart.activeTaskId, null)
          checks.push({
            check:
              "Idle cold boot reconciles the controller boot and epoch before desktop use",
          })
        }

        for (const goal of transportOnly ? [] : ["background", "active-shell"]) {
          const current = await task(goal)
          await until(
            async () =>
              (
                await dockerRaw([
                  "exec",
                  workstationName(current.agentId),
                  "test",
                  "-s",
                  "/home/agent/control-heartbeat",
                ])
              ).exitCode === 0,
            "actual shell effect"
          )
          if (goal === "background") await ready(current.taskId)
          const started = Date.now()
          await cancel(current.taskId)
          const inspect = await dockerRaw(["inspect", workstationName(current.agentId)])
          assert.notEqual(
            inspect.exitCode,
            0,
            "Cancelled Shell container must be removed"
          )
          // Read retained home using a separate non-networked immutable inspection container.
          const readHeartbeat = async () =>
            (
              await docker([
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--volume",
                `${workstationVolume(current.agentId)}:/data:ro`,
                "--entrypoint",
                "/bin/cat",
                process.env.WORKSTATION_IMAGE ?? "owndesk-workstation:0.4.0",
                "/data/control-heartbeat",
              ])
            ).stdout.toString()
          const stopped = await readHeartbeat()
          await delay(400)
          assert.equal(await readHeartbeat(), stopped)
          checks.push({
            check: `G03: ${goal} cancellation stops actual effects and removes the container boundary`,
            detail: { elapsedMs: Date.now() - started },
          })
        }
      }
      if (!transportOnly) {
        const download = await task("download")
        await ready(download.taskId)
        await fixture(download.agentId)
        await durable.send(`${download.taskId}:1`, {}, "fixture-go")
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM task_actions WHERE task_id=$1 AND action_no=3",
                [download.taskId]
              )
            ).rowCount === 1,
          "download intent"
        )
        const lock = await pool.connect()
        await lock.query("BEGIN")
        await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [download.taskId])
        try {
          const id = `${download.taskId}-s1-a3`
          await until(
            async () =>
              (
                await controller<{ status: string }>(download.agentId, "/action-status", {
                  id,
                })
              ).status === "succeeded",
            "external download succeeded"
          )
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM task_actions WHERE task_id=$1 AND action_no=3",
                [download.taskId]
              )
            ).rows[0].status,
            "intent"
          )
          await stop()
        } finally {
          await lock.query("ROLLBACK")
          lock.release()
        }
        await start()
        await until(
          async () => (await state(download.taskId)).status === "completed",
          "download recovered"
        )
        const effectCount = await docker([
          "exec",
          workstationName(download.agentId),
          "cat",
          "/home/agent/.fixture-effects/downloads",
        ])
        assert.deepEqual(effectCount.stdout.toString().trim().split("\n"), ["download"])
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_action_attempts WHERE task_id=$1 AND action_no=3",
              [download.taskId]
            )
          ).rows[0].n,
          1
        )
        checks.push({
          check:
            "G04: real download succeeds before worker receipt; worker SIGKILL + replay adopts receipt with one download and one dispatch",
        })

        const unknown = await task("unknown-submit")
        await ready(unknown.taskId)
        await fixture(unknown.agentId)
        await durable.send(`${unknown.taskId}:1`, {}, "fixture-go")
        await until(
          async () =>
            (
              await dockerRaw([
                "exec",
                workstationName(unknown.agentId),
                "test",
                "-s",
                "/home/agent/.fixture-effects/submits",
              ])
            ).exitCode === 0,
          "external POST committed"
        )
        await stop()
        await docker(["kill", workstationName(unknown.agentId)])
        await start()
        await until(
          async () => (await state(unknown.taskId)).status === "needs_review",
          "unknown outcome review"
        )
        const submitted = await docker([
          "exec",
          workstationName(unknown.agentId),
          "cat",
          "/home/agent/.fixture-effects/submits",
        ])
        assert.deepEqual(submitted.stdout.toString().trim().split("\n"), ["submit"])
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_requests WHERE task_id=$1 AND kind='review'",
              [unknown.taskId]
            )
          ).rows[0].n,
          1
        )
        assert.equal(
          (
            await pool.query(
              "SELECT status FROM task_actions WHERE task_id=$1 AND action_no=3",
              [unknown.taskId]
            )
          ).rows[0].status,
          "unknown"
        )
        checks.push({
          check:
            "G04: POST commits without reply, worker and controller die; recovery requests review without replaying the submit",
        })
        await cancel(unknown.taskId)
      }
    }

    if (containmentOnly) {
      const frozen = await task("background")
      await ready(frozen.taskId)
      await docker([
        "exec",
        workstationName(frozen.agentId),
        "pkill",
        "-STOP",
        "-f",
        "^node /opt/owndesk-controller/server.mjs$",
      ])
      const began = Date.now()
      await cancel(frozen.taskId)
      assert.notEqual(
        (await dockerRaw(["inspect", workstationName(frozen.agentId)])).exitCode,
        0
      )
      checks.push({
        check:
          "G03 extension: cancellation removes the process boundary even when the controller is suspended",
        detail: { elapsedMs: Date.now() - began },
      })

      const slow = await task("handoff")
      await ready(slow.taskId)
      const fast = await task("handoff")
      await ready(fast.taskId)
      await docker([
        "exec",
        workstationName(slow.agentId),
        "pkill",
        "-STOP",
        "-f",
        "^node /opt/owndesk-controller/server.mjs$",
      ])
      await requestTakeover(
        slow.taskId,
        "Unresponsive controller",
        undefined,
        owner.userId
      )
      await until(
        async () => (await workspaceRow(slow.agentId)).mode === "quiescing",
        "slow handoff entered"
      )
      await cancel(fast.taskId)
      assert.equal(
        (await workspaceRow(slow.agentId)).mode,
        "quiescing",
        "A different workspace's cancellation must finish before the slow handoff"
      )
      await until(
        async () => (await workspaceRow(slow.agentId)).mode === "quarantined",
        "failed handoff contained"
      )
      assert.notEqual(
        (await dockerRaw(["inspect", workstationName(slow.agentId)])).exitCode,
        0
      )
      assert.equal((await state(slow.taskId)).status, "needs_review")
      checks.push({
        check:
          "G03 extension: a slow handoff does not block another workspace's cancellation; failed transfer removes the guest before quarantining",
      })
      await cancel(slow.taskId)
    }
    if (desktopOnly) {
      const current = await task("handoff")
      await ready(current.taskId)
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "16997",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED")
              return false
            throw error
          }
        }, "development Web ready")
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        })
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByText(`任务 ID：${current.taskId}`, { exact: true }).waitFor()
        const snapshot = await context.request.get(
          `${process.env.APP_URL}/api/tasks/${current.taskId}`
        )
        const detail = await snapshot.json()
        assert.deepEqual(Object.keys(detail.control).sort(), [
          "desiredMode",
          "epoch",
          "mode",
          "updatedAt",
        ])
        assert(!JSON.stringify(detail).includes("connectionSecret"))
        await page.getByRole("button", { name: "连接桌面", exact: true }).click()
        await page.getByRole("status").filter({ hasText: "已连接" }).waitFor()
        // A handshake alone can succeed while the VNC framebuffer stays black.
        async function visibleDesktop() {
          await page.waitForFunction(
            () => {
              const canvas = document.querySelector("canvas")
              if (!canvas || canvas.width < 100) return false
              const pixel = canvas
                .getContext("2d")!
                .getImageData(
                  Math.floor(canvas.width / 2),
                  Math.floor(canvas.height / 2),
                  1,
                  1
                ).data
              return pixel[0] > 100 && pixel[1] > 100 && pixel[2] > 100
            },
            undefined,
            { timeout: 15000 }
          )
        }
        await visibleDesktop()
        await page.screenshot({ path: path.join(directory, "watch.png"), fullPage: true })
        await page.getByRole("button", { name: "接管桌面", exact: true }).click()
        await page
          .getByRole("heading", { name: "你拥有桌面控制权", exact: true })
          .waitFor()
        const dialog = page.getByRole("dialog")
        await until(
          async () => (await dialog.locator("canvas").count()) === 1,
          "one live desktop canvas"
        )
        await page.screenshot({
          path: path.join(directory, "control.png"),
          fullPage: true,
        })
        await dialog.getByRole("button", { name: "Close", exact: true }).click()
        await page.getByRole("button", { name: "交还给 Agent", exact: true }).click()
        await until(
          async () => (await workspaceRow(current.agentId)).mode === "agent",
          "UI handback confirmed"
        )
        await page.getByRole("status").filter({ hasText: "已连接" }).waitFor()
        await visibleDesktop()
        await page.setViewportSize({ width: 390, height: 844 })
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
          ),
          false
        )
        await page.screenshot({
          path: path.join(directory, "mobile-watch.png"),
          fullPage: true,
        })
        await page.getByRole("button", { name: "取消任务", exact: true }).click()
        await page.getByRole("heading", { name: "已取消", exact: true }).waitFor()
        assert.deepEqual(pageErrors, [])
        checks.push({
          check:
            "Desktop UI: login, task-bound safe snapshot, real noVNC watch, manual takeover, handback/reconnect, mobile layout and actual cancellation",
          detail: { taskId: current.taskId, browser: browser.version() },
        })
      } finally {
        const viewerLogs = await dockerRaw([
          "exec",
          viewerName(current.agentId),
          "sh",
          "-c",
          "cat /tmp/viewer.log /tmp/websockify.log",
        ])
        await writeFile(
          path.join(directory, "viewer-before-stop.log"),
          viewerLogs.stdout.toString() + viewerLogs.stderr
        )
        await browser?.close()
        if (web.exitCode === null && web.pid) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "web.log"), webLog)
      }
    }
    await stop("SIGTERM")
    passed = true
  } finally {
    for (const socket of sockets) socket.terminate()
    if (worker) await stop()
    for (const id of agentIds) {
      for (const name of [viewerName(id), workstationName(id)]) {
        const logs = await dockerRaw(["logs", name])
        const guestLogs = await dockerRaw([
          "exec",
          name,
          "sh",
          "-c",
          "cat /tmp/viewer.log /tmp/websockify.log /tmp/owndesk/browser.log /tmp/owndesk/vnc.log 2>/dev/null",
        ])
        await writeFile(
          path.join(directory, `${name}.log`),
          logs.stdout.toString() +
            logs.stderr +
            guestLogs.stdout.toString() +
            guestLogs.stderr
        )
        const result = await dockerRaw(["rm", "--force", name])
        if (result.exitCode !== 0 && !/no such (container|object)/i.test(result.stderr))
          console.error("Container cleanup failed", result.stderr)
      }
      for (const volume of [workstationVolume(id), displayVolume(id)]) {
        const result = await dockerRaw(["volume", "rm", volume])
        if (result.exitCode !== 0 && !/no such volume/i.test(result.stderr))
          console.error("Volume cleanup failed", result.stderr)
      }
    }
    await closeDurableClient()
    await pool.end()
  }
} finally {
  const evidence = {
    passed,
    fixtureOnly: true,
    checks,
    recordedAt: new Date().toISOString(),
    directory,
  }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  if (passed) {
    await writeFile(
      containmentOnly
        ? "docs/evidence/containment.json"
        : desktopOnly
          ? "docs/evidence/desktop.json"
          : transportOnly
            ? "docs/evidence/desktop-transport.json"
            : process.argv[2] === "recovery"
              ? "docs/evidence/recovery.json"
              : "docs/evidence/control.json",
      JSON.stringify(evidence, null, 2) + "\n"
    )
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
  }
  await admin.end()
  console.log(JSON.stringify(evidence, null, 2))
}
