// B0 version base, end to end on a disposable rootful Docker host:
// two real builds, upgrade, a broken upgrade (immediate and delayed failure) that
// rolls back by itself, one-click switching from the web API, an updater killed
// mid-switch that `upgrade.sh --resume` converges, and data surviving all of it.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseEnv, promisify } from "node:util"
import { docker, dockerRaw } from "@/lib/docker"
import {
  hostEnvironment,
  innerDocker,
  linuxHost,
  loadImages,
  stopLinuxHost,
  type LinuxHost,
} from "./helpers/linux-host"

const exec = promisify(execFile)
const repo = process.cwd()
const evidence = process.env.B0_EVIDENCE_DIR
const keep = process.env.B0_KEEP === "1"
const HANG_AFTER = Number(process.env.B0_HANG_AFTER_SECONDS || 75)
const checks: { check: string; detail?: unknown }[] = []
const pass = (check: string, detail?: unknown) => {
  checks.push({ check, ...(detail === undefined ? {} : { detail }) })
  console.log(`PASS ${checks.length}: ${check}`)
}
const git = async (args: string[], env: Record<string, string> = {}) =>
  (
    await exec("git", args, {
      cwd: repo,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim()

async function until<T>(
  fn: () => Promise<T | false | undefined | null>,
  name: string,
  timeout = 120000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    assert(Date.now() < deadline, `Timed out: ${name}`)
    await delay(1000)
  }
}

/* ───────────── images: two real builds plus two broken derivatives ───────────── */

async function labelOf(image: string) {
  const result = await dockerRaw([
    "image",
    "inspect",
    "--format",
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
    image,
  ])
  return result.exitCode === 0 ? result.stdout.toString().trim() : ""
}
async function buildRevision(revision: string, tag: string) {
  if (
    (await labelOf(`owndesk-web:${tag}`)) === revision &&
    (await labelOf(`owndesk-worker:${tag}`)) === revision
  )
    return
  const tree = path.resolve("data/experiments", `b0-src-${tag}-${Date.now()}`)
  await git(["worktree", "add", "--detach", tree, revision])
  try {
    for (const target of ["web", "worker"])
      await docker(
        [
          "build",
          "--target",
          target,
          "--build-arg",
          `SOURCE_REVISION=${revision}`,
          "--tag",
          `owndesk-${target}:${tag}`,
          tree,
        ],
        { timeoutMs: 1800000, maxOutputBytes: 64 * 1024 * 1024 }
      )
  } finally {
    await git(["worktree", "remove", "--force", tree])
  }
}
// Version B: revision A plus one fixture file, as a commit object no branch points to.
async function fixtureRevision(base: string) {
  const index = path.resolve("data/experiments", `b0-index-${Date.now()}`)
  const blob = await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["hash-object", "-w", "--stdin"], { cwd: repo })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("close", (code) =>
      code ? reject(new Error("hash-object")) : resolve(out.trim())
    )
    child.stdin.end(`B0 version fixture built from ${base}\n`)
  })
  const env = { GIT_INDEX_FILE: index }
  await git(["read-tree", base], env)
  await git(
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},docs/b0-version-fixture.txt`,
    ],
    env
  )
  const tree = await git(["write-tree"], env)
  await rm(index, { force: true })
  return git(["commit-tree", tree, "-p", base, "-m", "B0 test fixture version"], {
    GIT_AUTHOR_NAME: "OwnDesk test",
    GIT_AUTHOR_EMAIL: "test@owndesk.local",
    GIT_COMMITTER_NAME: "OwnDesk test",
    GIT_COMMITTER_EMAIL: "test@owndesk.local",
  })
}
async function derived(tag: string, from: string, dockerfile: string) {
  const directory = path.resolve("data/experiments", `b0-${tag}-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "Dockerfile"), `FROM ${from}\n${dockerfile}\n`)
  await docker(["build", "--tag", tag, directory], { timeoutMs: 300000 })
  await rm(directory, { recursive: true, force: true })
}

const revisionA = process.env.B0_REVISION ?? (await git(["rev-parse", "HEAD"]))
const revisionB = await fixtureRevision(revisionA)
await buildRevision(revisionA, "b0-a")
await buildRevision(revisionB, "b0-b")
// Web that answers every request with 500: never healthy.
await derived(
  "owndesk-web:b0-bad",
  "owndesk-web:b0-b",
  `CMD ["node","-e","require('http').createServer((q,s)=>s.writeHead(500).end('broken')).listen(6797,'0.0.0.0')"]`
)
// Worker that is healthy at first and freezes ${HANG_AFTER}s after it starts.
await derived(
  "owndesk-worker:b0-hang",
  "owndesk-worker:b0-b",
  `CMD ["sh","-c","node --import tsx worker/main.ts & W=$!; sleep ${HANG_AFTER}; kill -STOP $W; exec sleep infinity"]`
)
pass("Built two real versions and two broken derivatives", {
  revisionA,
  revisionB,
  labels: {
    a: await labelOf("owndesk-worker:b0-a"),
    b: await labelOf("owndesk-worker:b0-b"),
  },
})

/* ───────────── a disposable install ───────────── */

let host: LinuxHost | undefined
let passed = false
try {
  host = await linuxHost({ shareDirectory: true, memory: "4g" })
  const h = host
  const root = path.join(h.directory, "install")
  const deploy = path.join(root, "deploy")
  await mkdir(path.join(root, "scripts"), { recursive: true })
  for (const file of ["upgrade.sh", "deploy-env.mjs", "vapid-keys.mjs"])
    await copyFile(path.join(repo, "scripts", file), path.join(root, "scripts", file))
  await exec("node", [
    path.join(root, "scripts/deploy-env.mjs"),
    "https://localhost:8443",
    "owner@b0.test",
    deploy,
  ])
  for (const file of ["compose.yaml", "Caddyfile"])
    await copyFile(path.join(repo, "deploy", file), path.join(deploy, file))
  const envFile = path.join(deploy, ".env")
  const readConfig = async () => parseEnv(await readFile(envFile, "utf8"))
  let text = await readFile(envFile, "utf8")
  text = text
    .replace(/^PA_WEB_IMAGE=.*$/m, "PA_WEB_IMAGE=owndesk-web:b0-a")
    .replace(/^PA_WORKER_IMAGE=.*$/m, "PA_WORKER_IMAGE=owndesk-worker:b0-a")
  text += "PA_HEALTH_INTERVAL_SECONDS=3\nPA_HEALTH_START_SECONDS=240\n"
  await writeFile(envFile, text, { mode: 0o600 })
  const config = (await readConfig()) as Record<string, string>
  assert.equal(config.PA_DEPLOY_DIR, deploy, "deploy-env records the deploy directory")
  const project = `pa-${config.INSTALL_ID}`
  const inner = (args: string[], timeoutMs = 300000) =>
    innerDocker(h, args, { timeoutMs, env: config, maxOutputBytes: 32 * 1024 * 1024 })
  const compose = (args: string[], timeoutMs = 300000) =>
    inner(
      [
        "compose",
        "--file",
        path.join(deploy, "compose.yaml"),
        "--env-file",
        envFile,
        "--project-name",
        project,
        ...args,
      ],
      timeoutMs
    )
  const out = (result: { stdout: Buffer }) => result.stdout.toString().trim()

  await loadImages(h, [
    "owndesk-web:b0-a",
    "owndesk-worker:b0-a",
    "owndesk-web:b0-b",
    "owndesk-worker:b0-b",
    "owndesk-web:b0-bad",
    "owndesk-worker:b0-hang",
    "postgres:16.15-alpine",
  ])
  await inner(
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
      "owndesk-worker:b0-a",
      "node",
      "scripts/network.mjs",
      "init",
    ],
    60000
  )
  await compose(["up", "--detach", "--wait", "postgres"])
  await compose(["run", "--rm", "worker", "npm", "run", "db:migrate"])
  await compose([
    "run",
    "--rm",
    "--env-from-file",
    path.join(deploy, "owner.env"),
    "worker",
    "npm",
    "run",
    "owner:create",
  ])
  await compose([
    "up",
    "--detach",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "180",
    "web",
    "worker",
  ])

  const psql = async (query: string) =>
    out(
      await compose([
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "agent",
        "-d",
        "personal_agent",
        "-At",
        "-F",
        "\t",
        "-c",
        query,
      ])
    )
  const rows = async (query: string) =>
    (await psql(query))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
  const containerImage = async (service: string) =>
    out(
      await inner([
        "inspect",
        "--format",
        "{{.Image}}",
        out(await compose(["ps", "--quiet", service])),
      ])
    )
  const imageIdOf = async (ref: string) =>
    out(await inner(["image", "inspect", "--format", "{{.Id}}", ref]))
  const ids = {
    webA: await imageIdOf("owndesk-web:b0-a"),
    workerA: await imageIdOf("owndesk-worker:b0-a"),
    webB: await imageIdOf("owndesk-web:b0-b"),
    workerB: await imageIdOf("owndesk-worker:b0-b"),
    webBad: await imageIdOf("owndesk-web:b0-bad"),
    workerHang: await imageIdOf("owndesk-worker:b0-hang"),
  }
  const versionOf = async (web: string, worker: string) => {
    const [row] = await rows(
      `SELECT id,status,label,source_revision,COALESCE(git_commit,''),images->>'web',images->>'worker' FROM agent_versions WHERE web_image_id='${web}' AND worker_image_id='${worker}'`
    )
    return (
      row && {
        id: row[0],
        status: row[1],
        label: row[2],
        revision: row[3],
        gitCommit: row[4],
        images: { web: row[5], worker: row[6] },
      }
    )
  }
  const running = async () => ({
    web: await containerImage("web"),
    worker: await containerImage("worker"),
  })
  const marker = randomUUID()
  await psql(
    `INSERT INTO agents (id,name,role,glyph,created_at,updated_at) VALUES ('b0-marker','B0 marker','${marker}','b0glyph',now(),now())`
  )
  const markerIntact = async () =>
    assert.equal(
      await psql("SELECT role FROM agents WHERE id='b0-marker'"),
      marker,
      "owner data survived"
    )
  const upgrade = (args: string[]) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn("bash", [path.join(root, "scripts/upgrade.sh"), ...args], {
        env: { ...process.env, ...hostEnvironment(h) },
      })
      let output = ""
      child.stdout.on("data", (chunk) => (output += chunk))
      child.stderr.on("data", (chunk) => (output += chunk))
      child.on("close", (code) => resolve({ code: code ?? -1, output }))
    })
  const log = async (name: string, value: string) => {
    if (evidence) await writeFile(path.join(evidence, `versions-${name}.log`), value)
  }
  const latestDeployments = async (n = 4) =>
    rows(
      `SELECT id,action,status,phase,COALESCE(reason,''),from_version_id,to_version_id FROM deployments ORDER BY started_at DESC LIMIT ${n}`
    )
  const expectRunning = async (web: string, worker: string, name: string) => {
    const now = await running()
    assert.deepEqual(now, { web, worker }, `${name}: running images`)
    const version = await versionOf(web, worker)
    assert.equal(version?.status, "active", `${name}: active version`)
    const env = await readConfig()
    assert.equal(env.PA_WEB_IMAGE, version.images.web, `${name}: .env web pin`)
    assert.equal(env.PA_WORKER_IMAGE, version.images.worker, `${name}: .env worker pin`)
    await markerIntact()
    return version
  }

  // 1. Fresh install: the running pair is recorded and its source committed.
  const versionA = await until(async () => {
    const version = await versionOf(ids.webA, ids.workerA)
    return version?.status === "active" && version.gitCommit ? version : null
  }, "worker records the running version")
  assert.equal(versionA.revision, revisionA)
  const workerId = out(await compose(["ps", "--quiet", "worker"]))
  const repoGit = (args: string[]) =>
    inner([
      "exec",
      workerId,
      "git",
      "-c",
      "safe.directory=*",
      "--git-dir",
      "/app/data/evolution/versions.git",
      ...args,
    ])
  assert.equal(out(await repoGit(["rev-parse", "upstream"])), versionA.gitCommit)
  const message = out(await repoGit(["log", "-1", "--format=%B", "upstream"]))
  assert(message.includes(`Source-Revision: ${revisionA}`), message)
  const listing = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split("\t")
        return `${meta.split(" ")[2]} ${file}`
      })
      .sort()
  const evolutionFiles = listing(out(await repoGit(["ls-tree", "-r", "upstream"])))
  const sourceFiles = listing(await git(["ls-tree", "-r", revisionA]))
  assert.deepEqual(
    evolutionFiles,
    sourceFiles,
    "version repository tree equals the image revision"
  )
  pass(
    "Fresh install records the running version; its source commit matches the image revision",
    {
      label: versionA.label,
      revision: versionA.revision,
      gitCommit: versionA.gitCommit,
      files: evolutionFiles.length,
    }
  )

  // 2. Upgrade A -> B through scripts/upgrade.sh.
  let result = await upgrade(["--local", "owndesk-web:b0-b", "owndesk-worker:b0-b"])
  await log("promote-b", result.output)
  assert.equal(result.code, 0, result.output)
  const versionB = await expectRunning(ids.webB, ids.workerB, "upgrade to B")
  assert.equal((await versionOf(ids.webA, ids.workerA))?.status, "retained")
  let [last] = await latestDeployments(1)
  assert.deepEqual(last.slice(1, 4), ["promote", "healthy", "watching"])
  const watcher = async () =>
    out(
      await inner([
        "ps",
        "--quiet",
        "--filter",
        `label=owndesk.updater=${config.INSTALL_ID}`,
        "--filter",
        "label=owndesk.updater.role=watch",
      ])
    )
  const watcherId = await watcher()
  assert(watcherId, "a health watcher keeps running after the upgrade")
  assert.equal(
    out(await inner(["inspect", "--format", "{{.Image}}", watcherId])),
    ids.workerA,
    "the watcher runs from the previous (trusted) image"
  )
  await until(async () => {
    const version = await versionOf(ids.webB, ids.workerB)
    return version?.gitCommit ? version : null
  }, "B source imported")
  const history = out(await repoGit(["log", "--format=%s", "upstream"])).split("\n")
  assert.equal(history.length, 2, history.join("\n"))
  const backups = out(
    await inner([
      "run",
      "--rm",
      "--volume",
      `${deploy}:/d`,
      "postgres:16.15-alpine",
      "ls",
      "/d/backups",
    ])
  )
  assert.match(backups, /pre-deploy-\d+\.dump/)
  pass(
    "Upgrade A→B: healthy, A kept, watcher from A's image, database snapshot taken, data intact",
    {
      versionB: versionB.label,
      upstreamHistory: history,
    }
  )

  // 3. Broken upgrade (web answers 500): rolled back to B automatically.
  result = await upgrade(["--local", "owndesk-web:b0-bad", "owndesk-worker:b0-b"])
  await log("promote-bad", result.output)
  assert.equal(result.code, 2, result.output)
  await expectRunning(ids.webB, ids.workerB, "after broken upgrade")
  ;[last] = await latestDeployments(2)
  const [rollback, failed] = await latestDeployments(2)
  assert.deepEqual(rollback.slice(1, 3), ["auto_rollback", "healthy"])
  assert.deepEqual(failed.slice(1, 3), ["promote", "rolled_back"])
  assert.match(failed[4], /web/)
  assert.equal((await versionOf(ids.webBad, ids.workerB))?.status, "rejected")
  assert.equal(
    await watcher(),
    "",
    "the old watcher was replaced and the rollback runs unwatched on the known-good version"
  )
  pass("Broken upgrade (/login 500) rolls back to B by itself; data intact", {
    reason: failed[4],
  })

  // 4. Upgrade that breaks later (worker freezes after HANG_AFTER s): the watcher rolls back.
  result = await upgrade(["--local", "owndesk-web:b0-b", "owndesk-worker:b0-hang"])
  await log("promote-hang", result.output)
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(await running(), { web: ids.webB, worker: ids.workerHang })
  const hangWatcher = await watcher()
  assert(hangWatcher)
  const settled = await until(
    async () => {
      const [newest, previous] = await latestDeployments(2)
      return newest[1] === "auto_rollback" && newest[2] !== "running"
        ? { newest, previous }
        : null
    },
    "watcher detects the frozen worker and rolls back",
    (HANG_AFTER + 240) * 1000
  )
  assert.equal(settled.newest[2], "healthy")
  assert.deepEqual(settled.previous.slice(1, 3), ["promote", "rolled_back"])
  assert.match(settled.previous[4], /after the switch/)
  await expectRunning(ids.webB, ids.workerB, "after delayed failure")
  assert.equal((await versionOf(ids.webB, ids.workerHang))?.status, "rejected")
  await until(
    async () =>
      out(
        await inner([
          "inspect",
          "--format",
          "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}",
          hangWatcher,
        ])
      ) === "false no",
    "watcher exits after the rollback"
  )
  // The kept B pins survive pruning of the rejected pairs that share B's images.
  for (const tag of [versionB.images.web, versionB.images.worker])
    assert.equal(
      (await dockerRaw(["image", "inspect", tag], { env: hostEnvironment(h) })).exitCode,
      0,
      tag
    )
  pass(
    "Version that freezes after it went healthy is rolled back by the watcher; data intact",
    {
      reason: settled.previous[4],
    }
  )

  // 5. One-click switching through the web API (owner session, same origin).
  const owner = parseEnv(await readFile(path.join(deploy, "owner.env"), "utf8"))
  const web = async (script: string) =>
    JSON.parse(
      out(
        await inner(
          [
            "exec",
            "--env",
            `B0_EMAIL=${owner.OWNER_EMAIL}`,
            "--env",
            `B0_PASSWORD=${owner.OWNER_PASSWORD}`,
            out(await compose(["ps", "--quiet", "web"])),
            "node",
            "--input-type=module",
            "-e",
            `const base='http://127.0.0.1:6797', origin=${JSON.stringify(config.APP_URL)}
const login=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:process.env.B0_EMAIL,password:process.env.B0_PASSWORD})})
if(!login.ok) throw new Error('login '+login.status)
const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
const headers={'Content-Type':'application/json',Origin:origin,Cookie:cookie}
${script}`,
          ],
          60000
        )
      )
    )
  const switchTo = (versionId: string) =>
    web(
      `const r=await fetch(base+'/api/versions/switch',{method:'POST',headers,body:JSON.stringify({versionId:${JSON.stringify(versionId)}})});console.log(JSON.stringify({status:r.status,body:await r.json()}))`
    )
  const page = await web(
    `const p=await fetch(base+'/versions',{headers});const html=await p.text();const api=await (await fetch(base+'/api/versions',{headers})).json();console.log(JSON.stringify({status:p.status,hasTitle:html.includes('版本'),hasButton:html.includes('切换到这个版本'),api}))`
  )
  assert.equal(page.status, 200)
  assert(page.hasTitle && page.hasButton, "versions page renders with a switch button")
  assert(page.api.enabled)
  assert.equal(
    page.api.versions.find((v: { status: string }) => v.status === "active")?.id,
    versionB.id
  )
  const cross = await web(
    `const r=await fetch(base+'/api/versions/switch',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:'{}'});console.log(JSON.stringify({status:r.status}))`
  )
  assert.equal(cross.status, 403, "cross-origin switch refused")
  const settle = (action: string, to: string) =>
    until(
      async () => {
        const [newest] = await latestDeployments(1)
        return newest[1] === action && newest[6] === to && newest[2] !== "running"
          ? newest
          : null
      },
      `${action} to ${to} settles`,
      300000
    )
  let response = await switchTo(versionA.id)
  assert.equal(response.status, 202, JSON.stringify(response))
  assert.equal((await settle("rollback", versionA.id))[2], "healthy")
  await expectRunning(ids.webA, ids.workerA, "one-click to A")
  await until(async () => (await watcher()) !== "", "watcher after one-click switch")
  response = await switchTo(versionB.id)
  assert.equal(response.status, 202, JSON.stringify(response))
  assert.equal((await settle("rollback", versionB.id))[2], "healthy")
  await expectRunning(ids.webB, ids.workerB, "one-click back to B")
  pass("One-click switch to A and back to B from the web API: both healthy; data intact")

  // 6. Updater killed mid-switch, then `upgrade.sh --resume` converges.
  response = await switchTo(versionA.id)
  assert.equal(response.status, 202)
  await until(
    async () => {
      const [newest] = await latestDeployments(1)
      return newest[2] === "running" && ["starting", "checking"].includes(newest[3])
    },
    "switch reaches the start phase",
    120000
  )
  const switchers = out(
    await inner([
      "ps",
      "--quiet",
      "--filter",
      `label=owndesk.updater=${config.INSTALL_ID}`,
      "--filter",
      "label=owndesk.updater.role=switch",
    ])
  )
  assert(switchers, "the updater container is running")
  await inner(["rm", "--force", ...switchers.split("\n")])
  ;[last] = await latestDeployments(1)
  assert.equal(last[2], "running", "the killed switch is left unfinished")
  const busy = await upgrade(["--local", "owndesk-web:b0-b", "owndesk-worker:b0-b"])
  await log("busy", busy.output)
  assert.equal(busy.code, 3, busy.output)
  result = await upgrade(["--resume"])
  await log("resume", result.output)
  assert.equal(result.code, 0, result.output)
  ;[last] = await latestDeployments(1)
  assert.deepEqual(last.slice(1, 3), ["rollback", "healthy"])
  await expectRunning(ids.webA, ids.workerA, "after resume")
  const again = await upgrade(["--resume"])
  assert.equal(again.code, 0)
  assert.match(again.output, /nothing to resume/)
  pass(
    "Updater killed mid-switch: a second switch is refused, --resume converges to A; data intact"
  )

  const final = await rows(
    "SELECT label,status,source_revision FROM agent_versions ORDER BY created_at"
  )
  const deployments = await latestDeployments(20)
  if (evidence)
    await writeFile(
      path.join(evidence, "versions-summary.json"),
      JSON.stringify(
        { checks, versions: final, deployments: deployments.map((d) => d.slice(1, 5)) },
        null,
        2
      )
    )
  passed = true
} finally {
  if (host && !keep) {
    await stopLinuxHost(host, true).catch((error) =>
      console.error("cleanup failed", error)
    )
    await rm(host.directory, { recursive: true, force: true }).catch(() => {})
  }
  for (const tag of ["owndesk-web:b0-bad", "owndesk-worker:b0-hang"])
    await dockerRaw(["rmi", tag]).catch(() => {})
}
console.log(JSON.stringify({ passed, checks: checks.length }, null, 2))
assert(passed)
