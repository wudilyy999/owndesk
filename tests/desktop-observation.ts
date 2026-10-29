import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker, dockerRaw } from "@/lib/docker"

const container = `pa-c0-${Date.now()}`
const directory = path.resolve("data/experiments", container)
await mkdir(directory, { recursive: true })
const checks: Record<string, unknown>[] = []
const trace: Record<string, unknown>[] = []
let passed = false

async function request(route: string, body: unknown): Promise<any> {
  const result = await docker(
    ["exec", "-i", container, "node", "/opt/owndesk-controller/request.mjs", route],
    { input: JSON.stringify(body), maxOutputBytes: 6000000 }
  )
  return JSON.parse(result.stdout.toString())
}

async function action(
  kind: string,
  params: Record<string, unknown>,
  id = randomBytes(10).toString("hex")
) {
  if (kind.startsWith("pointer_")) params = { coordinateMode: "pixels", ...params }
  await request("/actions", { id, kind, params })
  const deadline = Date.now() + 90000
  let previousStatus: string | undefined
  while (Date.now() < deadline) {
    const result = await request("/action-status", { id })
    if (result.status !== previousStatus) {
      trace.push({
        id,
        kind,
        status: result.status,
        error: result.error,
        found: result.found,
      })
      previousStatus = result.status
    }
    if (["succeeded", "rejected", "unknown"].includes(result.status)) return result
    await delay(50)
  }
  throw new Error(`Action ${id} did not finish`)
}

try {
  await docker(
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "personal-agent.experiment=C0",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--shm-size",
      "1g",
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      "owndesk-workstation:0.6.1",
    ],
    {
      env: {
        PA_WORKSPACE_TOKEN: randomBytes(32).toString("hex"),
        OWNDESK_VNC_PASSWORD: randomBytes(12).toString("hex"),
      },
    }
  )
  await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
  await request("/control", { epoch: 1, mode: "agent" })
  let frame = (await action("screen_capture", { epoch: 1 })).result
  assert.equal(frame.coordinateSpace, "screenshot_pixels")
  assert.deepEqual([frame.width, frame.height], [1280, 800])
  assert(frame.window.wmClass.includes("Chromium"))
  await writeFile(path.join(directory, "initial.jpg"), Buffer.from(frame.image, "base64"))
  checks.push({
    name: "actual desktop dimensions and native window",
    width: frame.width,
    height: frame.height,
    window: frame.window,
    mapping: frame.mapping,
  })

  const prior = frame.observationId
  frame = (await action("screen_capture", { epoch: 1 })).result
  const stale = await action("pointer_click", {
    epoch: 1,
    observationId: prior,
    x: 100,
    y: 100,
  })
  assert.equal(stale.status, "rejected")
  assert.match(stale.error, /Stale desktop observation/)
  checks.push({ name: "superseded frame rejected before input", status: stale.status })

  const points = [
    [160, 120],
    [1100, 120],
    [160, 680],
    [640, 400],
    [1100, 680],
  ]
  const positions = []
  for (const [x, y] of points) {
    const id = randomBytes(10).toString("hex")
    const result = await action(
      "pointer_move",
      { epoch: 1, observationId: frame.observationId, x, y },
      id
    )
    assert.equal(result.status, "succeeded", result.error)
    const position = await docker([
      "exec",
      container,
      "xdotool",
      "getmouselocation",
      "--shell",
    ])
    assert.match(position.stdout.toString(), new RegExp(`X=${x}\nY=${y}\n`))
    const replay = await action(
      "pointer_move",
      { epoch: 1, observationId: frame.observationId, x, y },
      id
    )
    assert.equal(
      replay.result.observationId,
      result.result.observationId,
      "same dispatch reuses its durable receipt"
    )
    frame = result.result
    positions.push({ x, y, passed: true })
  }
  checks.push({
    name: "explicit pixel mapping; three points plus two independent positions",
    positions,
    modelCalibration: false,
  })
  for (const [x, y] of [
    [500, 500],
    [1000, 1000],
  ]) {
    const result = await action("pointer_move", {
      epoch: 1,
      observationId: frame.observationId,
      coordinateMode: "normalized_1000",
      x,
      y,
    })
    assert.equal(result.status, "succeeded", result.error)
    assert.deepEqual(
      [result.result.executedInput.x, result.result.executedInput.y],
      [Math.round((x * 1279) / 1000), Math.round((y * 799) / 1000)]
    )
    frame = result.result
  }
  checks.push({
    name: "explicit normalized mapping including center and screen boundary",
    passed: true,
  })
  const consumed = frame.observationId
  const moved = await action("pointer_move", {
    epoch: 1,
    observationId: consumed,
    x: 640,
    y: 400,
  })
  assert.equal(moved.status, "succeeded", moved.error)
  assert.equal(
    (await action("pointer_click", { epoch: 1, observationId: consumed, x: 640, y: 400 }))
      .status,
    "rejected"
  )
  frame = moved.result
  const outOfBounds = await action("pointer_click", {
    epoch: 1,
    observationId: frame.observationId,
    x: 1280,
    y: 400,
  })
  assert.equal(outOfBounds.status, "rejected")
  checks.push({ name: "single-input frame and actual-size bounds", passed: true })

  frame = (await action("screen_capture", { epoch: 1 })).result
  await request("/control", { epoch: 2, mode: "human" })
  await request("/control", { epoch: 3, mode: "agent" })
  const oldControl = await action("key_press", {
    epoch: 3,
    observationId: frame.observationId,
    key: "enter",
  })
  assert.equal(oldControl.status, "rejected")
  frame = (await action("screen_capture", { epoch: 3 })).result
  assert.equal(frame.epoch, 3)
  assert.equal(
    (
      await action("key_press", {
        epoch: 3,
        observationId: frame.observationId,
        key: "esc",
      })
    ).status,
    "succeeded"
  )
  checks.push({
    name: "human handback rejects old frame and accepts fresh observation",
    passed: true,
  })

  await docker(["exec", "-d", container, "thunar", "/home/agent"])
  await delay(1500)
  frame = (await action("screen_capture", { epoch: 3 })).result
  assert.match(frame.window.wmClass, /Thunar/i)
  await writeFile(path.join(directory, "thunar.jpg"), Buffer.from(frame.image, "base64"))
  checks.push({
    name: "native Thunar title/class/bounds observation",
    window: frame.window,
  })
  await docker([
    "exec",
    container,
    "xdotool",
    "windowsize",
    frame.window.id,
    "900",
    "600",
  ])
  await delay(250)
  const resized = await action("key_press", {
    epoch: 3,
    observationId: frame.observationId,
    key: "esc",
  })
  assert.equal(resized.status, "rejected")
  assert.match(resized.error, /window changed/)
  frame = (await action("screen_capture", { epoch: 3 })).result
  assert.equal(frame.window.width, 900)
  checks.push({
    name: "window resize rejects the old observation before input",
    window: frame.window,
  })
  const oldBoot = frame.bootId
  const oldObservation = frame.observationId
  await docker(["restart", "--time", "5", container], { timeoutMs: 45000 })
  await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
  await request("/control", { epoch: 4, mode: "agent" })
  assert.equal(
    (await action("key_press", { epoch: 4, observationId: oldObservation, key: "enter" }))
      .status,
    "rejected"
  )
  frame = (await action("screen_capture", { epoch: 4 })).result
  assert.notEqual(frame.bootId, oldBoot)
  checks.push({
    name: "controller restart invalidates the previous boot's observations",
    passed: true,
  })
  const uncertainScreenshotFrame = frame.observationId
  const receiptId = randomBytes(10).toString("hex")
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "mv",
    "/usr/local/bin/owndesk-shot",
    "/usr/local/bin/owndesk-shot.disabled",
  ])
  try {
    const moved = await action(
      "pointer_move",
      { epoch: 4, observationId: uncertainScreenshotFrame, x: 400, y: 300 },
      receiptId
    )
    assert.equal(moved.status, "succeeded", moved.error)
    assert.equal(moved.result.image, null)
    assert.equal(moved.result.observationId, null)
    assert(moved.result.observationError)
    assert.equal(
      (
        await action(
          "pointer_move",
          { epoch: 4, observationId: uncertainScreenshotFrame, x: 400, y: 300 },
          receiptId
        )
      ).status,
      "succeeded"
    )
    assert.equal(
      (
        await action("key_press", {
          epoch: 4,
          observationId: uncertainScreenshotFrame,
          key: "enter",
        })
      ).status,
      "rejected"
    )
  } finally {
    await docker([
      "exec",
      "-u",
      "root",
      container,
      "mv",
      "/usr/local/bin/owndesk-shot.disabled",
      "/usr/local/bin/owndesk-shot",
    ])
  }
  frame = (await action("screen_capture", { epoch: 4 })).result
  assert(frame.observationId)
  checks.push({
    name: "input succeeds with a lost post-action screenshot; old frame stays consumed and receipt replay never inputs again",
    passed: true,
  })
  passed = true
} finally {
  await writeFile(path.join(directory, "actions.json"), JSON.stringify(trace, null, 2))
  if (!passed) {
    const logs = await dockerRaw(["logs", container])
    await writeFile(
      path.join(directory, "container.log"),
      `${logs.stdout.toString()}\n${logs.stderr}`
    )
  }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        passed,
        scope: "C0 real Docker controller mechanisms; no model or GUI task acceptance",
        directory,
        checks,
      },
      null,
      2
    )
  )
  if (passed)
    await writeFile(
      "docs/evidence/desktop-observation.json",
      JSON.stringify({ passed, directory, checks, guestProtocol: 6 }, null, 2)
    )
  await dockerRaw(["rm", "-f", container])
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
