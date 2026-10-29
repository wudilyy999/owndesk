import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseEnv } from "node:util"
import { request, type APIRequestContext, type APIResponse } from "playwright"
import { DockerError } from "@/lib/docker"
import { innerDocker, linuxHost, loadImages, stopLinuxHost } from "./helpers/linux-host"

assert(process.env.PA_LINUX_HOST_STATE, "Specify the dedicated retained Linux test host")
const stage = process.argv[2] ?? "baseline"
assert(["baseline", "idle"].includes(stage), "Use tests/capacity.ts baseline|idle")
const rounds = stage === "idle" ? 9 : 8
assert(process.env.PA_CAPACITY_IMAGES_CONFIG, "Specify a local pinned-image config")
const host = await linuxHost()
assert.equal(
  host.kind,
  "colima",
  "Capacity checks currently use the retained dedicated Linux VM"
)
const configFile = path.join(host.directory, "deployment", ".env")
const imageFile = path.resolve(process.env.PA_CAPACITY_IMAGES_CONFIG)
assert(imageFile.startsWith(path.resolve(host.directory, "../") + path.sep))
const images = parseEnv(await readFile(imageFile, "utf8")) as Record<string, string>
const fixtureKey = randomUUID()
const fixtureNames: string[] = []
const samples: Record<string, unknown>[] = []
const outcomes: Record<string, unknown>[] = []
const checks: Record<string, unknown>[] = []
let cfg!: Record<string, string>
let agent = ""
let passed = false
let client: APIRequestContext | undefined
const publicNetwork = `${host.name}-restore-public`
const fixturePrefix = `${host.name}-capacity-${path.basename(host.directory)}`
const started = Date.now()

async function compose(args: string[], env: Record<string, string> = {}) {
  return innerDocker(
    host,
    [
      "compose",
      "--file",
      path.resolve("deploy/compose.yaml"),
      "--env-file",
      configFile,
      "--project-name",
      `pa-${cfg.INSTALL_ID}`,
      ...args,
    ],
    { env: { ...cfg, ...env }, timeoutMs: 180000 }
  )
}
async function code(source: string, env: Record<string, string> = {}) {
  const result = await compose(
    [
      "run",
      "--rm",
      "--no-deps",
      ...Object.keys(env).flatMap((key) => ["--env", key]),
      "--entrypoint",
      "node",
      "worker",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      source,
    ],
    env
  )
  const lines = result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("PA_RESULT="))
  assert.equal(lines.length, 1)
  return JSON.parse(lines[0].slice(10))
}
async function query(sql: string) {
  const pg = (await compose(["ps", "-q", "postgres"])).stdout.toString().trim()
  return (
    await innerDocker(host, [
      "exec",
      pg,
      "psql",
      "-X",
      "--set",
      "ON_ERROR_STOP=1",
      "-At",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "-c",
      sql,
    ])
  ).stdout
    .toString()
    .trim()
}
async function until<T>(
  fn: () => Promise<T | false>,
  label: string,
  timeoutMs = 90000
): Promise<T> {
  const end = Date.now() + timeoutMs
  while (true) {
    const value = await fn()
    if (value) return value
    assert(Date.now() < end, `Timed out: ${label}`)
    await delay(250)
  }
}
async function fixture(
  name: string,
  network: string,
  file: string,
  args: string[],
  environment: Record<string, string>
) {
  const full = `${fixturePrefix}-${name}`
  await innerDocker(
    host,
    [
      "create",
      "--name",
      full,
      "--network",
      network,
      ...args,
      "--entrypoint",
      "node",
      cfg.PA_WORKER_IMAGE,
      `/tmp/${file}`,
    ],
    { env: environment }
  )
  fixtureNames.push(full)
  await innerDocker(host, ["cp", `tests/fixtures/${file}`, `${full}:/tmp/${file}`])
  await innerDocker(host, ["start", full])
}
async function sample(label: string, taskId?: string) {
  const names = (await innerDocker(host, ["ps", "--format", "{{.Names}}"])).stdout
    .toString()
    .trim()
    .split("\n")
    .filter(
      (name) =>
        name.startsWith(`pa-${cfg.INSTALL_ID}`) ||
        name.startsWith(`pa-${cfg.INSTALL_ID.slice(0, 8)}-`)
    )
  const stats = (
    await innerDocker(host, ["stats", "--no-stream", "--format", "{{json .}}", ...names])
  ).stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const db = JSON.parse(
    await query(
      "SELECT json_build_object('databaseBytes',pg_database_size(current_database()),'tasks',(SELECT count(*) FROM tasks),'actions',(SELECT count(*) FROM task_action_attempts),'models',(SELECT count(*) FROM task_model_attempts),'events',(SELECT count(*) FROM task_events),'relations',(SELECT json_agg(json_build_object('schema',schemaname,'table',relname,'bytes',pg_total_relation_size(relid))) FROM pg_stat_user_tables))"
    )
  )
  const disks: Record<string, number> = {}
  for (const [name, volume] of [
    ["artifacts", `pa-${cfg.INSTALL_ID}_artifacts`],
    ...(agent ? [["home", `pa-${cfg.INSTALL_ID.slice(0, 8)}-home-${agent}`]] : []),
  ]) {
    const used = (
      await innerDocker(host, [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/data,readonly`,
        "--entrypoint",
        "du",
        cfg.PA_WORKER_IMAGE,
        "-sk",
        "/data",
      ])
    ).stdout.toString()
    disks[name] = Number(used.split(/\s/)[0]) * 1024
  }
  const entry = {
    label,
    elapsedMs: Date.now() - started,
    taskStatus: taskId
      ? await query(`SELECT status FROM tasks WHERE id='${taskId}'`)
      : null,
    stats,
    db,
    allocatedVolumeBytes: disks,
  }
  samples.push(entry)
  await writeFile(
    path.join(host.directory, "resource-samples.json"),
    JSON.stringify(samples, null, 2) + "\n"
  )
  return entry
}

try {
  assert.equal(
    (await innerDocker(host, ["ps", "-q"])).stdout.toString().trim(),
    "",
    "Only run while all retained installations are offline"
  )
  execFileSync(
    process.execPath,
    [
      "scripts/deploy-env.mjs",
      `https://localhost:${host.httpsPort}`,
      "capacity@fixture.test",
      path.dirname(configFile),
    ],
    { stdio: "pipe" }
  )
  cfg = parseEnv(await readFile(configFile, "utf8")) as Record<string, string>
  for (const key of [
    "PA_WORKER_IMAGE",
    "PA_WEB_IMAGE",
    "PA_WORKSTATION_IMAGE",
    "PA_POSTGRES_IMAGE",
    "PA_CADDY_IMAGE",
  ]) {
    assert(images[key])
    cfg[key] = images[key]
  }
  Object.assign(cfg, {
    PA_HTTP_PORT: host.httpPort,
    WORKSTATION_CPUS: "1",
    WORKSTATION_MEMORY_MB: "1536",
    WORKSTATION_IDLE_MINUTES: stage === "idle" ? "1" : "15",
  })
  const networkNames = (
    await innerDocker(host, ["network", "ls", "--format", "{{.Name}}"])
  ).stdout
    .toString()
    .trim()
    .split("\n")
  const networks = JSON.parse(
    (await innerDocker(host, ["network", "inspect", ...networkNames])).stdout.toString()
  )
  const occupied = networks.flatMap(
    (network: { IPAM: { Config: { Subnet: string }[] | null } }) =>
      (network.IPAM.Config ?? []).map((entry) => entry.Subnet)
  )
  const subnet = Array.from({ length: 55 }, (_, n) => `172.30.${200 + n}.0/24`).find(
    (candidate) => !occupied.includes(candidate)
  )
  assert(subnet, "No unused test guest subnet remains")
  cfg.PA_GUEST_SUBNET = subnet
  await loadImages(host, [cfg.PA_WORKER_IMAGE])
  await writeFile(
    configFile,
    Object.entries(cfg)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  const existing = JSON.parse(
    (await innerDocker(host, ["network", "inspect", publicNetwork])).stdout.toString()
  )[0]
  assert.equal(Object.keys(existing.Containers).length, 0)
  await innerDocker(
    host,
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--volume",
      "/var/run/docker.sock:/var/run/docker.sock",
      ...[
        "INSTALL_ID",
        "APP_URL",
        "WORKSTATION_NETWORK",
        "PA_GUEST_SUBNET",
        "PA_CONTROL_IPS",
      ].flatMap((name) => ["--env", name]),
      cfg.PA_WORKER_IMAGE,
      "node",
      "scripts/network.mjs",
      "init",
    ],
    { env: cfg }
  )
  const proxy = path.resolve("deploy/Caddyfile")
  await innerDocker(host, [
    "run",
    "--rm",
    "--network",
    "none",
    "--volume",
    `${path.dirname(proxy)}:/config`,
    "--entrypoint",
    "node",
    cfg.PA_WORKER_IMAGE,
    "-e",
    `require('node:fs').writeFileSync('/config/Caddyfile',${JSON.stringify(await readFile(proxy, "utf8"))})`,
  ])
  await compose(["up", "-d", "--no-build", "--wait", "postgres"])
  await compose(["run", "--rm", "--no-deps", "worker", "npm", "run", "db:migrate"])
  await compose([
    "run",
    "--rm",
    "--no-deps",
    "--env-from-file",
    path.join(path.dirname(configFile), "owner.env"),
    "worker",
    "npm",
    "run",
    "owner:create",
  ])
  await fixture(
    "model",
    `pa-${cfg.INSTALL_ID}_control`,
    "cloud-model.mjs",
    [
      "--network-alias",
      "cloud-model",
      "--env",
      "FIXTURE_KEY",
      "--env",
      "FIXTURE_REPORT_URL=http://93.184.216.11:8081/reports",
      "--env",
      "FIXTURE_CLOSE_PAGE=1",
      "--env",
      "FIXTURE_DELAY_MS=500",
    ],
    { FIXTURE_KEY: fixtureKey }
  )
  await fixture(
    "reports",
    publicNetwork,
    "report-site.mjs",
    [
      "--ip",
      "93.184.216.11",
      "--env",
      "FIXTURE_HOST=0.0.0.0",
      "--env",
      "FIXTURE_AUTHENTICATED=1",
    ],
    {}
  )
  await code(
    "import{setSettings}from'./lib/config.ts';import{pool}from'./db/index.ts';await setSettings([{key:'provider.custom.apiKey',value:process.env.FIXTURE_KEY},{key:'provider.custom.baseUrl',value:'http://cloud-model:8080/v1'},{key:'model.default',value:'custom/cloud-fixture'}]);console.log('PA_RESULT='+JSON.stringify({configured:true}));await pool.end();",
    { FIXTURE_KEY: fixtureKey }
  )
  await compose(["up", "-d", "--no-build", "--wait"])
  client = await request.newContext({ baseURL: cfg.APP_URL, ignoreHTTPSErrors: true })
  await until(async () => {
    try {
      const response = await client!.get("/login")
      assert.equal(response.status(), 200)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return false
      throw error
    }
  }, "published HTTPS entry reachable from the operator")
  const owner = parseEnv(
    await readFile(path.join(path.dirname(configFile), "owner.env"), "utf8")
  )
  const headers = { Origin: cfg.APP_URL }
  assert.equal(
    (
      await client.post("/api/auth/sign-in/email", {
        headers,
        data: { email: owner.OWNER_EMAIL, password: owner.OWNER_PASSWORD },
      })
    ).status(),
    200
  )
  await sample("control-plane-only")
  const created = await client.post("/api/agents", {
    headers,
    data: {
      name: "Capacity",
      role: "Controlled resource measurement",
      instructions: "",
      model: "custom/cloud-fixture",
      glyph: randomUUID(),
    },
  })
  assert.equal(created.status(), 201)
  agent = (await created.json()).id
  for (let round = 1; round <= rounds; round++) {
    const begin = Date.now()
    const response: APIResponse = await client.post("/api/tasks", {
      headers,
      data: {
        agentId: agent,
        goal: `Capacity round ${round}: download report, save and verify the CSV, then close the report tab.`,
        clientRequestId: randomUUID(),
        completionContract: {
          requireHumanReview: false,
          artifact: {
            path: "cloud-report.csv",
            requiredColumns: ["date", "site", "amount"],
            minRows: 4,
            dateColumn: "date",
            dateFrom: "2026-10-12",
            dateTo: "2026-10-18",
          },
        },
      },
    })
    assert.equal(response.status(), 202)
    const { taskId } = await response.json()
    await until(async () => {
      const status = await query(`SELECT status FROM tasks WHERE id='${taskId}'`)
      assert(
        !["failed", "needs_review", "waiting_user"].includes(status),
        `Unexpected task ${status}`
      )
      return status === "running"
    }, "task running")
    if (round === 1 || round === 8) await sample(`running-${round}`, taskId)
    const detail = await until(async () => {
      const detail = await (await client!.get(`/api/tasks/${taskId}`)).json()
      assert(
        !["failed", "needs_review", "waiting_user", "cancelled"].includes(detail.status),
        JSON.stringify({ status: detail.status, error: detail.error })
      )
      return detail.status === "completed" && detail
    }, "CSV delivered")
    assert.equal(detail.artifacts.length, 1)
    const artifact: APIResponse = await client.get(
      `/api/artifacts/${detail.artifacts[0].id}`
    )
    assert.equal(artifact.status(), 200)
    const csv = await artifact.text()
    const rows = csv.trim().split("\n")
    assert.equal(rows.length, 5)
    assert.equal(
      rows.slice(1).reduce((sum, line) => sum + Number(line.split(",")[2]), 0),
      620
    )
    outcomes.push({
      round,
      taskId,
      artifactId: detail.artifacts[0].id,
      elapsedMs: Date.now() - begin,
      rows: 4,
      amount: 620,
    })
    await writeFile(
      path.join(host.directory, "task-results.json"),
      JSON.stringify(outcomes, null, 2) + "\n"
    )
    if (round === 1 || round === 8) await sample(`completed-${round}`)
    if (round === 8 && stage === "idle") {
      checks.push(
        await code(
          "import assert from'node:assert/strict';import{sweepIdleWorkstations}from'./lib/workstation.ts';import{pool}from'./db/index.ts';assert.deepEqual(await sweepIdleWorkstations(),[]);await pool.end();console.log('PA_RESULT='+JSON.stringify({disabledWithoutDatabaseAccess:true}));",
          {
            WORKSTATION_IDLE_MINUTES: "0",
            DATABASE_URL: "postgresql://disabled:disabled@127.0.0.1:1/disabled",
          }
        )
      )
      // Direct database fixtures exercise eligibility without claiming real
      // human/queued workflows. The eight report tasks above are real runs.
      const probes = await code(
        `import assert from'node:assert/strict';import{pool}from'./db/index.ts';import{sweepIdleWorkstations,workstationHealth}from'./lib/workstation.ts';const agent=${JSON.stringify(agent)};const task=${JSON.stringify(taskId)};const cases=[['human','human',null,null,'completed'],['quarantined','quarantined',null,null,'completed'],['handoff-pending','idle','human',null,'completed'],['reserved','idle',null,task,'completed'],['queued','idle',null,null,'queued'],['waiting_user','idle',null,null,'waiting_user'],['needs_review','idle',null,null,'needs_review']];try{for(const[label,mode,desired,active,status]of cases){await pool.query("UPDATE tasks SET status=$2 WHERE id=$1",[task,status]);await pool.query("UPDATE workstation_control SET mode=$2,desired_mode=$3,active_task_id=$4,updated_at=now()-interval '30 minutes' WHERE agent_id=$1",[agent,mode,desired,active]);assert(!(await sweepIdleWorkstations()).includes(agent),label);await workstationHealth(agent)}}finally{await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[task]);await pool.query("UPDATE workstation_control SET mode='idle',desired_mode=NULL,active_task_id=NULL,updated_at=now() WHERE agent_id=$1",[agent]);await pool.end()}console.log('PA_RESULT='+JSON.stringify({syntheticEligibilityCases:cases.map(c=>c[0])}));`
      )
      checks.push(probes)
      const guest = `pa-${cfg.INSTALL_ID.slice(0, 8)}-ws-${agent}`
      await innerDocker(host, [
        "exec",
        guest,
        "sh",
        "-c",
        "printf retained-idle-home > /home/agent/idle-home-marker.txt",
      ])
      const beforeIdle = JSON.parse(
        await query(
          `SELECT json_build_object('epoch',epoch,'bootId',boot_id,'updatedAt',updated_at) FROM workstation_control WHERE agent_id='${agent}'`
        )
      )
      await sample("eligible-idle-before-stop")
      const waitingAt = Date.now()
      await until(
        async () =>
          !JSON.parse(
            (
              await innerDocker(host, [
                "inspect",
                "--format",
                "{{json .State.Running}}",
                guest,
              ])
            ).stdout.toString()
          ),
        "leased worker automatically stops the idle desktop",
        120000
      )
      const viewer = `pa-${cfg.INSTALL_ID.slice(0, 8)}-viewer-${agent}`
      assert.equal(
        JSON.parse(
          (
            await innerDocker(host, [
              "inspect",
              "--format",
              "{{json .State.Running}}",
              viewer,
            ])
          ).stdout.toString()
        ),
        false
      )
      const afterIdle = JSON.parse(
        await query(
          `SELECT json_build_object('epoch',epoch,'bootId',boot_id,'mode',mode,'activeTaskId',active_task_id) FROM workstation_control WHERE agent_id='${agent}'`
        )
      )
      assert(afterIdle.epoch > beforeIdle.epoch)
      assert.equal(afterIdle.bootId, null)
      assert.equal(afterIdle.mode, "idle")
      assert.equal(afterIdle.activeTaskId, null)
      await sample("automatically-stopped")
      checks.push({
        check:
          "Actual leased-worker timer stopped guest/viewer, preserved their containers and fenced the old boot/epoch",
        waitMs: Date.now() - waitingAt,
        before: beforeIdle,
        after: afterIdle,
      })
    }
  }
  await delay(30000)
  const idle = await sample("idle-30-seconds")
  const workspace = await code(
    `import{controller,workspaceRow}from'./lib/workstation.ts';import{pool}from'./db/index.ts';const w=await workspaceRow(${JSON.stringify(agent)});const p=await controller(${JSON.stringify(agent)},'/pages',{epoch:w.epoch});console.log('PA_RESULT='+JSON.stringify({mode:w.mode,activeTaskId:w.activeTaskId,epoch:w.epoch,pageCount:p.pages.length}));await pool.end();`
  )
  assert.equal(workspace.mode, "idle")
  assert.equal(workspace.activeTaskId, null)
  assert.equal(workspace.pageCount, 1, "Every report tab must actually close")
  const guest = `pa-${cfg.INSTALL_ID.slice(0, 8)}-ws-${agent}`
  for (const name of [guest, `pa-${cfg.INSTALL_ID.slice(0, 8)}-viewer-${agent}`]) {
    const state = JSON.parse(
      (
        await innerDocker(host, ["inspect", "--format", "{{json .State}}", name])
      ).stdout.toString()
    )
    assert(state.Running)
    assert.equal(state.OOMKilled, false)
  }
  const state = JSON.parse(
    (
      await innerDocker(host, [
        "exec",
        `${fixturePrefix}-model`,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/state').then(r=>r.text()).then(console.log)",
      ])
    ).stdout.toString()
  )
  assert.equal(state.failure, undefined)
  assert.equal(state.count, rounds * 8)
  const downloads = JSON.parse(
    (
      await innerDocker(host, [
        "exec",
        `${fixturePrefix}-reports`,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8081/state').then(r=>r.text()).then(console.log)",
      ])
    ).stdout.toString()
  )
  assert.equal(downloads.downloads, rounds)
  if (stage === "idle") {
    assert.equal(
      (
        await innerDocker(host, [
          "exec",
          guest,
          "cat",
          "/home/agent/idle-home-marker.txt",
        ])
      ).stdout.toString(),
      "retained-idle-home"
    )
    checks.push({
      check:
        "Ninth production task automatically woke the stopped desktop and delivered the checked CSV; home marker retained; only one blank browser page remains",
      taskId: outcomes[8].taskId,
    })
  }
  await writeFile(
    path.join(host.directory, "capacity-checkpoint.json"),
    JSON.stringify(
      {
        configFile,
        agent,
        workspace,
        fixtureNames,
        controlledModelCalls: state.count,
        downloads: downloads.downloads,
        idle,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  )
  passed = true
} catch (error) {
  await writeFile(
    path.join(host.directory, "failure.txt"),
    [
      error instanceof Error ? error.stack : String(error),
      error instanceof DockerError ? error.stderr : "",
    ].join("\n"),
    { mode: 0o600 }
  )
  throw error
} finally {
  await client?.dispose()
  if (cfg) {
    const logs = await compose(["logs", "--no-color"])
    await writeFile(
      path.join(host.directory, "stack.log"),
      logs.stdout.toString() + logs.stderr
    )
    await compose(["stop", "--timeout", "60"])
  }
  for (const name of fixtureNames) await innerDocker(host, ["stop", name])
  const server = (
    await innerDocker(host, [
      "info",
      "--format",
      '{"cpuCount":{{.NCPU}},"memoryBytes":{{.MemTotal}},"architecture":"{{.Architecture}}"}',
    ])
  ).stdout
    .toString()
    .trim()
  const report = {
    passed,
    scope:
      stage === "idle"
        ? "controlled-linux-idle-stop-and-wakeup"
        : "controlled-short-run-linux-capacity-baseline",
    stage,
    directory: host.directory,
    recordedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    server: JSON.parse(server),
    sampleCount: samples.length,
    completedTaskCount: outcomes.length,
    outcomes,
    checks,
    controlledProvider: true,
    realModelJudgmentEvaluated: false,
    actualCloudProviderEvaluated: false,
    ordinaryPublicDnsEvaluated: false,
    authenticatedFixtureBypass: true,
    modelResponseDelayMs: 500,
    mainLocalDeploymentUnchanged: true,
    longRunningCapacityEvaluated: false,
    minimumServerSpecEstablished: false,
    automaticIdleStopEvaluated: stage === "idle" && passed,
    configuredIdleMinutes: cfg ? Number(cfg.WORKSTATION_IDLE_MINUTES) : null,
    httpsClientIgnoredTestCertificateErrors: true,
  }
  const json = JSON.stringify(report, null, 2) + "\n"
  await writeFile(path.join(host.directory, "result.json"), json)
  const evidence = stage === "idle" ? "idle-workstations" : "capacity-baseline"
  await writeFile(`docs/evidence/${evidence}-attempt.json`, json)
  if (passed) await writeFile(`docs/evidence/${evidence}.json`, json)
  console.log(json)
  await stopLinuxHost(host, false)
}
