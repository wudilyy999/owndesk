import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import {
  comparisonRequest,
  completedNativeRead,
  type ObservationArm,
} from "./atspi-ab-protocol"

assert(
  (process.argv[2] === "--prepare" && process.argv.length === 3) ||
    (process.argv[2] === "--run" && process.argv.length === 4),
  "Use --prepare, inspect the frozen cases, then --run DIRECTORY once"
)
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const main = new pg.Client({ connectionString: process.env.DATABASE_URL })
await main.connect()
const mainCounts = async () =>
  (
    await main.query(`SELECT
  (SELECT count(*)::int FROM tasks) tasks,
  (SELECT count(*)::int FROM task_model_attempts) attempts,
  (SELECT count(*)::int FROM task_actions) actions,
  (SELECT count(*)::int FROM artifacts) artifacts,
  (SELECT count(*)::int FROM tasks WHERE status IN ('queued','running')) active`)
  ).rows[0]
const mainBefore = await mainCounts()
const preparing = process.argv[2] === "--prepare"
const directory = preparing
  ? path.resolve("data/experiments", `atspi-ab-${Date.now()}`)
  : path.resolve(process.argv[3])
await mkdir(directory, { recursive: true, mode: 0o700 })
const root = "/home/agent/ABTest"
const initialFiles = {
  "收件箱/客户清单-正式.csv": "姓名,编号\n林一,C01\n周二,C02\n",
  "收件箱/客户清单-正式-旧版.csv": "旧版保留\n",
  "收件箱/会议纪要.txt": "已确认：2026年10月30日交付。\n",
  "收件箱/会议纪要-草稿.txt": "草稿保留\n",
  "收件箱/预算明细.csv": "项目,金额\n云主机,360\n存储,120\n",
  "收件箱/.标记.txt": "隐藏文件保留\n",
  "归档/历史说明.txt": "历史文件保留\n",
}
const expectedFiles: Record<string, string> = { ...initialFiles }
delete expectedFiles["收件箱/客户清单-正式.csv"]
delete expectedFiles["收件箱/会议纪要.txt"]
expectedFiles["交付/客户清单.csv"] = initialFiles["收件箱/客户清单-正式.csv"]
expectedFiles["交付/会议纪要.txt"] = initialFiles["收件箱/会议纪要.txt"]
expectedFiles["交付/预算汇总.csv"] = initialFiles["收件箱/预算明细.csv"]
const scenarios = [
  {
    id: "form",
    goal: "在已打开的 AT-SPI Observation Fixture 表单中，把 Report title（初始 Quarterly report）改成 Release checklist，关闭 Enable sync，把 Volume 从37调到63，最后恰好点击一次 Save report，核对 Report saved 后报告完成。密码框、隐藏字段、后台窗口、重复按钮和其他控件全部保持不变。",
  },
  {
    id: "files",
    goal: `在已打开的 Thunar 中整理 ${root}。新建“交付”文件夹；将收件箱/客户清单-正式.csv移动到交付并改名客户清单.csv；将收件箱/会议纪要.txt移动到交付；复制收件箱/预算明细.csv到交付并改名预算汇总.csv，原文件保留。正式-旧版、纪要草稿、隐藏文件及其余文件原样保留。最后打开交付文件夹，核对其中恰好三个文件后报告完成。`,
  },
  {
    id: "font",
    goal: "在已打开的 Appearance 外观设置中，进入 Fonts，将 Default Font 从 DejaVu Sans Regular 10 改成 DejaVu Sans Regular 11。核对已生效，保持其他设置不变，最后留在 Appearance 的 Fonts 页面并报告完成。",
  },
].map((item) => ({
  ...item,
  goal:
    item.goal +
    "只通过当前桌面应用操作，不打开终端，不运行命令、脚本，不使用文件API、浏览器DOM或开发者工具。",
}))
type Cell = {
  id: string
  scenario: string
  arm: ObservationArm
  agentId: string
  key: string
  taskId?: string
}
type Setup = {
  database: string
  installId: string
  model: string
  ownerId: string
  cells: Cell[]
}
const admission = path.join(directory, "admission.json")
let setup: Setup
if (preparing) {
  const database = `agent_ab_${randomUUID().replaceAll("-", "")}`
  await main.query(`CREATE DATABASE "${database}"`)
  setup = {
    database,
    installId: randomUUID(),
    model: "openai/gpt-6.1-terra",
    ownerId: "",
    cells: scenarios.flatMap((scenario, i) =>
      (
        (i % 2
          ? ["native-first", "vision"]
          : ["vision", "native-first"]) as ObservationArm[]
      ).map((arm) => ({
        id: `${scenario.id}-${arm}`,
        scenario: scenario.id,
        arm,
        agentId: randomUUID(),
        key: randomUUID(),
      }))
    ),
  }
  await writeFile(admission, JSON.stringify(setup, null, 2))
} else setup = JSON.parse(await readFile(admission, "utf8"))
assert(/^agent_ab_[a-f0-9]{32}$/.test(setup.database))
const url = new URL(process.env.DATABASE_URL!)
url.pathname = "/" + setup.database
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: setup.installId,
  APP_URL: "http://127.0.0.1:17467",
  WORKER_HOST: "127.0.0.1",
  WORKER_PORT: "17468",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.5",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  PA_CONTEXT_WINDOW_TOKENS: "65536",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "atspi-ab@example.test",
  OWNER_PASSWORD: randomUUID(),
  OWNER_TIMEZONE: "Asia/Taipei",
})
const { pool } = await import("@/db")
const { docker } = await import("@/lib/docker")
const { ensureWorkstation, stopWorkstationBoundary, stopInstallationWorkstations } =
  await import("@/lib/workstation")
const { submitTask } = await import("@/lib/tasks")
const { requestCancellation } = await import("@/lib/task-control")
const { desktopToolNames } = await import("@/lib/agent/tools")
const { nativeTools } = await import("@/lib/agent/native-tools")
const jobs: { child: ReturnType<typeof spawn>; done: Promise<number | null> }[] = []
function start(script: string, name: string) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env: process.env,
    detached: true,
  })
  let log = ""
  child.stdout!.on("data", (b) => {
    log += b
  })
  child.stderr!.on("data", (b) => {
    log += b
  })
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), log)
    return child.exitCode
  })
  const job = { child, done }
  jobs.push(job)
  return job
}
let container = ""
async function guest(args: string[]) {
  const result = await docker(["exec", container, ...args], { maxOutputBytes: 8000000 })
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.toString()
}
const sessionPython = `import os,glob,subprocess,json,pathlib
env=os.environ.copy()
for f in glob.glob('/proc/[0-9]*/environ'):
 try:
  entries=pathlib.Path(f).read_bytes().split(b'\\0')
 except (FileNotFoundError,PermissionError,ProcessLookupError):
  continue
 bus=next((x.split(b'=',1)[1].decode() for x in entries if x.startswith(b'DBUS_SESSION_BUS_ADDRESS=')),None)
 if bus:
  env['DBUS_SESSION_BUS_ADDRESS']=bus
  break
assert 'DBUS_SESSION_BUS_ADDRESS' in env
env.update(NO_AT_BRIDGE='0',GTK_MODULES='atk-bridge')
`
async function truth(scenario: string) {
  return JSON.parse(
    await guest([
      "python3",
      "-c",
      sessionPython +
        `
font=subprocess.check_output(['xfconf-query','-c','xsettings','-p','/Gtk/FontName'],env=env,text=True).strip()
window=subprocess.check_output(['xdotool','getactivewindow','getwindowname'],env=env,text=True).strip()
state=dict(font=font,activeWindow=window)
${scenario === "form" ? "state['form']=json.loads(pathlib.Path('/tmp/atspi-native-truth.json').read_text())" : ""}
${scenario === "files" ? `root=pathlib.Path(${JSON.stringify(root)})\nstate['files']={str(p.relative_to(root)):p.read_bytes().decode('utf-8') for p in root.rglob('*') if p.is_file()}` : ""}
print(json.dumps(state,ensure_ascii=False))
`,
    ])
  )
}
async function prepareCase(cell: Cell) {
  await stopWorkstationBoundary(cell.agentId)
  container = (await ensureWorkstation(cell.agentId)).containerName
  if (cell.scenario === "form")
    await docker([
      "cp",
      path.resolve("tests/fixtures/atspi-native.py"),
      `${container}:/tmp/atspi-native.py`,
    ])
  await guest([
    "python3",
    "-c",
    sessionPython +
      `
subprocess.run(['xfconf-query','-c','xsettings','-p','/Gtk/FontName','-s','DejaVu Sans 10'],env=env,check=True)
${cell.scenario === "files" ? `root=pathlib.Path(${JSON.stringify(root)})\nfiles=json.loads(${JSON.stringify(JSON.stringify(initialFiles))})\nfor name,content in files.items():\n p=root/name\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_text(content)` : ""}
args=${cell.scenario === "form" ? "['python3','/tmp/atspi-native.py']" : cell.scenario === "files" ? `['thunar',${JSON.stringify(root)}]` : "['xfce4-appearance-settings']"}
subprocess.Popen(args,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
`,
  ])
  await delay(2000)
  const title =
    cell.scenario === "form"
      ? "^AT-SPI Observation Fixture$"
      : cell.scenario === "files"
        ? "ABTest - Thunar"
        : "^Appearance$"
  await guest([
    "python3",
    "-c",
    sessionPython +
      `
wid=subprocess.check_output(['xdotool','search','--name',${JSON.stringify(title)}],env=env,text=True).strip().splitlines()[-1]
subprocess.run(['xdotool','windowmove',wid,'280','70'],env=env,check=True)
subprocess.run(['xdotool','windowsize',wid,${cell.scenario === "form" ? "'620','650'" : "'720','600'"}],env=env,check=True)
subprocess.run(['xdotool','windowactivate','--sync',wid],env=env,check=True)
`,
  ])
  await delay(400)
  const state = await truth(cell.scenario)
  assert.equal(state.font, "DejaVu Sans 10")
  if (cell.scenario === "form")
    assert.deepEqual(state.form, {
      title: "Quarterly report",
      hiddenTitle: "Hidden original",
      sync: true,
      volume: 37,
      hits: { save: 0, background: 0, submit: 0 },
    })
  if (cell.scenario === "files") assert.deepEqual(state.files, initialFiles)
  const image = `/tmp/ab-${randomUUID()}.png`
  await guest(["scrot", image])
  await docker([
    "cp",
    `${container}:${image}`,
    path.join(directory, `${cell.id}-before.png`),
  ])
  return state
}
async function waitTask(id: string, terminalOnly = false) {
  const deadline = Date.now() + 25 * 60 * 1000
  let previous = ""
  while (Date.now() < deadline) {
    const task = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])
    ).rows[0]
    const n = (
      await pool.query(
        "SELECT count(*)::int n FROM task_model_attempts WHERE task_id=$1",
        [id]
      )
    ).rows[0].n
    const current = `${task.status}:${n}`
    if (previous !== current) {
      const latest = (
        await pool.query(
          "SELECT result->'calls' calls FROM task_model_decisions WHERE task_id=$1 ORDER BY decision_no DESC LIMIT 1",
          [id]
        )
      ).rows[0]
      console.log(
        JSON.stringify({
          cell: active?.id,
          taskId: id,
          status: task.status,
          requests: n,
          tools: latest?.calls?.map((c: any) => c.toolName),
        })
      )
      previous = current
    }
    if (
      (terminalOnly
        ? ["completed", "failed", "cancelled"]
        : ["completed", "failed", "cancelled", "waiting_user", "needs_review"]
      ).includes(task.status)
    )
      return task
    await delay(1000)
  }
  throw new Error(`Original Task ${id} exceeded the bounded evaluation wait`)
}
let active: Cell | undefined
let failure: string | undefined
let unknownStop = false
const results: any[] = []
const wires: any[] = []
const relayErrors: string[] = []
const upstreamBase = (
  await main.query("SELECT value FROM settings WHERE key='provider.openai.baseUrl'")
).rows[0]?.value
assert(upstreamBase, "The configured upstream endpoint is required")
const relay = createServer((req, res) => {
  void (async () => {
    assert(active?.taskId, "No admitted Task")
    assert.equal(req.url, "/v1/responses")
    let raw = ""
    for await (const chunk of req) raw += chunk
    assert(raw.length < 32000000, "Model request exceeds experiment boundary")
    const original = JSON.parse(raw)
    assert.equal(original.model, "gpt-6.1-terra")
    const previous = wires.filter((x) => x.cell === active!.id)
    assert(previous.length < 48, "The cell's 48-request admission has been consumed")
    const native = completedNativeRead(
      (
        await pool.query(
          "SELECT kind,status,receipt FROM task_actions WHERE task_id=$1 AND kind IN ('desktop_get_window_state','desktop_ax_snapshot')",
          [active.taskId]
        )
      ).rows
    )
    const body = comparisonRequest(original, active.arm, native)
    const serialized = JSON.stringify(body)
    assert(
      !serialized.includes("FIXTURE_PASSWORD_MUST_NOT_LEAK"),
      "Protected fixture value reached model boundary"
    )
    const wire = {
      cell: active.id,
      taskId: active.taskId,
      request: previous.length + 1,
      arm: active.arm,
      nativeReadCompleted: native,
      inputBytesBefore: Buffer.byteLength(raw),
      inputBytesAfter: Buffer.byteLength(serialized),
      startedAt: new Date().toISOString(),
      forwarded: false,
      httpStatus: null as number | null,
    }
    wires.push(wire)
    await writeFile(
      path.join(directory, "wire", `${active.id}-${wire.request}.json`),
      serialized
    )
    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })
    wire.forwarded = true
    const response = await fetch(
      new URL(req.url.slice("/v1/".length), upstreamBase.replace(/\/$/, "") + "/"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: String(req.headers.authorization),
        },
        body: serialized,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(175000)]),
      }
    )
    wire.httpStatus = response.status
    const bytes = Buffer.from(await response.arrayBuffer())
    await writeFile(
      path.join(directory, "wire", `${active.id}-${wire.request}-response.json`),
      bytes
    )
    res
      .writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      })
      .end(bytes)
  })().catch((error: unknown) => {
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    relayErrors.push(message)
    if (!res.headersSent && !res.destroyed)
      res
        .writeHead(502, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message } }))
  })
})
try {
  if (preparing) {
    assert.equal(await start("scripts/migrate.ts", "migrate").done, 0)
    assert.equal(await start("scripts/owner.ts", "owner").done, 0)
    const copied = (
      await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
        ["provider.openai.apiKey", "pricing.custom"],
      ])
    ).rows
    assert(copied.some((x) => x.key === "provider.openai.apiKey"))
    for (const row of [
      ...copied,
      { key: "provider.openai.baseUrl", value: "http://127.0.0.1:17469/v1" },
      { key: "model.default", value: setup.model },
      { key: "agent.maxSteps", value: "48" },
    ])
      await pool.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())", [
        row.key,
        row.value,
      ])
    setup.ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    for (const cell of setup.cells)
      await pool.query(
        "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,$2,'Isolated GUI comparison','',$3,$4,now(),now())",
        [cell.agentId, cell.id, setup.model, randomUUID()]
      )
    await writeFile(admission, JSON.stringify(setup, null, 2))
    await writeFile(
      path.join(directory, "dataset.json"),
      JSON.stringify(
        {
          model: setup.model,
          scenarios,
          initialFiles,
          expectedFiles,
          order: setup.cells.map((x) => x.id),
          maxRequestsPerCell: 48,
          contextWindow: 65536,
          repeats: 1,
          image: process.env.WORKSTATION_IMAGE,
          independentOracle:
            "GTK actual state and hit counts / exact complete file contents and paths / xfconf font and final window",
          policies:
            "No shell, file API, DOM, memory, manual, human corrections, or reruns. Initial native read gated; subsequent preference is model-directed.",
        },
        null,
        2
      )
    )
    for (const scenario of scenarios) {
      const cell = setup.cells.find((x) => x.scenario === scenario.id)!
      const state = await prepareCase(cell)
      await writeFile(
        path.join(directory, `${scenario.id}-preflight.json`),
        JSON.stringify(state, null, 2)
      )
      await stopWorkstationBoundary(cell.agentId)
    }
    console.log(JSON.stringify({ prepared: true, directory, cloudCalls: 0 }))
  } else {
    assert(
      setup.cells.every((x) => !x.taskId),
      "This admission already has Tasks; inspect the originals, do not replay the batch"
    )
    const frozen = JSON.parse(
      await readFile(path.join(directory, "dataset.json"), "utf8")
    )
    assert.deepEqual(frozen.scenarios, scenarios)
    assert.deepEqual(frozen.initialFiles, initialFiles)
    await mkdir(path.join(directory, "wire"), { recursive: true, mode: 0o700 })
    relay.listen(17469, "127.0.0.1")
    await once(relay, "listening")
    let workerStarted = false
    for (const cell of setup.cells) {
      active = cell
      const initial = await prepareCase(cell)
      assert.deepEqual(
        initial,
        JSON.parse(
          await readFile(path.join(directory, `${cell.scenario}-preflight.json`), "utf8")
        ),
        "Initial application state differs from the frozen preflight"
      )
      const settingsCommand = [
        "python3",
        "-c",
        sessionPython +
          "print(subprocess.check_output(['xfconf-query','-c','xsettings','-lv'],env=env,text=True))",
      ]
      const settingsBefore = await guest(settingsCommand)
      if (!workerStarted) {
        start("worker/main.ts", "worker")
        workerStarted = true
      }
      const began = Date.now()
      const scenario = scenarios.find((x) => x.id === cell.scenario)!
      const submitted = await submitTask(setup.ownerId, "atspi-ab-evaluation", {
        agentId: cell.agentId,
        clientRequestId: cell.key,
        goal: scenario.goal,
        workstationChannel: "desktop",
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 48 },
      })
      cell.taskId = submitted.taskId
      await writeFile(admission, JSON.stringify(setup, null, 2))
      const task = await waitTask(cell.taskId)
      const elapsedMs = Date.now() - began
      const decisions = (
        await pool.query(
          "SELECT segment_no,decision_no,result FROM task_model_decisions WHERE task_id=$1 ORDER BY segment_no,decision_no",
          [cell.taskId]
        )
      ).rows
      const actions = (
        await pool.query(
          "SELECT segment_no,action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY segment_no,action_no",
          [cell.taskId]
        )
      ).rows
      const attempts = (
        await pool.query(
          "SELECT decision_no,attempt_no,model,status,usage,cost_micros,error FROM task_model_attempts WHERE task_id=$1 ORDER BY id",
          [cell.taskId]
        )
      ).rows
      unknownStop =
        attempts.some((x) => x.status === "unknown") ||
        actions.some((x) => x.status === "unknown")
      const state = await truth(cell.scenario)
      const settingsAfter = await guest(settingsCommand)
      const unchangedSettings = (value: string) =>
        value
          .split("\n")
          .filter((line) => !line.startsWith("/Gtk/FontName "))
          .sort()
      let oracle: Record<string, boolean>
      if (cell.scenario === "form")
        oracle = {
          title: state.form.title === "Release checklist",
          sync: state.form.sync === false,
          volume: state.form.volume === 63,
          savedExactlyOnce: state.form.hits.save === 1,
          protectedAndUnrelated:
            state.form.hiddenTitle === "Hidden original" &&
            state.form.hits.background === 0 &&
            state.form.hits.submit === 0,
          otherSettings: state.font === "DejaVu Sans 10",
        }
      else if (cell.scenario === "files")
        oracle = {
          exactFiles:
            JSON.stringify(Object.entries(state.files).sort()) ===
            JSON.stringify(Object.entries(expectedFiles).sort()),
          finalWindow:
            state.activeWindow.includes("交付") && state.activeWindow.includes("Thunar"),
          otherSettings: state.font === "DejaVu Sans 10",
        }
      else
        oracle = {
          font: state.font === "DejaVu Sans 11",
          finalWindow: state.activeWindow === "Appearance",
          fontsPage:
            actions
              .findLast((a) => a.receipt?.output?.elements)
              ?.receipt.output.elements.some(
                (node: any) =>
                  node.role === "page tab" &&
                  node.name === "Fonts" &&
                  node.states.includes("selected")
              ) === true,
        }
      oracle.otherXSettingsUnchanged =
        JSON.stringify(unchangedSettings(settingsBefore)) ===
        JSON.stringify(unchangedSettings(settingsAfter))
      const calls = decisions.flatMap((d) => d.result?.calls ?? [])
      const histogram = Object.fromEntries(
        [...new Set(calls.map((c) => c.toolName))].map((name) => [
          name,
          calls.filter((c) => c.toolName === name).length,
        ])
      )
      const nativeActions = actions.filter((a) =>
        ["desktop_element_action", "desktop_ax_action"].includes(a.kind)
      )
      const guiOnly = calls.every((c) => desktopToolNames.has(c.toolName))
      const result = {
        id: cell.id,
        taskId: cell.taskId,
        arm: cell.arm,
        scenario: cell.scenario,
        taskStatus: task.status,
        passed:
          Object.values(oracle).every(Boolean) &&
          guiOnly &&
          !unknownStop &&
          task.status === "completed",
        oracle,
        guiOnly,
        elapsedMs,
        state,
        settingsBefore,
        settingsAfter,
        histogram,
        actionCount: actions.length,
        nativeActionAttempts: nativeActions.length,
        nativeDispatched: nativeActions.filter(
          (a) =>
            a.status === "succeeded" &&
            a.receipt?.output?.effect &&
            a.receipt.output.effect !== "none"
        ).length,
        nativeReceipts: nativeActions.map((a) => ({
          kind: a.kind,
          input: a.input,
          status: a.status,
          effect: a.receipt?.output?.effect,
          verification: a.receipt?.output?.verification,
          error: a.receipt?.error,
          background_unavailable: a.receipt?.output?.background_unavailable,
        })),
        nativeToolCalls: calls.filter((c) => Object.hasOwn(nativeTools, c.toolName))
          .length,
        fallbacks: decisions.flatMap((d) =>
          (d.result?.text ?? "")
            .split("\n")
            .filter((s: string) => s.includes("FALLBACK:"))
        ),
        summaryCalls: decisions.filter((d) => d.decision_no < 0).length,
        requests: attempts.length,
        usage: attempts.reduce(
          (sum, a) => ({
            input: sum.input + (a.usage?.input ?? 0),
            output: sum.output + (a.usage?.output ?? 0),
            cached: sum.cached + (a.usage?.cached ?? 0),
          }),
          { input: 0, output: 0, cached: 0 }
        ),
        unknownAttempts: attempts.filter((a) => a.status === "unknown").length,
        unpricedAttempts: attempts.filter((a) => a.cost_micros === null).length,
        summary: task.result?.summary,
        error: task.error,
        attempts,
      }
      results.push(result)
      await writeFile(
        path.join(directory, `${cell.id}.json`),
        JSON.stringify(result, null, 2)
      )
      await writeFile(
        path.join(directory, `${cell.id}-trace.json`),
        JSON.stringify({ decisions, actions }, null, 2)
      )
      await mkdir(path.join(directory, cell.id + "-frames"), { recursive: true })
      for (const action of actions)
        if (action.receipt?.output?.image)
          await writeFile(
            path.join(
              directory,
              cell.id + "-frames",
              `${action.action_no}-${action.kind}.jpg`
            ),
            Buffer.from(action.receipt.output.image, "base64")
          )
      const last = actions.findLast((a) => a.receipt?.output?.image)
      if (last)
        await writeFile(
          path.join(directory, cell.id + "-last-observation.jpg"),
          Buffer.from(last.receipt.output.image, "base64")
        )
      console.log(
        JSON.stringify({
          cell: cell.id,
          passed: result.passed,
          oracle,
          requests: attempts.length,
          histogram,
        })
      )
      if (unknownStop) break
      if (!["completed", "failed", "cancelled"].includes(task.status)) {
        await requestCancellation(setup.ownerId, cell.taskId)
        await waitTask(cell.taskId, true)
      }
      await stopWorkstationBoundary(cell.agentId)
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error)
  console.error(failure)
  process.exitCode = 1
} finally {
  for (const j of jobs)
    if (j.child.exitCode === null && j.child.signalCode === null) j.child.kill("SIGTERM")
  await Promise.race([Promise.all(jobs.map((j) => j.done)), delay(15000)])
  for (const j of jobs)
    if (j.child.exitCode === null && j.child.signalCode === null)
      process.kill(-j.child.pid!, "SIGKILL")
  await Promise.all(jobs.map((j) => j.done))
  if (relay.listening)
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve()))
    )
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const attempts = (
    await pool.query(
      "SELECT task_id,decision_no,attempt_no,model,status,usage,cost_micros,error FROM task_model_attempts ORDER BY id"
    )
  ).rows
  const mainAfter = await mainCounts()
  const mainUnchanged =
    JSON.stringify(mainBefore) === JSON.stringify(mainAfter) &&
    originalEnv.equals(await readFile(".env"))
  await writeFile(
    path.join(directory, preparing ? "preparation.json" : "result.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        directory,
        database: setup.database,
        model: setup.model,
        stage: preparing ? "prepare" : "run",
        results,
        attempts,
        wires,
        relayErrors,
        unknownStop,
        failure,
        mainBefore,
        mainAfter,
        mainUnchanged,
        knownCostMicros: attempts.reduce(
          (sum, a) => sum + (a.cost_micros === null ? 0 : Number(a.cost_micros)),
          0
        ),
        unpricedAttempts: attempts.filter((a) => a.cost_micros === null).length,
      },
      null,
      2
    )
  )
  await pool.end()
  await main.end()
  assert(mainUnchanged, "Main installation changed during isolated evaluation")
  console.log(
    JSON.stringify({
      directory,
      preparing,
      completedCells: results.length,
      passed: results.filter((x) => x.passed).length,
      unknownStop,
      failure,
      mainUnchanged,
    })
  )
}
