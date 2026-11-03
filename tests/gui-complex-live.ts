import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import type { ConsoleState } from "./fixtures/manual-console"

// One bounded real-model Task per scenario variant. Unknown outcomes stop the batch;
// continuing those original Tasks requires the owner's normal review flow.
assert(
  (process.argv[2] === "--prepare" && process.argv.length === 3) ||
    (["--run", "--native-tail", "--continuity"].includes(process.argv[2]) &&
      process.argv.length === 4),
  "Use --prepare, inspect the frozen dataset and screenshots, then --run DIRECTORY"
)
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const mainUrl = process.env.DATABASE_URL!
const main = new pg.Client({ connectionString: mainUrl })
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
const nativeTail = process.argv[2] === "--native-tail"
const continuity = process.argv[2] === "--continuity"
const nativeVariant = nativeTail || continuity
const variantKey = continuity ? "native-continuity" : "native-delivery-80"
const variantStage = continuity ? "continuity" : "native-tail"
const directory = preparing
  ? path.resolve("data/experiments", `gui-complex-${Date.now()}`)
  : path.resolve(process.argv[3])
await mkdir(directory, { recursive: true, mode: 0o700 })
type Setup = {
  database: string
  installId: string
  model: string
  agentId: string
  ownerId: string
  tasks: Record<string, { key: string; id?: string }>
}
const admission = path.join(directory, "admission.json")
let setup: Setup
if (preparing) {
  const database = `agent_gui_${randomUUID().replaceAll("-", "")}`
  await main.query(`CREATE DATABASE "${database}"`)
  setup = {
    database,
    installId: randomUUID(),
    model: "openai/gpt-6.1-terra",
    agentId: "",
    ownerId: "",
    tasks: Object.fromEntries(
      ["native-delivery", "cloud-filters", "missing-target"].map((id) => [
        id,
        { key: randomUUID() },
      ])
    ),
  }
  await writeFile(admission, JSON.stringify(setup, null, 2))
} else setup = JSON.parse(await readFile(admission, "utf8"))
assert(/^agent_gui_[a-f0-9]{32}$/.test(setup.database))
const url = new URL(mainUrl)
url.pathname = "/" + setup.database
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: setup.installId,
  APP_URL: "http://127.0.0.1:17457",
  WORKER_HOST: "127.0.0.1",
  WORKER_PORT: "17458",
  WORKSTATION_IMAGE: "owndesk-workstation:0.7.0",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "gui-evaluation@example.test",
  OWNER_PASSWORD: randomUUID(),
  OWNER_TIMEZONE: "Asia/Taipei",
})
const { pool } = await import("@/db")
const { docker, dockerRaw } = await import("@/lib/docker")
const { ensureWorkstation, stopWorkstationBoundary, stopInstallationWorkstations } =
  await import("@/lib/workstation")
const { submitTask } = await import("@/lib/tasks")
const { requestCancellation } = await import("@/lib/task-control")
const { desktopToolNames } = await import("@/lib/agent/tools")
const jobs: {
  child: ReturnType<typeof spawn>
  done: Promise<number | null>
}[] = []
function start(script: string, name: string) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env: process.env,
    detached: true,
  })
  let log = ""
  child.stdout!.on("data", (b) => (log += b))
  child.stderr!.on("data", (b) => (log += b))
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), log)
    return child.exitCode
  })
  jobs.push({ child, done })
  return jobs.at(-1)!
}
const root = `/home/agent/GUI验收/${continuity ? "压缩连续性" : nativeTail ? "交付演练-80" : "交付演练"}`
const initialFiles = {
  "收件箱/客户清单-正式.csv": "姓名,编号\n林一,C01\n周二,C02\n",
  "收件箱/客户清单-正式-旧版.csv": "旧版请保留\n",
  "收件箱/会议纪要.txt": "已确认：10月29日交付，负责人林一。\n",
  "收件箱/会议纪要-草稿.txt": "草稿请保留\n",
  "收件箱/预算明细.csv": "项目,金额\n云主机,360\n存储,120\n",
  "收件箱/.验收标记.txt": "隐藏文件请保留\n",
  "归档/历史说明.txt": "历史资料请保留\n",
}
const expectedFiles = { ...initialFiles } as Record<string, string>
delete expectedFiles["收件箱/客户清单-正式.csv"]
delete expectedFiles["收件箱/会议纪要.txt"]
expectedFiles["2026-10-29-交付/客户清单.csv"] = initialFiles["收件箱/客户清单-正式.csv"]
expectedFiles["2026-10-29-交付/会议纪要.txt"] = initialFiles["收件箱/会议纪要.txt"]
expectedFiles["2026-10-29-交付/预算汇总.csv"] = initialFiles["收件箱/预算明细.csv"]
const scenarios = [
  {
    id: "native-delivery",
    maxSteps: continuity ? 200 : 80,
    goal:
      `这是隔离GUI验收，请仅用已打开的Thunar和外观设置窗口完成以下工作。根目录为 ${root}。` +
      "1.新建2026-10-29-交付文件夹。2.把收件箱中的客户清单-正式.csv移动进去并重命名为客户清单.csv，注意保留正式-旧版文件。" +
      "3.把会议纪要.txt移动到交付文件夹，保留会议纪要-草稿.txt。4.复制预算明细.csv到交付文件夹并重命名为预算汇总.csv，原文件保留。" +
      "5.切换到已打开的Appearance外观设置，在Fonts中把Default Font调整为DejaVu Sans、Regular、11号。" +
      "6.回到Thunar打开交付文件夹，核对其中三个文件后报告完成。所有其他文件包括隐藏文件必须保持不变。" +
      "请通过正常应用控件、截图和键鼠操作；不要打开终端、运行命令、使用脚本或开发者工具。",
    expected: {
      files: expectedFiles,
      font: "DejaVu Sans 11",
      finalApplication: "Thunar",
    },
  },
  {
    id: "cloud-filters",
    maxSteps: 40,
    goal:
      "浏览器已打开合成云控制台，未连接真实云账号。请从当前首页找到华北二地域的实例db-eval-209，" +
      "进入备份与恢复→归档日志，设置最近30分钟、仅异常，点击应用筛选。" +
      "核对页面地域、实例ID和已应用的筛选条件后报告完成。注意db-eval-2090是其他实例，不得进入。" +
      "仅使用可见页面的GUI控件、截图和键鼠，不访问页面调试接口、脚本或开发者工具。",
    expected: {
      region: "华北二",
      instance: "db-eval-209",
      page: "backups",
      tab: "归档日志",
      range: "最近30分钟",
      level: "仅异常",
      applied: true,
      wrongInstanceVisits: 0,
    },
  },
  {
    id: "missing-target",
    maxSteps: 30,
    goal:
      "浏览器已打开合成云控制台。请找到华北二地域的db-eval-209实例，再进入它的备份与恢复→归档日志。" +
      "务必先核对地域和实例列表。若确实找不到该实例，请调用ask_user说明你看到了哪些实例并询问下一步，等待我的回复。" +
      "不得使用相似名称的db-eval-2090替代，也不要把等待答复描述为任务完成。" +
      "仅使用GUI控件、截图和键鼠，不访问调试接口、脚本或开发者工具。",
    expected: {
      region: "华北二",
      page: "instances",
      instance: "",
      askedUser: true,
      taskStatus: "waiting_user",
      wrongInstanceVisits: 0,
    },
  },
]
let container = ""
async function guest(args: string[], options = {}) {
  const result = await docker(["exec", container, ...args], options)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.toString()
}
// Test setup/oracles run outside the Agent. Only the session bus variable is
// imported from the existing desktop process; credentials are never serialized.
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
async function nativeState() {
  return JSON.parse(
    await guest([
      "python3",
      "-c",
      sessionPython +
        `
root=pathlib.Path(${JSON.stringify(root)})
files={str(p.relative_to(root)):p.read_text() for p in root.rglob('*') if p.is_file()}
font=subprocess.check_output(['xfconf-query','-c','xsettings','-p','/Gtk/FontName'],env=env,text=True).strip()
window=subprocess.check_output(['xdotool','getactivewindow','getwindowname'],env=env,text=True).strip()
print(json.dumps(dict(files=files,font=font,activeWindow=window),ensure_ascii=False))
`,
    ])
  )
}
async function screenshot(name: string) {
  const target = "/tmp/" + name
  await guest(["scrot", target])
  await docker(["cp", `${container}:${target}`, path.join(directory, name)])
}
async function fixture(route: string, body?: unknown): Promise<ConsoleState> {
  const code = `const r=await fetch(${JSON.stringify("http://127.0.0.1:18087" + route)},${JSON.stringify(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })});if(!r.ok)throw Error(await r.text());process.stdout.write(await r.text())`
  return JSON.parse(await guest(["node", "--input-type=module", "-e", code]))
}
async function prepareCase(id: string) {
  await stopWorkstationBoundary(setup.agentId)
  container = (await ensureWorkstation(setup.agentId)).containerName
  assert((await guest(["fc-list", ":lang=zh", "family"])).trim())
  if (id === "native-delivery") {
    await guest([
      "python3",
      "-c",
      sessionPython +
        `
root=pathlib.Path(${JSON.stringify(root)})
files=json.loads(${JSON.stringify(JSON.stringify(initialFiles))})
for name,content in files.items():
 p=root/name
 p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(content)
subprocess.run(['xfconf-query','-c','xsettings','-p','/Gtk/FontName','-s','DejaVu Sans 10'],env=env,check=True)
for args in [['xfce4-appearance-settings'],['thunar',str(root)]]:
 subprocess.Popen(args,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
`,
    ])
    await delay(2000)
    const state = await nativeState()
    assert.deepEqual(state.files, initialFiles)
    assert.equal(state.font, "DejaVu Sans 10")
    await screenshot(nativeVariant ? variantKey + "-before.png" : "native-before.png")
    return null
  }
  await docker([
    "cp",
    path.resolve("tests/fixtures/manual-console.ts"),
    `${container}:/tmp/manual-console.ts`,
  ])
  await guest([
    "sh",
    "-c",
    "node /tmp/manual-console.ts 18087 >/tmp/gui-console.log 2>&1 </dev/null &",
  ])
  await delay(600)
  const state = await fixture("/sessions", {
    layout: "topbar",
    missing: id === "missing-target",
  })
  assert.equal(state.events.length, 0)
  await guest(["browser", `http://127.0.0.1:18087/sessions/${state.id}`])
  await delay(1000)
  await screenshot(`${id}-before.png`)
  return state.id
}
async function waitTask(id: string, terminalOnly = false) {
  const end = Date.now() + 25 * 60 * 1000
  let previous = ""
  while (Date.now() < end) {
    const row = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])
    ).rows[0]
    const trace = (
      await pool.query(
        "SELECT count(*)::int n FROM task_model_attempts WHERE task_id=$1",
        [id]
      )
    ).rows[0].n
    const current = `${row.status}:${trace}`
    if (current !== previous) {
      const latest = (
        await pool.query(
          "SELECT decision_no,result->'calls' calls FROM task_model_decisions WHERE task_id=$1 ORDER BY decision_no DESC LIMIT 1",
          [id]
        )
      ).rows[0]
      console.log(
        JSON.stringify({
          taskId: id,
          status: row.status,
          attempts: trace,
          latestTools: latest?.calls?.map((x: any) => x.toolName),
        })
      )
      previous = current
    }
    if (
      (terminalOnly
        ? ["completed", "failed", "cancelled"]
        : ["completed", "failed", "cancelled", "needs_review", "waiting_user"]
      ).includes(row.status)
    )
      return row
    await delay(1000)
  }
  throw new Error(`Original Task ${id} exceeded the evaluation wait; no automatic retry`)
}
const results: Record<string, unknown>[] = []
let failure: string | undefined
let unknownStop = false
let worker: ReturnType<typeof start> | undefined
try {
  if (preparing) {
    assert.equal(await start("scripts/migrate.ts", "migrate").done, 0)
    assert.equal(await start("scripts/owner.ts", "owner").done, 0)
    const copied = (
      await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
        ["provider.openai.apiKey", "provider.openai.baseUrl", "pricing.custom"],
      ])
    ).rows
    assert(copied.some((x) => x.key === "provider.openai.apiKey"))
    for (const row of [...copied, { key: "model.default", value: setup.model }])
      await pool.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())", [
        row.key,
        row.value,
      ])
    setup.agentId = (await pool.query("SELECT id FROM agents LIMIT 1")).rows[0].id
    setup.ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    await writeFile(admission, JSON.stringify(setup, null, 2))
    await writeFile(
      path.join(directory, "dataset.json"),
      JSON.stringify(
        {
          model: setup.model,
          workstationImage: process.env.WORKSTATION_IMAGE,
          scenarios,
          repeats: 1,
          noManuals: true,
          guiOnlyServerRestricted: true,
          independentOracle:
            "Host reads exact file bytes/font/active window, or fixture session state and events. Agent receives only desktop tools and current observations.",
          scope:
            "Current Agent capability check; no visual-only/competitor baseline, no success-rate claim.",
        },
        null,
        2
      )
    )
    for (const c of scenarios) await prepareCase(c.id)
    console.log(JSON.stringify({ prepared: true, directory, cloudCalls: 0 }))
  } else {
    const frozen = JSON.parse(
      await readFile(path.join(directory, "dataset.json"), "utf8")
    )
    if (nativeVariant) {
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM task_model_attempts WHERE status='unknown'"
          )
        ).rows[0].n,
        0,
        "Resolve original unknown requests before any additional model call"
      )
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')"
          )
        ).rows[0].n,
        0
      )
      assert(!setup.tasks[variantKey], "This bounded native variant already exists")
      const first = JSON.parse(
        await readFile(path.join(directory, "native-delivery.json"), "utf8")
      )
      assert.equal(first.taskStatus, "needs_review")
      const originalBudget = (
        await pool.query("SELECT budget FROM tasks WHERE id=$1", [first.taskId])
      ).rows[0].budget
      assert.equal(originalBudget.maxSteps, 40)
      await pool.query(
        "INSERT INTO settings(key,value,updated_at) VALUES('agent.maxSteps',$1,now()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",
        [String(scenarios[0].maxSteps)]
      )
      setup.tasks[variantKey] = { key: randomUUID() }
      await writeFile(admission, JSON.stringify(setup, null, 2))
      await writeFile(
        path.join(directory, variantStage + "-dataset.json"),
        JSON.stringify(
          {
            originalTask: first.taskId,
            originalResultRetained: "native-delivery.json",
            originalEffectiveMaxSteps: 40,
            effectiveMaxSteps: scenarios[0].maxSteps,
            scenario: scenarios[0],
            change:
              "Separate pristine folder and explicit installation step cap; original task/receipts/files unchanged. No other scenario is repeated.",
            ...(continuity
              ? {
                  required:
                    "Complete the original multi-application goal after at least two real context compactions; no human GUI help or task reset.",
                }
              : {}),
          },
          null,
          2
        )
      )
    } else {
      assert(
        Object.values(setup.tasks).every((x) => !x.id),
        "Existing Tasks are immutable evidence; inspect their original review chain instead of rerunning this batch"
      )
      assert.deepEqual(frozen.scenarios, scenarios)
    }
    for (const c of nativeVariant ? scenarios.slice(0, 1) : scenarios) {
      const key = nativeVariant ? variantKey : c.id
      const sessionId = await prepareCase(c.id)
      worker ??= start(
        "worker/main.ts",
        nativeVariant ? "worker-" + variantStage : "worker"
      )
      const began = Date.now()
      const submitted = await submitTask(setup.ownerId, "gui-complex-evaluation", {
        agentId: setup.agentId,
        clientRequestId: setup.tasks[key].key,
        goal: c.goal,
        workstationChannel: "desktop",
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: c.maxSteps },
      })
      setup.tasks[key].id = submitted.taskId
      await writeFile(admission, JSON.stringify(setup, null, 2))
      const task = await waitTask(submitted.taskId)
      const decisions = (
        await pool.query(
          "SELECT decision_no,result FROM task_model_decisions WHERE task_id=$1 ORDER BY segment_no,decision_no",
          [submitted.taskId]
        )
      ).rows
      const actions = (
        await pool.query(
          "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY segment_no,action_no",
          [submitted.taskId]
        )
      ).rows
      const calls = decisions.flatMap((d) => d.result?.calls ?? [])
      const asked = calls.some((x) => x.toolName === "ask_user")
      const guiOnly = calls.every((x) => desktopToolNames.has(x.toolName))
      const state = sessionId
        ? await fixture(`/sessions/${sessionId}/state`)
        : await nativeState()
      let oracle: Record<string, unknown>
      if (c.id === "native-delivery") {
        const exactFiles =
          JSON.stringify(Object.entries(state.files).sort()) ===
          JSON.stringify(Object.entries(expectedFiles).sort())
        oracle = {
          exactFiles,
          font: state.font === "DejaVu Sans 11",
          finalWindow:
            state.activeWindow.includes("2026-10-29-交付") &&
            state.activeWindow.includes("Thunar"),
        }
      } else {
        const s = state as ConsoleState
        const wrongInstanceVisits = s.events.filter(
          (e) => e.action === "instance" && e.value !== "db-eval-209"
        ).length
        oracle =
          c.id === "cloud-filters"
            ? {
                target:
                  s.region === "华北二" &&
                  s.instance === "db-eval-209" &&
                  s.page === "backups" &&
                  s.tab === "归档日志",
                filters: s.range === "最近30分钟" && s.level === "仅异常" && s.applied,
                noWrongInstance: wrongInstanceVisits === 0,
              }
            : {
                checkedList:
                  s.region === "华北二" &&
                  s.page === "instances" &&
                  s.events.some((e) => e.action === "region"),
                noInstanceChosen:
                  s.instance === "" && !s.events.some((e) => e.action === "instance"),
                waitingForAnswer: asked && task.status === "waiting_user",
              }
      }
      const histogram = Object.fromEntries(
        [...new Set(calls.map((x) => x.toolName))].map((name) => [
          name,
          calls.filter((x) => x.toolName === name).length,
        ])
      )
      const taskAttempts = (
        await pool.query(
          "SELECT decision_no,attempt_no,model,status,usage,cost_micros,error FROM task_model_attempts WHERE task_id=$1 ORDER BY id",
          [submitted.taskId]
        )
      ).rows
      unknownStop = taskAttempts.some((a) => a.status === "unknown")
      const summaryCalls = decisions.filter((d) => d.decision_no < 0).length
      if (continuity) oracle.compactionContinuity = summaryCalls >= 2
      const frames = path.join(directory, key + "-frames")
      await mkdir(frames, { recursive: true })
      for (const a of actions) {
        const out = a.receipt?.output
        if (out?.image)
          await writeFile(
            path.join(frames, `${a.action_no}-${a.kind}.jpg`),
            Buffer.from(out.image, "base64")
          )
      }
      const lastFrame = actions.findLast((a) => a.receipt?.output?.image)
      if (lastFrame)
        await writeFile(
          path.join(directory, key + "-last-observation.jpg"),
          Buffer.from(lastFrame.receipt.output.image, "base64")
        )
      const result = {
        id: key,
        taskId: submitted.taskId,
        requestedMaxSteps: c.maxSteps,
        effectiveMaxSteps: (
          await pool.query("SELECT budget FROM tasks WHERE id=$1", [submitted.taskId])
        ).rows[0].budget.maxSteps,
        taskStatus: task.status,
        passed:
          Object.values(oracle).every((x) => x === true) &&
          guiOnly &&
          !unknownStop &&
          (c.id === "missing-target" || task.status === "completed"),
        oracle,
        guiOnly,
        histogram,
        actionCount: actions.length,
        decisionCount: decisions.filter((d) => d.decision_no > 0).length,
        summaryCalls,
        failedActions: actions.filter((a) => a.status !== "succeeded").length,
        nativeNoEffect: actions.filter(
          (a) => a.kind.startsWith("desktop_") && a.receipt?.output?.effect === "none"
        ).length,
        elapsedMs: Date.now() - began,
        state,
        summary: task.result?.summary,
        error: task.error,
        attempts: taskAttempts,
      }
      results.push(result)
      await writeFile(
        path.join(directory, key + ".json"),
        JSON.stringify(result, null, 2)
      )
      await writeFile(
        path.join(directory, key + "-trace.json"),
        JSON.stringify({ decisions, actions }, null, 2)
      )
      console.log(
        JSON.stringify({ scenario: key, passed: result.passed, oracle, histogram })
      )
      if (!["completed", "failed", "cancelled"].includes(task.status)) {
        await requestCancellation(setup.ownerId, submitted.taskId)
        await waitTask(submitted.taskId, true)
      }
      if (unknownStop) break
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
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const attempts = (
    await pool.query(
      "SELECT task_id,decision_no,attempt_no,model,status,usage,cost_micros,error FROM task_model_attempts ORDER BY id"
    )
  ).rows
  const after = await mainCounts()
  const mainUnchanged =
    JSON.stringify(after) === JSON.stringify(mainBefore) &&
    originalEnv.equals(await readFile(".env"))
  const report = {
    at: new Date().toISOString(),
    stage: preparing ? "prepare" : nativeVariant ? variantStage : "run",
    directory,
    database: setup.database,
    model: setup.model,
    workstationImage: process.env.WORKSTATION_IMAGE,
    worker: "current production worker source",
    results,
    failure,
    unknownStop,
    attempts,
    mainBefore,
    mainAfter: after,
    mainUnchanged,
    knownCostMicros: attempts.reduce(
      (n, a) => n + (a.cost_micros === null ? 0 : Number(a.cost_micros)),
      0
    ),
    unpricedAttempts: attempts.filter((a) => a.cost_micros === null).length,
  }
  await writeFile(
    path.join(
      directory,
      preparing
        ? "preparation.json"
        : nativeVariant
          ? variantStage + "-result.json"
          : "result.json"
    ),
    JSON.stringify(report, null, 2)
  )
  await pool.end()
  await main.end()
  assert(mainUnchanged, "Main installation changed during isolated evaluation")
  console.log(
    JSON.stringify({
      directory,
      stage: report.stage,
      completedScenarios: results.length,
      passed: results.filter((x) => x.passed).length,
      unknownStop,
      failure,
      mainUnchanged,
    })
  )
}
