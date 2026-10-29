import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import https from "node:https"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseEnv, promisify } from "node:util"
import { chromium, request } from "playwright"
import { WebSocket } from "ws"
import { DockerError } from "@/lib/docker"
import {
  hostEnvironment,
  innerDocker,
  linuxHost,
  loadImages,
  stopLinuxHost,
} from "./helpers/linux-host"

const stage = process.argv[2]
assert(
  ["prepare", "restore", "validate"].includes(stage),
  "Use tests/restore.ts prepare|restore|validate with explicit isolated Linux host and source/checkpoint paths"
)
assert(process.env.PA_LINUX_HOST_STATE, "Use an explicit dedicated Linux host")
const host = await linuxHost()
const checks: Record<string, unknown>[] = []
let passed = false
let configFile = ""
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let checkpoint: any
const run = promisify(execFile)

async function until<T>(
  fn: () => Promise<T | false>,
  name: string,
  timeout = 90000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await fn()
    if (value) return value
    assert(Date.now() < deadline, `Timed out: ${name}`)
    await delay(200)
  }
}
async function config() {
  return parseEnv(await readFile(configFile, "utf8")) as Record<string, string>
}
async function compose(args: string[]) {
  const cfg = await config()
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
    { env: cfg, timeoutMs: 180000 }
  )
}
async function code(source: string) {
  const result = await compose([
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "worker",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    source,
  ])
  const line = result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("PA_RESULT="))
  assert.equal(line.length, 1, result.stdout.toString())
  return JSON.parse(line[0].slice(10))
}
async function query(sql: string) {
  const postgres = (await compose(["ps", "-q", "postgres"])).stdout.toString().trim()
  return (
    await innerDocker(host, [
      "exec",
      postgres,
      "psql",
      "-X",
      "--set",
      "ON_ERROR_STOP=1",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "-At",
      "-c",
      sql,
    ])
  ).stdout
    .toString()
    .trim()
}
async function guard(mode: "init" | "check") {
  const cfg = await config()
  return innerDocker(
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
      cfg.PA_WORKER_IMAGE ?? "owndesk-worker:0.9.0-dev",
      "node",
      "scripts/network.mjs",
      mode,
    ],
    { env: cfg }
  )
}
async function snapshot(args: string[], label: string) {
  const result = await run(process.execPath, ["scripts/snapshot.mjs", ...args], {
    env: { ...process.env, ...hostEnvironment(host) },
    timeout: 240000,
    maxBuffer: 2 * 1024 * 1024,
  })
  await writeFile(
    path.join(host.directory, `${label}.log`),
    result.stdout + result.stderr
  )
  return result
}
async function fixtures(key: string) {
  const cfg = await config()
  const network = `${host.name}-restore-public`
  await innerDocker(host, ["network", "create", "--subnet", "93.184.216.0/24", network])
  for (const [name, file, net, args] of [
    [
      "model",
      "restore-model.mjs",
      `pa-${cfg.INSTALL_ID}_control`,
      ["--network-alias", "restore-model", "--env", "FIXTURE_KEY"],
    ],
    [
      "reports",
      "report-site.mjs",
      network,
      ["--ip", "93.184.216.8", "--env", "FIXTURE_HOST=0.0.0.0"],
    ],
    [
      "effects",
      "effects-site.mjs",
      network,
      ["--ip", "93.184.216.10", "--env", "FIXTURE_HOST=0.0.0.0"],
    ],
  ] as [string, string, string, string[]][]) {
    const container = `${host.name}-restore-${name}`
    await innerDocker(
      host,
      [
        "create",
        "--name",
        container,
        "--network",
        net,
        ...args,
        "--entrypoint",
        "node",
        cfg.PA_WORKER_IMAGE ?? "owndesk-worker:0.9.0-dev",
        `/tmp/${file}`,
      ],
      { env: { FIXTURE_KEY: key } }
    )
    await innerDocker(host, ["cp", `tests/fixtures/${file}`, `${container}:/tmp/${file}`])
    await innerDocker(host, ["start", container])
  }
}
async function modelCalls() {
  return JSON.parse(
    (
      await innerDocker(host, [
        "exec",
        `${host.name}-restore-model`,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/state').then(r=>r.text()).then(console.log)",
      ])
    ).stdout.toString()
  )
}
async function submits() {
  return Number(
    (
      await innerDocker(host, [
        "exec",
        `${host.name}-restore-effects`,
        "node",
        "-e",
        "const f='/home/agent/.fixture-effects/submits';const fs=require('node:fs');console.log(fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\\n').length:0)",
      ])
    ).stdout.toString()
  )
}
async function copyProxy() {
  const cfg = await config()
  const filename = path.resolve("deploy/Caddyfile")
  await innerDocker(host, [
    "run",
    "--rm",
    "--network",
    "none",
    "--volume",
    `${path.dirname(filename)}:/config`,
    "--entrypoint",
    "node",
    cfg.PA_WORKER_IMAGE ?? "owndesk-worker:0.9.0-dev",
    "-e",
    `require('node:fs').writeFileSync('/config/Caddyfile',${JSON.stringify(await readFile(filename, "utf8"))})`,
  ])
}

try {
  if (stage === "prepare") {
    configFile = path.resolve(process.env.PA_RESTORE_SOURCE_CONFIG!)
    assert(
      configFile.startsWith(path.resolve("data/experiments") + path.sep),
      "Use the retained isolated deployment fixture, never the main configuration"
    )
    const cfg = await config()
    await loadImages(host, [
      "owndesk-worker:0.9.0-dev",
      "owndesk-web:0.9.0-dev",
      "owndesk-workstation:0.2.0",
      "postgres:16.15-alpine",
      "caddy:2.11.7-alpine",
    ])
    await compose(["stop", "--timeout", "60", "caddy", "web", "worker"])
    await compose(["up", "-d", "--no-build", "--wait", "postgres"])
    await compose(["create", "--no-build", "web", "worker", "caddy"])
    await guard("init")
    const original = JSON.parse(
      await query(
        "SELECT json_build_object('taskId',t.id,'agentId',t.agent_id,'artifactId',a.id,'storagePath',a.storage_path) FROM tasks t JOIN artifacts a ON a.task_id=t.id WHERE t.status='completed' ORDER BY t.created_at LIMIT 1"
      )
    )
    assert(
      original.taskId,
      "First complete the controlled deployment's real artifact task"
    )
    const fixtureKey = randomBytes(24).toString("hex")
    await fixtures(fixtureKey)
    await copyProxy()
    const owner = parseEnv(
      await readFile(path.join(path.dirname(configFile), "owner.env"), "utf8")
    )
    const unknownAgent = randomUUID(),
      pendingAgent = randomUUID(),
      vaultId = randomUUID(),
      routineId = randomUUID()
    const fields = { username: "restore-fixture-owner", password: randomUUID() }
    const memory = `restore-memory-${randomUUID()}`
    const prepared = await code(`
      import {pool} from './db/index.ts';import {setSettings} from './lib/config.ts';import {saveVaultItem} from './lib/vault.ts';import {auth,requireOwner} from './lib/auth.ts';import {issueDesktopTicket} from './lib/desktop.ts';
      await setSettings([{key:'provider.custom.apiKey',value:${JSON.stringify(fixtureKey)}},{key:'provider.custom.baseUrl',value:'http://restore-model:8080/v1'}]);
      await saveVaultItem({id:${JSON.stringify(vaultId)},kind:'login',label:'Restore fixture',origin:'https://restore.example',fields:${JSON.stringify(fields)}});
      await pool.query("UPDATE agents SET model='custom/restore-browser' WHERE id=$1",[${JSON.stringify(original.agentId)}]);
      for(const [id,model] of ${JSON.stringify([
        [unknownAgent, "restore-unknown"],
        [pendingAgent, "restore-pending"],
      ])})await pool.query("INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,$2,'Restore fixture','',$3,'test',now(),now())",[id,model,'custom/'+model]);
      await pool.query("INSERT INTO memories(id,agent_id,content,created_at) VALUES($1,$2,$3,now())",[${JSON.stringify(randomUUID())},${JSON.stringify(original.agentId)},${JSON.stringify(memory)}]);
      await pool.query("INSERT INTO routines(id,name,agent_id,prompt,schedule,time_zone,next_run_at,created_at) VALUES($1,'Restore schedule',$2,'Controlled restore fixture',$3::jsonb,'UTC',now()+interval '1 year',now())",[${JSON.stringify(routineId)},${JSON.stringify(original.agentId)},${JSON.stringify({ kind: "daily", time: "09:00" })}]);
      const owner=(await pool.query('SELECT user_id FROM owners')).rows[0].user_id;
      await pool.query("INSERT INTO telegram_connection(id,owner_id,generation,user_id,chat_id,paired_at) VALUES(1,$1,$2,'123','123',now()) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,user_id='123',chat_id='123',paired_at=now()",[owner,${JSON.stringify(randomUUID())}]);
      const login=await auth.api.signInEmail({body:${JSON.stringify({ email: owner.OWNER_EMAIL, password: owner.OWNER_PASSWORD })},asResponse:true});if(login.status!==200)throw new Error('Fixture login failed');
      const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const identity=await requireOwner(new Headers({Cookie:cookie}));
      const ticket=await issueDesktopTicket(identity,${JSON.stringify(original.agentId)},'watch');await pool.query("UPDATE desktop_tickets SET expires_at=now()+interval '1 day' WHERE token=$1",[ticket.token]);
      console.log('PA_RESULT='+JSON.stringify({ownerId:owner,cookie,ticket}));await pool.end();
    `)
    const home = `pa-${cfg.INSTALL_ID.slice(0, 8)}-home-${original.agentId}`
    const marker = `restore-file-${randomUUID()}`
    await innerDocker(host, [
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${home},dst=/home/agent`,
      "--workdir",
      "/opt/owndesk-controller",
      "--entrypoint",
      "node",
      "owndesk-workstation:0.2.0",
      "--input-type=module",
      "-e",
      `import {chromium} from 'playwright-core';import{writeFile}from'node:fs/promises';const c=await chromium.launchPersistentContext('/home/agent/.config/owndesk-browser',{executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await c.addCookies([{name:'fixture-session',value:'demo',url:'http://93.184.216.8:8081/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,sameSite:'Lax'}]);await c.close();await writeFile('/home/agent/restore-marker.txt',${JSON.stringify(marker)});`,
    ])
    await compose(["up", "-d", "--no-build", "--wait"])
    // End only this test's earlier failed runs through the production cancellation boundary.
    await code(
      `import{pool}from'./db/index.ts';import{requestCancellation}from'./lib/task-control.ts';const old=await pool.query("SELECT id,owner_id FROM tasks WHERE source='restore-fixture' AND status NOT IN ('completed','cancelled','failed')");for(const t of old.rows)await requestCancellation(t.owner_id,t.id);console.log('PA_RESULT='+JSON.stringify({requested:old.rowCount}));await pool.end();`
    )
    await until(
      async () =>
        Number(
          await query(
            "SELECT count(*) FROM tasks WHERE source='restore-fixture' AND status NOT IN ('completed','cancelled','failed')"
          )
        ) === 0,
      "earlier controlled tasks actually cancelled before fresh restore cases"
    )
    const submitted = await code(
      `import{pool}from'./db/index.ts';import{submitTask}from'./lib/tasks.ts';import{closeDurableClient}from'./lib/durable.ts';const result=[];for(const agentId of ${JSON.stringify([unknownAgent, pendingAgent])})result.push(await submitTask(${JSON.stringify(prepared.ownerId)},'restore-fixture',{agentId,goal:'Controlled restore interruption fixture',clientRequestId:crypto.randomUUID()}));console.log('PA_RESULT='+JSON.stringify(result));await closeDurableClient();await pool.end();`
    )
    await until(
      async () =>
        (await submits()) === 1 && (await modelCalls())["restore-pending"] === 1,
      "external submit committed and model reply pending"
    )
    const worker = (await compose(["ps", "-q", "worker"])).stdout.toString().trim()
    await innerDocker(host, ["kill", "--signal", "KILL", worker])
    await innerDocker(host, ["start", worker])
    await until(
      async () =>
        Number(
          await query(
            `SELECT count(*) FROM tasks WHERE status='needs_review' AND agent_id IN ('${unknownAgent}','${pendingAgent}')`
          )
        ) === 2,
      "production recovery waits for both unknown submit and unknown model reply"
    )
    assert.deepEqual(await modelCalls(), { "restore-unknown": 1, "restore-pending": 1 })
    assert.equal(await submits(), 1)
    const cached = await code(
      `import{pool}from'./db/index.ts';import{executeAction}from'./worker/actions.ts';const taskId=${JSON.stringify(submitted[0].taskId)};const a=(await pool.query("SELECT * FROM task_actions WHERE task_id=$1 AND kind='shell'",[taskId])).rows[0];await pool.query("UPDATE task_actions SET status='succeeded',receipt=$2 WHERE task_id=$1 AND kind='shell'",[taskId,JSON.stringify({ok:true,output:{signal:'SIGTERM',exitCode:null,timedOut:false}})]);const r=await executeAction(taskId,a.segment_no,a.action_no,'shell',a.input);console.log('PA_RESULT='+JSON.stringify({needsReview:!!r.needsReview}));await pool.end();`
    )
    assert(cached.needsReview, "Legacy cached interrupted Shell must also require review")
    // A synthetic live grant isolates the database fence; actual filling is covered by vaultfill.
    const grant = await code(
      `import{pool}from'./db/index.ts';import{assertVaultGrant}from'./lib/vault.ts';const agentId=${JSON.stringify(unknownAgent)};await pool.query("UPDATE workstation_control SET mode='agent' WHERE agent_id=$1",[agentId]);const w=(await pool.query('SELECT * FROM workstation_control WHERE agent_id=$1',[agentId])).rows[0];const g={itemId:${JSON.stringify(vaultId)},revision:1,kind:'login',origin:'https://restore.example',agentId,segmentNo:w.active_segment,epoch:w.epoch,bootId:w.boot_id,expiresAt:new Date(Date.now()+86400000).toISOString()};const c=await pool.connect();await assertVaultGrant(c,w.active_task_id,g);c.release();console.log('PA_RESULT='+JSON.stringify(g));await pool.end();`
    )
    await compose(["stop", "--timeout", "60", "caddy", "web", "worker"])
    const before = JSON.parse(
      await query(
        "SELECT json_build_object('tasks',(SELECT json_agg(json_build_object('id',id,'status',status)) FROM tasks),'actionAttempts',(SELECT count(*) FROM task_action_attempts),'modelAttempts',(SELECT count(*) FROM task_model_attempts),'workspaces',(SELECT json_agg(json_build_object('agentId',agent_id,'epoch',epoch)) FROM workstation_control),'requests',(SELECT json_agg(json_build_object('id',id,'status',status)) FROM task_requests),'generation',(SELECT generation FROM telegram_connection))"
      )
    )
    const dataDirectory = path.join(host.directory, "snapshot")
    const keys = path.join(host.directory, "keys.env")
    await snapshot(["backup", configFile, dataDirectory, keys], "backup")
    await snapshot(["verify", keys, dataDirectory], "verify")
    assert.equal((await stat(keys)).mode & 0o777, 0o600)
    assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700)
    checkpoint = {
      sourceHost: host.name,
      sourceConfig: configFile,
      dataDirectory,
      keys,
      original,
      prepared,
      unknownAgent,
      pendingAgent,
      vaultId,
      routineId,
      fields,
      memory,
      marker,
      fixtureKey,
      before,
      grant,
      submitted,
      cookieSeededInControlledProfile: true,
      ticketExpiryExtendedForRestoreTest: true,
    }
    await writeFile(
      path.join(host.directory, "restore-checkpoint.json"),
      JSON.stringify(checkpoint, null, 2) + "\n",
      { mode: 0o600 }
    )
    checks.push({
      check:
        "Real production unknown submit/model request become review waits; offline snapshot preserves DB/artifact/home and separate keys; authenticated file verification passed",
      sourceSubmits: 1,
      sourceModelCalls: await modelCalls(),
      dataDirectory,
      checkpoint: path.join(host.directory, "restore-checkpoint.json"),
    })
  } else {
    const checkpointFile = path.resolve(process.env.PA_RESTORE_CHECKPOINT!)
    assert(checkpointFile.startsWith(path.resolve("data/experiments") + path.sep))
    checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"))
    assert.notEqual(host.name, checkpoint.sourceHost, "Use a different clean Linux host")
    if (stage === "restore") {
      assert.equal(
        (await innerDocker(host, ["ps", "-a", "--format", "{{.ID}}"])).stdout
          .toString()
          .trim(),
        "",
        "Target engine must actually be clean"
      )
      configFile = path.join(host.directory, "restored.env")
      await snapshot(
        ["restore", checkpoint.keys, checkpoint.dataDirectory, configFile],
        "restore"
      )
    } else {
      configFile = path.resolve(process.env.PA_RESTORE_TARGET_CONFIG!)
      assert(configFile.startsWith(path.resolve("data/experiments") + path.sep))
      const receipt = JSON.parse(await readFile(`${configFile}.restore.json`, "utf8"))
      const manifest = JSON.parse(
        await readFile(path.join(checkpoint.dataDirectory, "manifest.json"), "utf8")
      )
      assert.equal(receipt.snapshotId, manifest.snapshotId)
      await snapshot(
        ["verify", checkpoint.keys, checkpoint.dataDirectory],
        "verify-resume"
      )
      const running = (await innerDocker(host, ["ps", "--format", "{{.Names}}"])).stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
      assert.equal(
        running.length,
        1,
        "Resume data validation only while PostgreSQL is the sole running container"
      )
      assert.equal(running[0], `pa-${(await config()).INSTALL_ID}-postgres-1`)
    }
    const after = JSON.parse(
      await query(
        "SELECT json_build_object('tasks',(SELECT json_agg(json_build_object('id',id,'status',status)) FROM tasks),'actionAttempts',(SELECT count(*) FROM task_action_attempts),'modelAttempts',(SELECT count(*) FROM task_model_attempts),'workspaces',(SELECT json_agg(json_build_object('agentId',agent_id,'epoch',epoch,'bootId',boot_id)) FROM workstation_control),'requests',(SELECT json_agg(json_build_object('id',id,'status',status)) FROM task_requests),'generation',(SELECT generation FROM telegram_connection),'sessions',(SELECT count(*) FROM session),'tickets',(SELECT count(*) FROM desktop_tickets),'enabledRoutines',(SELECT count(*) FROM routines WHERE enabled),'pairedUser',(SELECT user_id FROM telegram_connection))"
      )
    )
    for (const field of ["tasks", "requests"])
      assert.deepEqual(
        after[field].sort((a: any, b: any) => a.id.localeCompare(b.id)),
        checkpoint.before[field].sort((a: any, b: any) => a.id.localeCompare(b.id))
      )
    assert.equal(after.actionAttempts, checkpoint.before.actionAttempts)
    assert.equal(after.modelAttempts, checkpoint.before.modelAttempts)
    assert.equal(after.sessions, 0)
    assert.equal(after.tickets, 0)
    assert.equal(after.enabledRoutines, 0)
    assert.equal(after.pairedUser, null)
    assert.notEqual(after.generation, checkpoint.before.generation)
    for (const w of after.workspaces) {
      assert.equal(
        w.epoch,
        checkpoint.before.workspaces.find((old: any) => old.agentId === w.agentId).epoch +
          1
      )
      assert.equal(w.bootId, null)
    }
    const privateCheck = await code(
      `import{pool}from'./db/index.ts';import{decryptSecret}from'./lib/secrets.ts';import{vaultContext,assertVaultGrant}from'./lib/vault.ts';const v=(await pool.query('SELECT * FROM vault_items WHERE id=$1',[${JSON.stringify(checkpoint.vaultId)}])).rows[0];const fields=JSON.parse(decryptSecret(v.secret,vaultContext(v.id,v.kind)));let stale=false;const c=await pool.connect();try{await assertVaultGrant(c,${JSON.stringify(checkpoint.submitted[0].taskId)},${JSON.stringify(checkpoint.grant)})}catch(e){if(e.status!==409)throw e;stale=true}finally{c.release()}const memory=(await pool.query('SELECT content FROM memories WHERE agent_id=$1',[${JSON.stringify(checkpoint.original.agentId)}])).rows.map(r=>r.content);console.log('PA_RESULT='+JSON.stringify({fields,stale,memory}));await pool.end();`
    )
    assert.deepEqual(privateCheck.fields, checkpoint.fields)
    assert(privateCheck.stale)
    assert(privateCheck.memory.includes(checkpoint.memory))
    const cfg = await config()
    const artifact = await innerDocker(host, [
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,src=pa-${cfg.INSTALL_ID}_artifacts,dst=/app/data/artifacts,readonly`,
      "--entrypoint",
      "node",
      cfg.PA_WORKER_IMAGE,
      "-e",
      `console.log(require('node:fs').readFileSync(require('node:path').join('/app/data/artifacts',${JSON.stringify(checkpoint.original.storagePath)}),'utf8'))`,
    ])
    assert.equal(artifact.stdout.toString().trim().split("\n").length, 5)
    assert.equal(
      artifact.stdout
        .toString()
        .trim()
        .split("\n")
        .slice(1)
        .reduce((s, line) => s + Number(line.split(",")[2]), 0),
      620
    )
    checks.push({
      check:
        "Clean separate Linux engine restored all task/request/attempt rows, actual artifact, memories and vault decryption; old sessions/tickets and synthetic live grant invalid; routines paused and Telegram generation revoked",
    })
    await copyProxy()
    await guard("init")
    await fixtures(checkpoint.fixtureKey)
    await compose(["up", "-d", "--no-build", "--wait"])
    const caddy = (await compose(["ps", "-q", "caddy"])).stdout.toString().trim()
    const caFile = path.join(host.directory, "restored-ca.crt")
    await innerDocker(host, [
      "cp",
      `${caddy}:/data/caddy/pki/authorities/local/root.crt`,
      caFile,
    ])
    const ca = await readFile(caFile)
    const origin = cfg.APP_URL
    await until(
      () =>
        new Promise<boolean>((resolve, reject) => {
          https
            .get(`${origin}/login`, { ca }, (res) => {
              res.resume()
              if (res.statusCode === 200) resolve(true)
              else reject(new Error(`HTTPS returned ${res.statusCode}`))
            })
            .on("error", (e) => {
              if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false)
              else reject(e)
            })
        }),
      "restored HTTPS entry with a verified CA"
    )
    const client = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
    const headers = { Origin: origin }
    assert.equal(
      (
        await client.get("/api/settings", {
          headers: { Cookie: checkpoint.prepared.cookie },
        })
      ).status(),
      401
    )
    const owner = parseEnv(
      await readFile(
        path.join(path.dirname(checkpoint.sourceConfig), "owner.env"),
        "utf8"
      )
    )
    assert.equal(
      (
        await client.post("/api/auth/sign-in/email", {
          headers,
          data: { email: owner.OWNER_EMAIL, password: owner.OWNER_PASSWORD },
        })
      ).status(),
      200
    )
    const cookies = (await client.storageState()).cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ")
    const oldTicket = checkpoint.prepared.ticket
    const rejection = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        oldTicket.url,
        ["binary", `pa-token.${oldTicket.token}`],
        { origin, headers: { Cookie: cookies }, ca }
      )
      socket.on("unexpected-response", (_req, res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      socket.on("open", () => {
        socket.terminate()
        reject(new Error("Old desktop ticket was accepted"))
      })
      socket.on("error", reject)
    })
    assert.equal(rejection, 401)
    await until(
      async () =>
        Number(await query("SELECT count(*) FROM tasks WHERE status='needs_review'")) ===
        2,
      "restored production runtime retains unknown review waits"
    )
    const noReplay = JSON.parse(
      await query(
        "SELECT json_build_object('actionAttempts',(SELECT count(*) FROM task_action_attempts),'modelAttempts',(SELECT count(*) FROM task_model_attempts))"
      )
    )
    assert.equal(noReplay.actionAttempts, checkpoint.before.actionAttempts)
    assert.equal(noReplay.modelAttempts, checkpoint.before.modelAttempts)
    assert.deepEqual(await modelCalls(), {})
    assert.equal(await submits(), 0)
    const next = await client.post("/api/tasks", {
      headers,
      data: {
        agentId: checkpoint.original.agentId,
        goal: "Controlled restore: verify existing browser login",
        clientRequestId: randomUUID(),
      },
    })
    assert.equal(next.status(), 202)
    const { taskId } = await next.json()
    await until(async () => {
      const detail = await (await client.get(`/api/tasks/${taskId}`)).json()
      assert(
        !["failed", "needs_review"].includes(detail.status),
        JSON.stringify({ status: detail.status, error: detail.error })
      )
      return detail.status === "completed" && detail
    }, "fresh real browser uses the restored persistent login cookie")
    const marker = await innerDocker(host, [
      "exec",
      `pa-${cfg.INSTALL_ID.slice(0, 8)}-ws-${checkpoint.original.agentId}`,
      "cat",
      "/home/agent/restore-marker.txt",
    ])
    assert.equal(marker.stdout.toString(), checkpoint.marker)
    assert.deepEqual(await modelCalls(), { "restore-browser": 3 })
    assert.equal(await submits(), 0)
    const received = await client.get(`/api/artifacts/${checkpoint.original.artifactId}`)
    assert.equal(received.status(), 200)
    assert.equal((await received.text()).trim(), artifact.stdout.toString().trim())
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.UI_BROWSER_PATH,
    })
    const ui = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      storageState: await client.storageState(),
    })
    const page = await ui.newPage()
    await page.goto(`${origin}/?task=${checkpoint.submitted[0].taskId}`)
    await page.getByRole("heading", { name: "待复核", exact: true }).waitFor()
    await page.screenshot({
      path: path.join(host.directory, "restored-review.png"),
      fullPage: true,
    })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await client.dispose()
    checks.push({
      check:
        "Restarted production Web/worker: old authenticated session and extended-life desktop ticket rejected; both unknown tasks wait without repeated HTTP/action; fresh production tool task with controlled model confirms restored browser cookie and home marker; original artifact still downloadable; mobile review visible",
      newTaskId: taskId,
      controlledProvider: true,
    })
    await compose(["stop", "--timeout", "60", "caddy", "web", "worker"])
  }
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
  await browser?.close()
  const evidence = {
    passed,
    stage,
    directory: host.directory,
    checks,
    recordedAt: new Date().toISOString(),
    applicationVersion: "0.9.0-dev",
    controlledProvider: true,
    realModelJudgmentEvaluated: false,
    actualCloudProviderEvaluated: false,
    ordinaryPublicDnsGatePassed: false,
    mainLocalDeploymentUnchanged: true,
    fullRestoreEvaluated: stage !== "prepare" && passed,
    initialCleanRestoreDirectory:
      configFile && stage !== "prepare" ? path.dirname(configFile) : null,
  }
  await writeFile(
    path.join(host.directory, "result.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  if (passed && stage !== "prepare")
    await writeFile(
      "docs/evidence/restore.json",
      JSON.stringify(evidence, null, 2) + "\n"
    )
  console.log(JSON.stringify(evidence, null, 2))
  await stopLinuxHost(host, false)
}
