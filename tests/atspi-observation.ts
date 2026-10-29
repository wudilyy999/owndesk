import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { generateText, type ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { docker } from "@/lib/docker"
import { prepareModelContext } from "@/lib/agent/context"
import { agentTools } from "@/lib/agent/tools"

// Real isolated desktop; SDK requests are captured locally, with zero cloud calls.
const directory = path.resolve(process.argv[2] ?? `data/experiments/atspi-${Date.now()}`)
await mkdir(directory, { recursive: true })
const container = `pa-atspi-${Date.now()}`
const checks: string[] = []
let passed = false
const image = process.env.ATSPI_TEST_IMAGE ?? "owndesk-workstation:0.6.4"
async function request(route: string, body: unknown) {
  const result = await docker(
    ["exec", "-i", container, "node", "/opt/owndesk-controller/request.mjs", route],
    {
      input: JSON.stringify(body),
      maxOutputBytes: 6000000,
    }
  )
  return JSON.parse(result.stdout.toString())
}
async function action(kind: string, params: Record<string, unknown>, id = randomUUID()) {
  await request("/actions", { id, kind, params })
  for (let i = 0; i < 200; i++) {
    const receipt = await request("/action-status", { id })
    if (["succeeded", "rejected", "unknown"].includes(receipt.status)) return receipt
    await delay(50)
  }
  throw new Error(`Action ${kind} did not finish`)
}
async function capture() {
  const receipt = await action("screen_capture", { epoch: 1 })
  assert.equal(receipt.status, "succeeded", receipt.error)
  return receipt.result
}
try {
  await docker(
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "personal-agent.experiment=atspi-observation",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--shm-size",
      "512m",
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      image,
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
  const initial = await capture()
  assert.equal(initial.accessibility.status, "unavailable")
  assert(initial.image)
  checks.push("empty desktop retains screenshot with explicit unavailable accessibility")

  const thunar = await action("desktop_open_application", {
    epoch: 1,
    application: "Thunar",
  })
  assert.equal(thunar.status, "succeeded", thunar.error)
  assert.equal(
    thunar.result.accessibility.status,
    "ok",
    JSON.stringify(thunar.result.accessibility)
  )
  assert(thunar.result.elements.some((item: any) => item.name === "File"))
  await writeFile(
    path.join(directory, "thunar.json"),
    JSON.stringify(thunar.result, null, 2)
  )
  checks.push("real Thunar screenshot includes native control names")

  await docker([
    "cp",
    "tests/fixtures/atspi-observation.py",
    `${container}:/tmp/atspi-fixture.py`,
  ])
  // Controller shell inherits the desktop's private D-Bus session.
  const launched = await action("shell", {
    epoch: 1,
    command: "python3 /tmp/atspi-fixture.py >/tmp/atspi-fixture.log 2>&1 &",
    timeout: 5,
  })
  assert.equal(launched.status, "succeeded", launched.error)
  await delay(1200)
  let frame = await capture()
  assert.equal(frame.window.title, "AT-SPI Observation Fixture")
  assert.equal(frame.accessibility.status, "ok", JSON.stringify(frame.accessibility))
  const find = (name: string) => frame.elements.find((item: any) => item.name === name)
  assert(find("Save report"))
  assert(find("Disabled export").states.includes("disabled"))
  assert(find("Enable sync").states.includes("checked"))
  assert.equal(find("Report title").text, "Quarterly report")
  assert.equal(find("Volume").value, 37)
  assert(
    frame.elements.some((item: any) => item.redacted && item.role === "password text")
  )
  for (const marker of [
    "FIXTURE_PASSWORD_MUST_NOT_LEAK",
    "HIDDEN_CONTROL_MUST_NOT_LEAK",
    "BACKGROUND_WINDOW_MUST_NOT_LEAK",
  ])
    assert(!JSON.stringify(frame).includes(marker), marker)
  await writeFile(path.join(directory, "fixture.jpg"), Buffer.from(frame.image, "base64"))
  await writeFile(path.join(directory, "fixture.json"), JSON.stringify(frame, null, 2))
  checks.push(
    "GTK names/text/value/checked/disabled/bounds observed; password, hidden and background text excluded"
  )

  const old = frame.observationId
  const button = find("Save report").bounds
  const id = randomUUID()
  const params = {
    epoch: 1,
    observationId: old,
    coordinateMode: "pixels",
    x: button.x + Math.floor(button.width / 2),
    y: button.y + Math.floor(button.height / 2),
  }
  const clicked = await action("pointer_click", params, id)
  assert.equal(clicked.status, "succeeded", clicked.error)
  frame = clicked.result
  assert(frame.elements.some((item: any) => item.name === "Report saved"))
  assert.notEqual(frame.observationId, old)
  assert.deepEqual((await action("pointer_click", params, id)).result, clicked.result)
  assert.equal((await action("pointer_click", params)).status, "rejected")
  checks.push(
    "coordinate click refreshes tree; receipt replay identical; consumed observation rejected"
  )

  // Force only the independent reader to fail, with no GUI action or cloud model.
  const readerPath = "/opt/owndesk-controller/accessibility.py"
  for (const [name, source, reason] of [
    ["timeout", "import time; time.sleep(10)", "reader_timeout"],
    ["invalid", "print('invalid JSON')", "invalid_reader_output"],
    ["error", "raise RuntimeError('fixture failure')", "reader_failed"],
  ]) {
    await docker(["exec", "--user", "root", "-i", container, "tee", readerPath], {
      input: source,
    })
    const failed = await capture()
    assert.equal(failed.accessibility.status, "unavailable", name)
    assert.equal(failed.accessibility.reason, reason, name)
    assert(failed.image && failed.observationId)
  }
  await docker([
    "cp",
    "workstation/controller/accessibility.py",
    `${container}:${readerPath}`,
  ])
  checks.push(
    "reader timeout, malformed output and process failure preserve screenshots with explicit status"
  )

  const source = await readFile("workstation/controller/accessibility.py", "utf8")
  await docker(["exec", "--user", "root", "-i", container, "tee", readerPath], {
    input: source.replace(
      "MAX_NODES, MAX_ELEMENTS, MAX_BYTES = 600, 60, 24000",
      "MAX_NODES, MAX_ELEMENTS, MAX_BYTES = 3, 60, 24000"
    ),
  })
  const partial = await capture()
  assert.equal(partial.accessibility.status, "partial")
  assert.equal(partial.accessibility.truncated, true)
  await docker([
    "cp",
    "workstation/controller/accessibility.py",
    `${container}:${readerPath}`,
  ])
  frame = await capture()
  assert.equal(frame.accessibility.status, "ok")
  checks.push("bounded traversal reports partial and truncation")

  const history: ModelMessage[] = [
    { role: "user", content: "Inspect the current desktop." },
  ]
  for (const [index, observed] of [initial, thunar.result, frame].entries()) {
    const { image: jpeg, ...metadata } = observed
    history.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "screen_capture",
            toolCallId: `observe-${index}`,
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "screen_capture",
            toolCallId: `observe-${index}`,
            output: {
              type: "content",
              value: [
                { type: "text", text: JSON.stringify(metadata) },
                {
                  type: "file",
                  mediaType: "image/jpeg",
                  data: { type: "data", data: jpeg },
                },
              ],
            },
          },
        ],
      }
    )
  }
  let captured: any
  const model = createOpenAI({
    apiKey: "offline-placeholder",
    baseURL: "https://offline.invalid/v1",
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "offline.invalid")
      captured = JSON.parse(String(init!.body))
      return new Response(
        JSON.stringify({ error: { message: "Offline capture complete" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    },
  })("gpt-6.1-sol")
  await assert.rejects(
    generateText({
      model,
      ...prepareModelContext("openai/gpt-6.1-sol", history, {
        taskId: "atspi-isolated",
        threadId: "atspi-isolated",
        segmentNo: 1,
        epoch: 1,
        bootId: frame.bootId,
      }),
      tools: { screen_capture: agentTools.screen_capture },
      maxRetries: 0,
    }),
    /Offline capture complete/
  )
  const serialized = JSON.stringify(captured)
  assert(serialized.includes("Save report") && serialized.includes("Quarterly report"))
  assert.equal((serialized.match(/data:image\/jpeg;base64,/g) ?? []).length, 2)
  await writeFile(
    path.join(directory, "model-request-metadata.json"),
    JSON.stringify(
      captured,
      (_key, value) =>
        typeof value === "string" && value.startsWith("data:image/")
          ? "[original JPEG omitted from evidence]"
          : value,
      2
    )
  )
  checks.push(
    "actual SDK request contains AT-SPI controls and at most two original screenshots (local fetch only)"
  )
  await request("/control", { epoch: 2, mode: "human" })
  assert.equal(
    (
      await action("key_press", {
        epoch: 1,
        observationId: frame.observationId,
        key: "enter",
      })
    ).status,
    "rejected"
  )
  checks.push("human takeover rejects old-epoch input")
  passed = true
} finally {
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        passed,
        container,
        image,
        checks,
        cloudCalls: 0,
        taskRecords: 0,
        testedAt: new Date().toISOString(),
      },
      null,
      2
    )
  )
  await docker(["stop", container])
}
console.log(JSON.stringify({ passed, directory, checks }))
