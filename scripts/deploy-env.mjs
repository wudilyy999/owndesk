import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { generateVapidKeys } from "./vapid-keys.mjs"

const [address, email, directory] = process.argv.slice(2)
assert(
  address && email && directory,
  "Use deploy-env.mjs https://host owner@example.com output-directory"
)
const url = new URL(address)
assert.equal(url.protocol, "https:", "Deployment requires HTTPS")
assert(
  !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "Use an origin without a path or credentials"
)
assert(
  /^[a-zA-Z0-9.-]+$/.test(url.hostname),
  "The initial Linux profile uses an IPv4 host name"
)
assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Provide the owner's email")
const paths = [".env", "owner.env"].map((name) => path.resolve(directory, name))
assert(
  paths.every((file) => !existsSync(file)),
  "Preserve existing deployment keys; initialization requires new files"
)
mkdirSync(directory, { recursive: true, mode: 0o700 })
const id = randomUUID()
const databasePassword = randomBytes(24).toString("hex")
const vapid = generateVapidKeys()
const gateway = new URL("/desktop", url)
gateway.protocol = "wss:"
const config = {
  INSTALL_ID: id,
  PA_WEB_IMAGE: "owndesk-web:0.17.0-dev",
  PA_WORKER_IMAGE: "owndesk-worker:0.17.0-dev",
  PA_WORKSTATION_IMAGE: "owndesk-workstation:0.7.0",
  APP_URL: url.origin,
  APP_HOSTNAME: url.hostname,
  PA_BIND_IP: "127.0.0.1",
  PA_HTTP_PORT: "80",
  PA_HTTPS_PORT: url.port || "443",
  DATABASE_URL: `postgresql://agent:${databasePassword}@postgres:5432/personal_agent`,
  POSTGRES_PASSWORD: databasePassword,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  MASTER_KEY: randomBytes(32).toString("hex"),
  // Web notifications (docs/push.md): keep these across upgrades or every phone must allow again
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  DESKTOP_GATEWAY_URL: gateway.toString(),
  WORKSTATION_NETWORK: `pa-${id.slice(0, 8)}-egress`,
  PA_GUEST_SUBNET: "172.30.223.0/24",
  PA_CONTROL_IPS: "",
  PA_GUEST_DNS: "1.1.1.1",
  WORKSTATION_CPUS: "2",
  WORKSTATION_MEMORY_MB: "4096",
  WORKSTATION_IDLE_MINUTES: "15",
  // Lets the worker start the updater (version switch / rollback) against this directory
  PA_DEPLOY_DIR: path.resolve(directory),
}
writeFileSync(
  paths[0],
  Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n",
  { flag: "wx", mode: 0o600 }
)
writeFileSync(
  paths[1],
  `OWNER_EMAIL=${email}\nOWNER_PASSWORD=${randomBytes(24).toString("base64url")}\n`,
  { flag: "wx", mode: 0o600 }
)
console.log(
  "Deployment and separate owner bootstrap files created with mode 600. Secrets were not printed."
)
