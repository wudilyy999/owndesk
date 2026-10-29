import { docker } from "@/lib/docker"
import { env } from "@/lib/env"

export async function assertWorkstationNetwork() {
  if (!env.NETWORK_GUARD_IMAGE) return
  await docker(
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
      ]
        .filter((name) => process.env[name] !== undefined)
        .flatMap((name) => ["--env", name]),
      env.NETWORK_GUARD_IMAGE,
      "node",
      "scripts/network.mjs",
      "check",
    ],
    { timeoutMs: 30000, maxOutputBytes: 16384 }
  )
}
