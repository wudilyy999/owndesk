import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { lookup } from "node:dns/promises"
import { existsSync, readFileSync } from "node:fs"
import { isIPv4 } from "node:net"

// Run on the Linux Docker host's network namespace, using the trusted worker image.
const mode = process.argv[2]
assert(["init", "check"].includes(mode), "Use network.mjs init|check")
const id = process.env.INSTALL_ID
assert(
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id ?? ""
  ),
  "INSTALL_ID must be a UUID"
)
const prefix = id.slice(0, 8)
const name = `pa-${prefix}-egress`
assert.equal(
  process.env.WORKSTATION_NETWORK,
  name,
  "WORKSTATION_NETWORK must be installation-scoped"
)
const bridge = `pag${prefix}`
const subnet = process.env.PA_GUEST_SUBNET
const [address, mask] = (subnet ?? "").split("/")
assert(
  isIPv4(address) && mask === "24" && address.endsWith(".0"),
  "PA_GUEST_SUBNET must be an IPv4 /24 network"
)
const [a, b] = address.split(".").map(Number)
assert(
  a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
  "Guest subnet must use private IPv4 space"
)
const origin = new URL(process.env.APP_URL)
assert(
  ["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password,
  "APP_URL must be an HTTP(S) origin without credentials"
)
const extra = process.env.PA_CONTROL_IPS?.split(",").filter(Boolean) ?? []
assert(
  extra.every(isIPv4),
  "PA_CONTROL_IPS must contain only comma-separated IPv4 addresses"
)
const controlIPs = [
  ...new Set([
    ...extra,
    ...(await lookup(origin.hostname, { family: 4, all: true })).map(
      ({ address }) => address
    ),
  ]),
].sort()
const outbound = `PA-${prefix}-OUT`
const host = `PA-${prefix}-HOST`
const forbidden = [
  ...new Set([
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "168.63.129.16/32",
    ...controlIPs.map((ip) => `${ip}/32`),
  ]),
]
const rules = [
  ["-o", bridge, "-j", "DROP"],
  ...forbidden.flatMap((range) => [
    ["-d", range, "-j", "DROP"],
    // xt_conntrack's canonical single-address output omits the /32 mask.
    ["-m", "conntrack", "--ctorigdst", range.replace(/\/32$/, ""), "-j", "DROP"],
  ]),
  ["-p", "tcp", "-j", "ACCEPT"],
  ["-p", "udp", "-j", "ACCEPT"],
  ["-j", "DROP"],
]
const hostRules = [
  ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
  ["-j", "DROP"],
]
const reply = [
  "-o",
  bridge,
  "-m",
  "conntrack",
  "--ctstate",
  "RELATED,ESTABLISHED",
  "-j",
  "ACCEPT",
]
function run(program, args) {
  return execFileSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}
function iptables(args) {
  return run("iptables", ["-w", "5", ...args])
}
function chainRules(chain) {
  return iptables(["-S", chain])
    .split("\n")
    .filter((line) => line.startsWith("-A "))
}
assert(
  existsSync("/proc/sys/net/bridge/bridge-nf-call-iptables"),
  "Linux bridge filtering is unavailable; enable br_netfilter on the dedicated host before initialization"
)
assert.equal(
  readFileSync("/proc/sys/net/bridge/bridge-nf-call-iptables", "utf8").trim(),
  "1",
  "Bridge netfilter must be enabled on the Linux host"
)
iptables(["-S", "DOCKER-USER"])
const security = JSON.parse(
  run("docker", ["info", "--format", "{{json .SecurityOptions}} "])
)
assert(
  !security.some((value) => value.includes("rootless")),
  "This profile requires rootful Linux Docker with the iptables backend"
)
const inspected = spawnSync("docker", ["network", "inspect", name], { encoding: "utf8" })
if (inspected.status !== 0) {
  assert(
    mode === "init" && /not found|no such network/i.test(inspected.stderr),
    inspected.stderr
  )
  run("docker", [
    "network",
    "create",
    "--driver",
    "bridge",
    "--subnet",
    subnet,
    "--label",
    `personal-agent.install=${id}`,
    "--label",
    "personal-agent.network-policy=private-v1",
    "--opt",
    `com.docker.network.bridge.name=${bridge}`,
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    name,
  ])
}
const [network] = JSON.parse(run("docker", ["network", "inspect", name]))
assert.equal(network.Labels["personal-agent.install"], id)
assert.equal(network.Labels["personal-agent.network-policy"], "private-v1")
assert.equal(network.Driver, "bridge")
assert.equal(network.EnableIPv6, false)
assert.equal(network.Options["com.docker.network.bridge.name"], bridge)
assert.equal(network.Options["com.docker.network.bridge.enable_icc"], "false")
assert.deepEqual(
  network.IPAM.Config.map((entry) => entry.Subnet),
  [subnet]
)
if (mode === "init") {
  assert.equal(
    Object.keys(network.Containers).length,
    0,
    "Drain guest containers before replacing network policy"
  )
  const saved = run("iptables-save", [])
  for (const chain of [outbound, host]) {
    if (!saved.includes(`:${chain} `)) iptables(["-N", chain])
    iptables(["-F", chain])
  }
  for (const rule of rules) iptables(["-A", outbound, ...rule])
  for (const rule of hostRules) iptables(["-A", host, ...rule])
  for (const [parent, position, jump] of [
    ["INPUT", "1", ["-i", bridge, "-j", host]],
    ["DOCKER-USER", "1", ["-i", bridge, "-j", outbound]],
    ["DOCKER-USER", "2", reply],
  ]) {
    while (chainRules(parent).includes(`-A ${parent} ${jump.join(" ")}`))
      iptables(["-D", parent, ...jump])
    iptables(["-I", parent, position, ...jump])
  }
}
assert.deepEqual(
  chainRules(outbound),
  rules.map((rule) => `-A ${outbound} ${rule.join(" ")}`),
  "Guest forwarding rules differ; stop guests and rerun network init"
)
assert.deepEqual(
  chainRules(host),
  hostRules.map((rule) => `-A ${host} ${rule.join(" ")}`)
)
assert.equal(
  chainRules("DOCKER-USER")[1],
  `-A DOCKER-USER ${reply.join(" ")}`,
  "Established guest replies must precede Docker's cross-bridge isolation"
)
assert.equal(
  chainRules("DOCKER-USER")[0],
  `-A DOCKER-USER -i ${bridge} -j ${outbound}`,
  "Guest forwarding jump must run before other host rules"
)
assert.equal(
  chainRules("INPUT")[0],
  `-A INPUT -i ${bridge} -j ${host}`,
  "Guest-to-host jump must run before other host rules"
)
console.log(
  JSON.stringify({ ready: true, policy: "private-v1", name, bridge, subnet, controlIPs })
)
