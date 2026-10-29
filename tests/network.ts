import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseEnv } from "node:util"
import { DockerError } from "@/lib/docker"
import { innerDocker, linuxHost, stopLinuxHost } from "./helpers/linux-host"

// Focused continuation on the retained, isolated restore target; no model/Internet calls.
assert(process.env.PA_LINUX_HOST_STATE, "Specify a dedicated Linux test host")
assert(process.env.PA_NETWORK_CONFIG, "Specify the isolated restored Compose config")
const host = await linuxHost()
const configFile = path.resolve(process.env.PA_NETWORK_CONFIG)
assert(configFile.startsWith(path.resolve(host.directory, "../") + path.sep))
const cfg = parseEnv(await readFile(configFile, "utf8")) as Record<string, string>
assert(cfg.PA_WORKER_IMAGE && cfg.PA_WEB_IMAGE, "Use pinned restored images")
const prefix = cfg.INSTALL_ID.slice(0, 8)
const checks: Record<string, unknown>[] = []
const fixtures: string[] = []
const addresses: string[] = []
const publicNetwork = `${host.name}-restore-public`
let passed = false
let worker = ""

async function compose(args: string[]) {
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
async function guard(mode: "init" | "check") {
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
      cfg.PA_WORKER_IMAGE,
      "node",
      "scripts/network.mjs",
      mode,
    ],
    { env: cfg, timeoutMs: 30000 }
  )
}
async function hostCommand(program: string, args: string[]) {
  return innerDocker(host, [
    "run",
    "--rm",
    "--network",
    "host",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--entrypoint",
    program,
    cfg.PA_WORKER_IMAGE,
    ...args,
  ])
}
async function code(source: string) {
  return innerDocker(
    host,
    ["exec", worker, "node", "--import", "tsx", "--input-type=module", "-e", source],
    { timeoutMs: 120000 }
  )
}
async function inspect(name: string) {
  return JSON.parse((await innerDocker(host, ["inspect", name])).stdout.toString())[0]
}
async function totals() {
  const postgres = (await compose(["ps", "-q", "postgres"])).stdout.toString().trim()
  return (
    await innerDocker(host, [
      "exec",
      postgres,
      "psql",
      "-X",
      "-At",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "-c",
      "SELECT json_build_object('tasks',(SELECT count(*) FROM tasks),'actions',(SELECT count(*) FROM task_action_attempts),'models',(SELECT count(*) FROM task_model_attempts))",
    ])
  ).stdout
    .toString()
    .trim()
}
async function fixture(
  name: string,
  network: string,
  port: number,
  ip?: string,
  extra: string[] = []
) {
  await innerDocker(host, [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    ...(ip ? ["--ip", ip] : []),
    ...extra,
    "--entrypoint",
    "node",
    cfg.PA_WORKER_IMAGE,
    "-e",
    `require('node:http').createServer((q,r)=>r.end('ready')).listen(${port},'0.0.0.0')`,
  ])
  fixtures.push(name)
}
function probe(address: string, port: number) {
  return `const s=require('node:net').connect(${port},${JSON.stringify(address)});s.setTimeout(1500);s.on('connect',()=>{console.log(JSON.stringify({connected:true}));s.destroy()});s.on('timeout',()=>{console.log(JSON.stringify({connected:false,error:'TIMEOUT'}));s.destroy()});s.on('error',e=>console.log(JSON.stringify({connected:false,error:e.code})));`
}
async function rejects(
  label: string,
  operation: () => Promise<unknown>,
  message: string
) {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof DockerError)
    assert(error.stderr.includes(message), label)
    return true
  })
  await writeFile(
    path.join(host.directory, `${label}.json`),
    JSON.stringify({ rejected: true, expected: message }) + "\n"
  )
}

try {
  const initiallyRunning = (await innerDocker(host, ["ps", "-q", "--no-trunc"])).stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
  const postgres = (await compose(["ps", "-q", "postgres"])).stdout.toString().trim()
  assert.deepEqual(
    initiallyRunning,
    postgres ? [postgres] : [],
    "Retained restore target may run only its PostgreSQL"
  )
  await compose(["up", "-d", "--no-build", "--wait", "postgres"])
  const before = await totals()
  const network = JSON.parse((await guard("init")).stdout.toString())
  await guard("check")
  await compose(["up", "-d", "--no-build", "--wait", "postgres", "web", "worker"])
  worker = (await compose(["ps", "-q", "worker"])).stdout.toString().trim()
  const agents = [randomUUID(), randomUUID(), randomUUID()]
  const names = agents.map((id) => `pa-${prefix}-ws-${id}`)
  await code(
    `import{pool}from'./db/index.ts';import{ensureWorkstation}from'./lib/workstation.ts';for(const id of ${JSON.stringify(agents)}){await pool.query("INSERT INTO agents(id,name,role,glyph,created_at,updated_at) VALUES($1,'Network lifecycle','Isolated check','network',now(),now())",[id])}for(const id of ${JSON.stringify(agents.slice(0, 2))})await ensureWorkstation(id);await pool.end();`
  )
  await innerDocker(host, [
    "exec",
    names[0],
    "sh",
    "-c",
    "printf network-lifecycle > /home/agent/network-lifecycle.txt",
  ])
  await innerDocker(host, [
    "exec",
    "-d",
    names[1],
    "node",
    "-e",
    "require('node:http').createServer((q,r)=>r.end('peer')).listen(8080,'0.0.0.0')",
  ])
  const [publicMeta] = JSON.parse(
    (await innerDocker(host, ["network", "inspect", publicNetwork])).stdout.toString()
  )
  assert.deepEqual(
    publicMeta.IPAM.Config.map((entry: { Subnet: string }) => entry.Subnet),
    ["93.184.216.0/24"]
  )
  assert.equal(
    Object.keys(publicMeta.Containers).length,
    0,
    "Retained controlled public fixture network must be offline"
  )
  assert(cfg.PA_CONTROL_IPS.split(",").includes("93.184.216.9"))
  await fixture(`${host.name}-network-public`, publicNetwork, 8081, "93.184.216.11", [
    "--publish",
    "0.0.0.0::8081/tcp",
  ])
  await fixture(`${host.name}-network-control`, publicNetwork, 8080, "93.184.216.9")
  await fixture(`${host.name}-network-host`, "host", 8080)
  for (const address of ["169.254.169.254", "100.100.100.200", "168.63.129.16"]) {
    await hostCommand("ip", ["addr", "add", `${address}/32`, "dev", "lo"])
    addresses.push(address)
  }
  const gateway = cfg.PA_GUEST_SUBNET.replace(".0/24", ".1")
  const control = `pa-${cfg.INSTALL_ID}_control`
  const endpoints: { name: string; address: string; port: number }[] = []
  for (const [service, port] of [
    ["postgres", 5432],
    ["web", 6797],
    ["worker", 6798],
  ] as const) {
    const id = (await compose(["ps", "-q", service])).stdout.toString().trim()
    endpoints.push({
      name: service,
      port,
      address: (await inspect(id)).NetworkSettings.Networks[control].IPAddress,
    })
  }
  endpoints.push(
    { name: "host-gateway", address: gateway, port: 8080 },
    {
      name: "host-published-port-DNAT",
      address: gateway,
      port: Number(
        (await inspect(`${host.name}-network-public`)).NetworkSettings.Ports[
          "8081/tcp"
        ][0].HostPort
      ),
    },
    {
      name: "peer-workstation",
      address: (await inspect(names[1])).NetworkSettings.Networks[cfg.WORKSTATION_NETWORK]
        .IPAddress,
      port: 8080,
    },
    ...[...addresses, "93.184.216.9"].map((address) => ({
      name: address,
      address,
      port: 8080,
    }))
  )
  const results = []
  for (const endpoint of endpoints) {
    const positive = JSON.parse(
      (
        await hostCommand("node", ["-e", probe(endpoint.address, endpoint.port)])
      ).stdout.toString()
    )
    assert.equal(positive.connected, true, `Live positive control: ${endpoint.name}`)
    const negative = JSON.parse(
      (
        await innerDocker(host, [
          "exec",
          names[0],
          "node",
          "-e",
          probe(endpoint.address, endpoint.port),
        ])
      ).stdout.toString()
    )
    results.push({ endpoint, positive, negative })
    await writeFile(
      path.join(host.directory, "network-probes.json"),
      JSON.stringify(results, null, 2) + "\n"
    )
    assert.equal(negative.connected, false, `Guest reached ${endpoint.name}`)
  }
  assert.equal(
    (
      await innerDocker(host, [
        "exec",
        names[0],
        "curl",
        "-fsS",
        "--max-time",
        "5",
        "http://93.184.216.11:8081/",
      ])
    ).stdout.toString(),
    "ready"
  )
  const meta = await inspect(names[0])
  const viewer = await inspect(`pa-${prefix}-viewer-${agents[0]}`)
  assert.deepEqual(meta.HostConfig.Dns, [cfg.PA_GUEST_DNS])
  assert(meta.HostConfig.CapDrop.includes("CAP_NET_RAW"))
  assert.equal(meta.HostConfig.Sysctls["net.ipv6.conf.all.disable_ipv6"], "1")
  assert.equal(Object.keys(meta.HostConfig.PortBindings ?? {}).length, 0)
  assert(!meta.Mounts.some((m: any) => m.Destination === "/var/run/docker.sock"))
  assert(
    !meta.Config.Env.some((v: string) =>
      /^(MASTER_KEY|DATABASE_URL|BETTER_AUTH_SECRET)=/.test(v)
    )
  )
  assert.equal(viewer.HostConfig.NetworkMode, "none")
  checks.push({
    check:
      "Actual guest blocks live DB/Web/worker/host/peer/metadata/control alias with positive host controls; controlled public fixture allowed; guest/viewer restrictions verified",
    probes: results.length,
    ordinaryInternetEvaluated: false,
  })
  await rejects("live-init", () => guard("init"), "Drain guest containers")

  // A privileged host administrator can tamper; checks gate new provisioning/startup.
  // No claim of continuous enforcement against root is made.
  for (const [label, args, message] of [
    ["outbound-rule", ["-D", `PA-${prefix}-OUT`, "1"], "Guest forwarding rules differ"],
    [
      "forward-precedence",
      ["-I", "DOCKER-USER", "1", "-j", "RETURN"],
      "Established guest replies",
    ],
    ["input-precedence", ["-I", "INPUT", "1", "-j", "RETURN"], "Guest-to-host jump"],
  ] as const) {
    await hostCommand("iptables", ["-w", "5", ...args])
    await rejects(`${label}-check`, () => guard("check"), message)
    await rejects(
      `${label}-provision`,
      () =>
        code(
          `import{ensureWorkstation}from'./lib/workstation.ts';await ensureWorkstation(${JSON.stringify(agents[2])});`
        ),
      message
    )
    await assert.rejects(inspect(names[2]), DockerError)
    if (label === "outbound-rule") {
      await compose(["stop", "worker"])
      await rejects(
        "worker-startup",
        () => compose(["run", "--rm", "--no-deps", "worker"]),
        message
      )
      // The real worker is down; use its normal image/env for the drain entry point.
      await compose([
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
        "import{stopInstallationWorkstations}from'./lib/workstation.ts';import{pool}from'./db/index.ts';await stopInstallationWorkstations();await pool.end();",
      ])
    } else {
      await code(
        "import{stopInstallationWorkstations}from'./lib/workstation.ts';import{pool}from'./db/index.ts';await stopInstallationWorkstations();await pool.end();"
      )
      await compose(["stop", "worker"])
    }
    if (label === "forward-precedence")
      await hostCommand("iptables", ["-w", "5", "-D", "DOCKER-USER", "-j", "RETURN"])
    if (label === "input-precedence")
      await hostCommand("iptables", ["-w", "5", "-D", "INPUT", "-j", "RETURN"])
    await guard("init")
    await guard("check")
    await compose(["up", "-d", "--no-build", "--wait", "worker"])
    worker = (await compose(["ps", "-q", "worker"])).stdout.toString().trim()
    await code(
      `import{ensureWorkstation}from'./lib/workstation.ts';import{pool}from'./db/index.ts';await ensureWorkstation(${JSON.stringify(agents[0])});await pool.end();`
    )
    assert.equal(
      (
        await innerDocker(host, [
          "exec",
          names[0],
          "cat",
          "/home/agent/network-lifecycle.txt",
        ])
      ).stdout.toString(),
      "network-lifecycle"
    )
    checks.push({
      check: `${label}: check/provisioning rejected tamper; drained, explicitly reinitialized and resumed workstation with home retained`,
    })
  }
  await code(
    `import{ensureWorkstation}from'./lib/workstation.ts';import{pool}from'./db/index.ts';await ensureWorkstation(${JSON.stringify(agents[2])});await pool.end();`
  )
  assert((await inspect(names[2])).State.Running)
  assert.equal(
    await totals(),
    before,
    "Network-only checks must not run task/model/action attempts"
  )
  const counters = await hostCommand("iptables-save", ["-c"])
  await writeFile(
    path.join(host.directory, "iptables-with-counters.txt"),
    counters.stdout
  )
  checks.push({
    check:
      "New workstation succeeds only after repair; existing task/model/action counts unchanged",
    counts: JSON.parse(before),
  })
  passed = true
} catch (error) {
  await writeFile(path.join(host.directory, "failure.txt"), String(error))
  throw error
} finally {
  const logs = await compose(["logs", "--no-color"])
  await writeFile(
    path.join(host.directory, "stack.log"),
    logs.stdout.toString() + logs.stderr
  )
  await compose(["stop", "--timeout", "60"])
  for (const name of fixtures) await innerDocker(host, ["rm", "--force", name])
  for (const address of addresses)
    await hostCommand("ip", ["addr", "del", `${address}/32`, "dev", "lo"])
  const report = {
    passed,
    scope: "controlled-restored-linux-guest-network-and-policy-lifecycle",
    directory: host.directory,
    checks,
    recordedAt: new Date().toISOString(),
    applicationVersion: "0.9.0-dev",
    ordinaryPublicDnsEvaluated: false,
    actualCloudProviderEvaluated: false,
    realModelJudgmentEvaluated: false,
    modelCallsInitiated: 0,
    continuousRootTamperDefense: false,
    mainLocalDeploymentUnchanged: true,
  }
  const json = JSON.stringify(report, null, 2) + "\n"
  await writeFile(path.join(host.directory, "result.json"), json)
  await writeFile("docs/evidence/network-lifecycle-attempt.json", json)
  if (passed) await writeFile("docs/evidence/network-lifecycle.json", json)
  console.log(json)
  await stopLinuxHost(host, false)
}
