import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID, randomBytes, createHash } from "node:crypto"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startWorkstationGate } from "../scripts/workstation-gate.mjs"
async function run(args, env = {}, input) {
  return new Promise((ok, fail) => {
    const p = spawn("docker", args, { env: { ...process.env, ...env } }),
      a = [],
      b = []
    p.on("error", fail)
    p.stdout.on("data", (v) => a.push(v))
    p.stderr.on("data", (v) => b.push(v))
    p.stdin.on("error", () => {})
    p.stdin.end(input)
    const t = setTimeout(() => p.kill(), 90000)
    p.once("close", (code) => {
      clearTimeout(t)
      ok({ code, buf: Buffer.concat(a), err: Buffer.concat(b).toString() })
    })
  })
}
const real = async (...args) => {
  const r = await run(args)
  assert.equal(r.code, 0, r.err)
  return r.buf.toString().trim()
}
const install = randomUUID(),
  owner = randomUUID(),
  stack = "ws-" + install,
  ref = process.env.WORKSTATION_IMAGE || "owndesk-workstation:0.7.0",
  image = await real("image", "inspect", "-f", "{{.Id}}", ref),
  network = "ws-gate-" + install,
  prefix = "pa-" + install.slice(0, 8),
  agent = "fixture",
  name = prefix + "-ws-" + agent,
  home = prefix + "-home-" + agent,
  display = prefix + "-display-" + agent,
  labels = [
    "--label",
    "personal-agent.install=" + install,
    "--label",
    "personal-agent.agent=" + agent,
  ]
const root = await mkdtemp(path.join(os.tmpdir(), "owndesk-gate-"))
await real(
  "network",
  "create",
  "--internal",
  "--opt",
  "com.docker.network.bridge.gateway_mode_ipv4=isolated",
  network
)
let gate
try {
  gate = await startWorkstationGate({
    install,
    owner,
    stack,
    image,
    ref,
    network,
    agents: [agent],
    host: "127.0.0.1",
  })
  const env = {
    DOCKER_HOST: gate.host,
    DOCKER_CUSTOM_HEADERS: "X-OwnDesk-Session=" + gate.token,
    DOCKER_TLS_VERIFY: "",
    DOCKER_CONTEXT: "",
  }
  const call = async (args, input) => {
    const r = await run(args, env, input)
    assert.equal(r.code, 0, r.err)
    return r.buf
  }
  for (const v of [home, display]) await call(["volume", "create", ...labels, v])
  console.log("PASS named private volumes")
  const args = [
    "create",
    "--name",
    name,
    ...labels,
    "--label",
    "personal-agent.protocol=6",
    "--hostname",
    "workstation",
    "--env",
    "PA_WORKSPACE_TOKEN=" + randomBytes(32).toString("hex"),
    "--env",
    "OWNDESK_VNC_PASSWORD=" + randomBytes(6).toString("base64"),
    "--env",
    "OWNDESK_IDLE_MINUTES=0",
    "--volume",
    home + ":/home/agent",
    "--volume",
    display + ":/tmp/.X11-unix",
    "--shm-size",
    "1g",
    "--cpus",
    "1",
    "--memory",
    "1024m",
    "--network",
    network,
    "--dns",
    "127.0.0.1",
    "--cap-drop",
    "CAP_NET_RAW",
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl",
    "net.ipv6.conf.default.disable_ipv6=1",
    ref,
  ]
  for (const invalid of [["--privileged"], ["-v", "/:/host"]]) {
    const r = await run([...args.slice(0, 1), ...invalid, ...args.slice(1)], env)
    assert.notEqual(r.code, 0)
    assert.match(r.err, /refused/i)
    assert.equal(
      await real("ps", "-aq", "--filter", "label=owndesk.lab.stack=" + stack),
      ""
    )
  }
  const foreign = await real("create", "--network", "none", "--entrypoint", "true", ref)
  try {
    const denied = await run(["start", foreign], env)
    assert.notEqual(denied.code, 0)
    assert.equal(await real("inspect", "-f", "{{.State.Running}}", foreign), "false")
    const noToken = await fetch(gate.host.replace("tcp:", "http:") + "/_ping")
    assert.equal(noToken.status, 403)
    const changed = await run([...args.slice(0, -1), "postgres:16.15-alpine"], env)
    assert.notEqual(changed.code, 0)
    console.log("PASS other container, other image and unauthenticated client refused")
  } finally {
    await real("rm", "-v", foreign)
  }
  await call(args)
  await call(["start", name])
  await call(["exec", name, "owndesk-ready"])
  const health = JSON.parse(
    (
      await call(["exec", name, "curl", "-fsS", "http://127.0.0.1:6079/health"])
    ).toString()
  )
  assert.equal(health.protocolVersion, 6)
  console.log(
    "PASS real fixed-image desktop healthy; privileged/host mount denied before create"
  )
  const text = "B2-" + randomUUID()
  const stdin = await call(["exec", "-i", name, "cat"], text)
  assert.equal(stdin.toString(), text)
  console.log("PASS bidirectional exec")
  const controller = async (route, b) =>
    JSON.parse(
      (
        await call(
          ["exec", "-i", name, "node", "/opt/owndesk-controller/request.mjs", route],
          JSON.stringify(b)
        )
      ).toString()
    )
  await controller("/control", { epoch: 1, mode: "agent" })
  await controller("/desktop_open_application", { epoch: 1, application: "Mousepad" })
  const view = await controller("/screen_capture", { epoch: 1 })
  assert.equal(view.screenshot_status, "ok")
  const screenshot = Buffer.from(view.image ?? view.screenshot ?? "", "base64")
  assert(
    screenshot.subarray(0, 2).equals(Buffer.from([255, 216])) ||
      screenshot.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    Object.keys(view).join(",")
  )
  console.log(
    "PASS controller opened Mousepad and captured real desktop",
    screenshot.length,
    createHash("sha256").update(screenshot).digest("hex")
  )
  await writeFile(path.join(root, "from.txt"), text)
  await call(["cp", path.join(root, "from.txt"), name + ":/home/agent/from.txt"])
  await call(["cp", name + ":/home/agent/from.txt", path.join(root, "back.txt")])
  assert.equal(await readFile(path.join(root, "back.txt"), "utf8"), text)
  const viewer = prefix + "-viewer-" + agent
  await call([
    "create",
    "--name",
    viewer,
    ...labels,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--volume",
    display + ":/tmp/.X11-unix:ro",
    "--env",
    "OWNDESK_VNC_PASSWORD=abcdefgh",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--network",
    "none",
    "--entrypoint",
    "/usr/bin/tini",
    ref,
    "--",
    "/bin/bash",
    "/usr/local/bin/pa-viewer",
  ])
  await call(["start", viewer])
  assert.equal(
    await real(
      "inspect",
      "-f",
      "{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Image}}",
      viewer
    ),
    "none true " + image
  )
  await call(["rm", "-f", viewer])
  console.log("PASS fixed read-only viewer, isolated network, exact image")
  await call(["rm", "-f", name])
  for (const v of [home, display]) await call(["volume", "rm", v])
  console.log("PASS cp bytes and removal within candidate namespace")
} finally {
  await gate?.close()
  for (const id of (
    await real("ps", "-aq", "--filter", "label=owndesk.lab.stack=" + stack)
  )
    .split(/\s+/)
    .filter(Boolean))
    await real("rm", "-fv", id)
  for (const v of (
    await real("volume", "ls", "-q", "--filter", "label=owndesk.lab.stack=" + stack)
  )
    .split(/\s+/)
    .filter(Boolean))
    await real("volume", "rm", v)
  await real("network", "rm", network)
  await rm(root, { recursive: true, force: true })
}
