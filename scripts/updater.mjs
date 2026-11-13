// OwnDesk updater (B0): switch the web+worker images, watch health, roll back on failure.
// It always runs in a one-shot container started from the *outgoing* (trusted) worker
// image, so a broken new version cannot block its own rollback. It accepts no model
// input: only fixed docker/compose commands against this installation's deploy dir.
//
//   updater.mjs start  --deploy DIR --action promote|rollback --web REF --worker REF
//   updater.mjs watch  --deploy DIR --deployment ID   (detached; started by `start`)
//   updater.mjs resume --deploy DIR                   (converge a switch that was cut off)
//
// Exit codes: 0 healthy, 2 rolled back to the previous version, 1 failed, 3 busy.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chownSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseEnv } from "node:util"
import pg from "pg"

const [command, ...rest] = process.argv.slice(2)
const options = {}
for (let i = 0; i < rest.length; i += 2) {
  assert(rest[i]?.startsWith("--"), `Unexpected argument ${rest[i]}`)
  options[rest[i].slice(2)] = rest[i + 1]
}
assert(
  ["start", "watch", "resume"].includes(command),
  "Use updater.mjs start|watch|resume"
)
assert(options.deploy && path.isAbsolute(options.deploy), "--deploy must be absolute")

const deployDir = options.deploy
const envFile = path.join(deployDir, ".env")
const composeFile = path.join(deployDir, "compose.yaml")
const config = parseEnv(readFileSync(envFile, "utf8"))
const installId = config.INSTALL_ID
assert(/^[a-f0-9-]{36}$/.test(installId ?? ""), "deploy/.env has no INSTALL_ID")
const project = `pa-${installId}`
const prefix = `pa-${installId.slice(0, 8)}`
// Probe cadence only; there is no fixed observation window.
const setting = (name, fallback) => Number(config[name] || process.env[name] || fallback)
const interval = setting("PA_HEALTH_INTERVAL_SECONDS", 10) * 1000
const FAILURES = 3 // consecutive failed checks that trigger a rollback
const PASSES = 3 // consecutive passed checks before a switch counts as healthy
const START_DEADLINE = setting("PA_HEALTH_START_SECONDS", 300) * 1000
const KEEP_VERSIONS = 3
const KEEP_SNAPSHOTS = 3
const probes = {
  web: "http://127.0.0.1:6797/login",
  worker: "http://127.0.0.1:6798/health",
}

const log = (...parts) => console.log(`[updater ${new Date().toISOString()}]`, ...parts)
const newId = () => randomBytes(9).toString("base64url")

function run(cmd, args, { timeoutMs = 600000, stdout, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    })
    let out = ""
    let err = ""
    if (stdout) child.stdout.pipe(stdout)
    else child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: String(error) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out, stderr: err })
    })
  })
}
async function docker(args, options) {
  const result = await run("docker", args, options)
  if (result.code !== 0)
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim().slice(-800)}`)
  return result.stdout.trim()
}
const composeArgs = (args) => [
  "compose",
  "--file",
  composeFile,
  "--env-file",
  envFile,
  "--project-name",
  project,
  ...args,
]
const compose = (args, options) => docker(composeArgs(args), options)

async function imageId(ref) {
  return docker(["image", "inspect", "--format", "{{.Id}}", ref])
}
async function revisionOf(ref) {
  const value = await docker([
    "image",
    "inspect",
    "--format",
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
    ref,
  ]).catch(() => "")
  return /^[a-f0-9]{7,64}(-dirty)?$/.test(value) ? value : "unknown"
}
async function pin(service, id) {
  const tag = `owndesk-${service}:keep-${id.replace(/^sha256:/, "").slice(0, 12)}`
  await docker(["tag", id, tag])
  return tag
}
async function serviceContainer(service) {
  return (await compose(["ps", "--all", "--quiet", service]).catch(() => "")).split(
    "\n"
  )[0]
}

/* ─────────────── database ─────────────── */

const client = new pg.Client({ connectionString: config.DATABASE_URL })
await client.connect()
const one = async (sql, values) => (await client.query(sql, values)).rows[0]

async function registerVersion(webRef, workerRef) {
  const [webId, workerId] = [await imageId(webRef), await imageId(workerRef)]
  const images = { web: await pin("web", webId), worker: await pin("worker", workerId) }
  const revision = await revisionOf(workerRef)
  const label = revision === "unknown" ? "unknown" : `rev ${revision.slice(0, 7)}`
  return one(
    `INSERT INTO agent_versions (id,label,source_revision,web_image_id,worker_image_id,images,status,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'retained',now())
     ON CONFLICT (web_image_id,worker_image_id) DO UPDATE SET images=EXCLUDED.images,
       status=CASE WHEN agent_versions.status='pruned' THEN 'retained' ELSE agent_versions.status END
     RETURNING *`,
    [newId(), label, revision, webId, workerId, JSON.stringify(images)]
  )
}
async function runningVersion() {
  const [web, worker] = [await serviceContainer("web"), await serviceContainer("worker")]
  const refs =
    web && worker
      ? [
          await docker(["inspect", "--format", "{{.Image}}", web]),
          await docker(["inspect", "--format", "{{.Image}}", worker]),
        ]
      : [config.PA_WEB_IMAGE, config.PA_WORKER_IMAGE]
  return registerVersion(...refs)
}
const version = (id) => one("SELECT * FROM agent_versions WHERE id=$1", [id])
const deployment = (id) => one("SELECT * FROM deployments WHERE id=$1", [id])
async function update(id, fields) {
  const keys = Object.keys(fields)
  await client.query(
    `UPDATE deployments SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(",")},updated_at=now() WHERE id=$1`,
    [id, ...keys.map((key) => fields[key])]
  )
}
async function note(id, entry) {
  await client.query(
    `UPDATE deployments SET health_log=(SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) FROM
       (SELECT e FROM jsonb_array_elements(health_log || $2::jsonb) e OFFSET GREATEST(jsonb_array_length(health_log)+1-60,0)) x),
       updated_at=now() WHERE id=$1`,
    [id, JSON.stringify([entry])]
  )
}

/* ─────────────── deploy steps ─────────────── */

function writeImages(images) {
  const owner = statSync(envFile)
  const text = readFileSync(envFile, "utf8")
  const set = (body, key, value) =>
    new RegExp(`^${key}=.*$`, "m").test(body)
      ? body.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
      : `${body.replace(/\n?$/, "\n")}${key}=${value}\n`
  const next = set(
    set(text, "PA_WEB_IMAGE", images.web),
    "PA_WORKER_IMAGE",
    images.worker
  )
  if (next === text) return
  const temporary = `${envFile}.updater-${process.pid}`
  writeFileSync(temporary, next, { mode: 0o600 })
  chownSync(temporary, owner.uid, owner.gid)
  renameSync(temporary, envFile)
}

async function snapshot(id) {
  const directory = path.join(deployDir, "backups")
  const owner = statSync(deployDir)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chownSync(directory, owner.uid, owner.gid)
  const file = path.join(directory, `pre-deploy-${id}.dump`)
  const stream = createWriteStream(file, { mode: 0o600 })
  const result = await run(
    "docker",
    composeArgs([
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "-Fc",
    ]),
    { stdout: stream }
  )
  await new Promise((resolve) => stream.end(resolve))
  if (result.code !== 0)
    throw new Error(`database snapshot failed: ${result.stderr.slice(-400)}`)
  chownSync(file, owner.uid, owner.gid)
  const old = readdirSync(directory)
    .filter((name) => /^pre-deploy-.+\.dump$/.test(name))
    .map((name) => ({ name, at: statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(KEEP_SNAPSHOTS)
  for (const { name } of old) unlinkSync(path.join(directory, name))
  log(`database snapshot saved to backups/${path.basename(file)}`)
}

async function probe(service) {
  const container = await serviceContainer(service)
  if (!container) return { ok: false, detail: `${service}: no container` }
  const state = await docker([
    "inspect",
    "--format",
    "{{.State.Running}} {{.State.Restarting}}",
    container,
  ]).catch(() => "false false")
  if (state !== "true false")
    return { ok: false, detail: `${service}: not running (${state})` }
  const result = await run(
    "docker",
    [
      "exec",
      container,
      "node",
      "-e",
      `fetch(${JSON.stringify(probes[service])},{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ],
    { timeoutMs: 15000 }
  )
  return result.code === 0
    ? { ok: true }
    : { ok: false, detail: `${service}: health check failed` }
}
async function check(id) {
  const [web, worker] = [await probe("web"), await probe("worker")]
  const entry = {
    at: new Date().toISOString(),
    ok: web.ok && worker.ok,
    web: web.ok,
    worker: worker.ok,
    ...(web.ok && worker.ok
      ? {}
      : { detail: [web.detail, worker.detail].filter(Boolean).join("; ") }),
  }
  await note(id, entry).catch(() => {})
  return entry
}

// After a switch: PASSES consecutive good checks = healthy, FAILURES consecutive bad = not.
async function confirm(id) {
  const deadline = Date.now() + START_DEADLINE
  let passes = 0
  let failures = 0
  let last
  while (Date.now() < deadline) {
    last = await check(id)
    if (last.ok) {
      failures = 0
      if (++passes >= PASSES) return { healthy: true }
    } else {
      passes = 0
      if (++failures >= FAILURES)
        return {
          healthy: false,
          reason: `${FAILURES} health checks failed in a row: ${last.detail}`,
        }
    }
    await delay(interval)
  }
  return {
    healthy: false,
    reason: `not healthy within ${START_DEADLINE / 1000}s: ${last?.detail}`,
  }
}

async function apply(dep, target) {
  await update(dep.id, { phase: "switching" })
  writeImages(target.images)
  log(`images set to ${target.images.web} / ${target.images.worker}`)
  await update(dep.id, { phase: "starting" })
  const up = await run(
    "docker",
    composeArgs([
      "up",
      "--detach",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "300",
      "web",
      "worker",
    ]),
    { timeoutMs: 420000 }
  )
  if (up.code !== 0)
    await note(dep.id, {
      at: new Date().toISOString(),
      ok: false,
      web: false,
      worker: false,
      detail: `compose up --wait failed: ${up.stderr.trim().slice(-300)}`,
    })
  await update(dep.id, { phase: "checking" })
  return confirm(dep.id)
}

async function prune(activeId) {
  const kept = (
    await client.query(
      `SELECT id FROM agent_versions WHERE status IN ('active','retained')
       ORDER BY (id=$1) DESC, COALESCE(promoted_at,created_at) DESC`,
      [activeId]
    )
  ).rows.map((row) => row.id)
  const drop = (
    await client.query(
      `SELECT * FROM agent_versions WHERE (status IN ('active','retained') AND NOT (id = ANY($1)))
       OR (status='rejected' AND retired_at IS NULL)`,
      [kept.slice(0, KEEP_VERSIONS)]
    )
  ).rows
  for (const row of drop) {
    for (const tag of [row.images.web, row.images.worker])
      if (/:keep-[a-f0-9]{12}$/.test(tag)) await run("docker", ["rmi", tag])
    await client.query(
      `UPDATE agent_versions SET status=CASE WHEN status='rejected' THEN 'rejected' ELSE 'pruned' END,
       retired_at=now() WHERE id=$1`,
      [row.id]
    )
    log(`pruned image tags of version ${row.label}`)
  }
}

async function markHealthy(dep) {
  await client.query("BEGIN")
  await client.query(
    "UPDATE agent_versions SET status='retained' WHERE status='active' AND id<>$1",
    [dep.to_version_id]
  )
  await client.query(
    "UPDATE agent_versions SET status='active',promoted_at=now(),retired_at=NULL WHERE id=$1",
    [dep.to_version_id]
  )
  await client.query(
    "UPDATE deployments SET status='healthy',phase=$2,updated_at=now(),finished_at=now() WHERE id=$1",
    [dep.id, dep.action === "auto_rollback" ? "done" : "watching"]
  )
  await client.query("COMMIT")
  await prune(dep.to_version_id).catch((error) => log("prune skipped:", error.message))
}

async function selfContainer() {
  const [container] = JSON.parse(await docker(["inspect", os.hostname()]))
  return container
}
async function stopWatchers(except) {
  const ids = (
    await docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=owndesk.updater=${installId}`,
      "--filter",
      "label=owndesk.updater.role=watch",
    ])
  )
    .split("\n")
    .filter(Boolean)
  for (const id of ids)
    if (!except || !except.startsWith(id)) await run("docker", ["rm", "--force", id])
}
async function spawnWatcher(dep) {
  const self = await selfContainer()
  const network = Object.keys(self.NetworkSettings.Networks)[0]
  await stopWatchers()
  await docker([
    "run",
    "--detach",
    "--name",
    `${prefix}-watch-${dep.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`,
    "--restart",
    "unless-stopped",
    "--label",
    `owndesk.updater=${installId}`,
    "--label",
    "owndesk.updater.role=watch",
    "--network",
    network,
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--volume",
    `${deployDir}:${deployDir}`,
    self.Image,
    "node",
    "scripts/updater.mjs",
    "watch",
    "--deploy",
    deployDir,
    "--deployment",
    dep.id,
  ])
  log(`watching health of the new version (watcher from the previous image)`)
}

// The switch to dep.to failed: go back to dep.from so the installation stays usable.
async function rollBack(dep, reason) {
  log(`ROLLING BACK: ${reason}`)
  if (!dep.from_version_id) {
    await update(dep.id, {
      status: "failed",
      phase: "done",
      reason,
      finished_at: new Date(),
    })
    log("no previous version recorded; manual repair needed")
    return 1
  }
  const back = newId()
  await client.query("BEGIN")
  await client.query(
    "UPDATE deployments SET status='rolled_back',phase='done',reason=$2,related_id=$3,updated_at=now(),finished_at=now() WHERE id=$1",
    [dep.id, reason, back]
  )
  await client.query(
    "UPDATE agent_versions SET status='rejected',retired_at=NULL WHERE id=$1",
    [dep.to_version_id]
  )
  await client.query(
    `INSERT INTO deployments (id,from_version_id,to_version_id,action,status,phase,reason,related_id,started_at,updated_at)
     VALUES ($1,$2,$3,'auto_rollback','running','switching',$4,$5,now(),now())`,
    [back, dep.to_version_id, dep.from_version_id, reason, dep.id]
  )
  await client.query("COMMIT")
  return execute(await deployment(back))
}

async function execute(dep) {
  const target = await version(dep.to_version_id)
  log(`${dep.action} → ${target.label} (deployment ${dep.id})`)
  let result
  try {
    result = await apply(dep, target)
  } catch (error) {
    result = { healthy: false, reason: error.message.slice(0, 500) }
  }
  if (result.healthy) {
    await markHealthy(dep)
    log(`HEALTHY: ${target.label} is running`)
    if (dep.action !== "auto_rollback" && options.watch !== "no") await spawnWatcher(dep)
    return dep.action === "auto_rollback" ? 2 : 0
  }
  if (dep.action === "auto_rollback") {
    await update(dep.id, {
      status: "failed",
      phase: "done",
      reason: result.reason,
      finished_at: new Date(),
    })
    log(`FAILED: rollback target is not healthy either: ${result.reason}`)
    return 1
  }
  return rollBack(dep, result.reason)
}

/* ─────────────── commands ─────────────── */

async function start() {
  assert(["promote", "rollback"].includes(options.action), "--action promote|rollback")
  assert(
    options.web && options.worker,
    "--web and --worker image references are required"
  )
  if (options.action === "promote") {
    // Snapshot first (insurance), then migrate with the *new* worker image while the
    // old version keeps serving. Migrations are additive, so the old image can still
    // read the database if the new version has to be rolled back.
    await snapshot(`${Date.now()}`)
    const migrate = await run(
      "docker",
      composeArgs(["run", "--rm", "--no-deps", "worker", "npm", "run", "db:migrate"]),
      { timeoutMs: 600000, env: { PA_WORKER_IMAGE: options.worker } }
    )
    if (migrate.code !== 0) {
      log(
        `FAILED: migrations did not apply; nothing was switched: ${migrate.stderr.trim().slice(-500)}`
      )
      return 1
    }
    log("migrations applied with the new worker image")
  }
  const from = await runningVersion()
  const to = await registerVersion(options.web, options.worker)
  if (from.id === to.id) {
    log(`${to.label} is already running`)
    await client.query(
      "UPDATE agent_versions SET status='active' WHERE id=$1 AND status<>'active'",
      [to.id]
    )
    return 0
  }
  let dep
  try {
    dep = await one(
      `INSERT INTO deployments (id,from_version_id,to_version_id,action,status,phase,started_at,updated_at)
       VALUES ($1,$2,$3,$4,'running','switching',now(),now()) RETURNING *`,
      [newId(), from.id, to.id, options.action]
    )
  } catch (error) {
    if (error.code === "23505") {
      log(
        "BUSY: another switch is in progress; run `scripts/upgrade.sh --resume` if it was cut off"
      )
      return 3
    }
    throw error
  }
  await stopWatchers()
  return execute(dep)
}

async function watch() {
  const id = options.deployment
  assert(id, "--deployment is required")
  let failures = 0
  while (true) {
    const dep = await deployment(id)
    const newer = await one(
      "SELECT id FROM deployments WHERE started_at > $1 AND id<>$2 LIMIT 1",
      [dep?.started_at ?? new Date(0), id]
    )
    if (!dep || dep.status !== "healthy" || newer) {
      log("superseded; watcher exits")
      break
    }
    const entry = await probe("web").then(async (web) => {
      const worker = await probe("worker")
      return {
        at: new Date().toISOString(),
        ok: web.ok && worker.ok,
        web: web.ok,
        worker: worker.ok,
        detail: [web.detail, worker.detail].filter(Boolean).join("; ") || undefined,
      }
    })
    if (entry.ok) failures = 0
    else {
      await note(id, entry).catch(() => {})
      if (++failures >= FAILURES) {
        await rollBack(
          dep,
          `health failed after the switch (${FAILURES} checks in a row): ${entry.detail}`
        )
        break
      }
    }
    await delay(interval)
  }
  await run("docker", ["update", "--restart", "no", os.hostname()])
  return 0
}

async function resume() {
  const dep = await one("SELECT * FROM deployments WHERE status='running' LIMIT 1")
  if (!dep) {
    log("nothing to resume: no switch in progress")
    return 0
  }
  log(`resuming ${dep.action} ${dep.id} from phase ${dep.phase}`)
  await stopWatchers()
  return execute(dep)
}

let code = 1
try {
  code = await { start, watch, resume }[command]()
} catch (error) {
  log("ERROR:", error.message)
} finally {
  await client.end().catch(() => {})
}
process.exit(code)
