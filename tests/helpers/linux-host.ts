import assert from "node:assert/strict"
import { mkdir, chmod, readdir, readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { docker, dockerRaw, type RunOptions } from "@/lib/docker"

export type LinuxHost = {
  kind?: "colima"
  context?: string
  httpPort?: string
  name: string
  directory: string
  outerNetwork: string
  volumes: string[]
  dockerPort: string
  httpsPort: string
}

export function hostEnvironment(host: LinuxHost) {
  if (host.kind === "colima")
    return {
      DOCKER_CONTEXT: host.context!,
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
    }
  return {
    DOCKER_CONTEXT: "",
    DOCKER_HOST: `tcp://127.0.0.1:${host.dockerPort}`,
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: path.join(host.directory, "certs"),
  }
}

export function innerDocker(host: LinuxHost, args: string[], options: RunOptions = {}) {
  return docker(args, {
    ...options,
    env: { ...hostEnvironment(host), ...options.env },
  })
}

export async function linuxHost(
  // nft: make the daemon program iptables-nft even when the outer host has legacy
  // tables (the worker's guard reads DOCKER-USER with Debian's iptables-nft)
  options: { memory?: string; nft?: boolean } = {}
): Promise<LinuxHost> {
  let host: LinuxHost
  if (process.env.PA_LINUX_HOST_STATE) {
    host = JSON.parse(await readFile(process.env.PA_LINUX_HOST_STATE, "utf8"))
  } else {
    const name = `pa-linux-${Date.now()}`
    const directory = path.resolve("data/experiments", name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await docker([
      "network",
      "create",
      "--label",
      "personal-agent.experiment=P7",
      `${name}-outer`,
    ])
    await docker([
      "run",
      "-d",
      "--privileged",
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      "personal-agent.experiment=P7",
      "--network",
      `${name}-outer`,
      "--cpus",
      "2",
      "--memory",
      options.memory ?? "3g",
      "--env",
      "DOCKER_TLS_CERTDIR=/certs",
      ...(options.nft ? ["--env", "DOCKER_IPTABLES_LEGACY="] : []),
      "--publish",
      "127.0.0.1::2376/tcp",
      "--publish",
      "127.0.0.1::443/tcp",
      "--volume",
      `${name}-docker:/var/lib/docker`,
      "--volume",
      `${name}-certs:/certs`,
      "docker:29.7.2-dind",
      "--storage-driver=overlay2",
    ])
    const [container] = JSON.parse((await docker(["inspect", name])).stdout.toString())
    host = {
      name,
      directory,
      outerNetwork: `${name}-outer`,
      volumes: [`${name}-docker`, `${name}-certs`],
      dockerPort: container.NetworkSettings.Ports["2376/tcp"][0].HostPort,
      httpsPort: container.NetworkSettings.Ports["443/tcp"][0].HostPort,
    }
    await writeFile(
      path.join(directory, "host.json"),
      JSON.stringify(host, null, 2) + "\n",
      { mode: 0o600 }
    )
  }
  assert(/^pa-linux-\d+$/.test(host.name))
  if (host.kind === "colima") {
    assert.equal(host.context, `colima-${host.name}`)
    await innerDocker(host, ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 15000,
    })
    host.directory = path.join(host.directory, `attempt-${Date.now()}`)
    await mkdir(host.directory, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(host.directory, "host.json"),
      JSON.stringify(host, null, 2) + "\n",
      { mode: 0o600 }
    )
    return host
  }
  const [container] = JSON.parse((await docker(["inspect", host.name])).stdout.toString())
  assert.equal(container.Config.Labels["personal-agent.experiment"], "P7")
  assert(container.State.Running, "The specified Linux test host is no longer running")
  const certs = path.join(host.directory, "certs")
  await mkdir(certs, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 90000
  while (true) {
    // key.pem appears before the client certificate is signed; wait for all three
    const ready = await dockerRaw([
      "exec",
      host.name,
      "sh",
      "-c",
      "test -s /certs/client/key.pem && test -s /certs/client/cert.pem && test -s /certs/client/ca.pem",
    ])
    if (ready.exitCode === 0) break
    assert(Date.now() < deadline, "Linux host TLS certificates did not become ready")
    await delay(250)
  }
  await docker(["cp", `${host.name}:/certs/client/.`, certs])
  for (const file of await readdir(certs)) await chmod(path.join(certs, file), 0o600)
  while (true) {
    const result = await dockerRaw(["info", "--format", "{{.ServerVersion}}"], {
      env: hostEnvironment(host),
      timeoutMs: 3000,
    })
    if (result.exitCode === 0) break
    assert(Date.now() < deadline, "Linux Docker API did not become reachable")
    await delay(250)
  }
  return host
}

export async function loadImages(host: LinuxHost, images: string[]) {
  const changed: string[] = []
  for (const image of images) {
    const source = (
      await docker(["image", "inspect", "--format", "{{.Id}}", image])
    ).stdout
      .toString()
      .trim()
    const destination = await dockerRaw(
      ["image", "inspect", "--format", "{{.Id}}", image],
      { env: hostEnvironment(host) }
    )
    if (destination.exitCode === 0 && destination.stdout.toString().trim() === source)
      continue
    if (destination.exitCode !== 0)
      assert(/no such image|not found/i.test(destination.stderr), destination.stderr)
    changed.push(image)
  }
  if (!changed.length) return
  const file = path.join(host.directory, "images.tar")
  await docker(["save", "--output", file, ...changed], { timeoutMs: 240000 })
  const loaded = await innerDocker(host, ["load", "--input", file], { timeoutMs: 240000 })
  await writeFile(path.join(host.directory, "loaded-images.log"), loaded.stdout)
  await unlink(file)
}

export async function stopLinuxHost(host: LinuxHost, removeData: boolean) {
  if (host.kind === "colima") {
    const stopped = await promisify(execFile)(
      "colima",
      ["--profile", host.name, "stop"],
      { timeout: 120000 }
    )
    await writeFile(
      path.join(host.directory, "vm-stop.log"),
      stopped.stdout + stopped.stderr
    )
    if (removeData)
      await promisify(execFile)("colima", ["--profile", host.name, "delete", "--force"], {
        timeout: 120000,
      })
    return
  }
  const logs = await dockerRaw(["logs", host.name])
  await writeFile(
    path.join(host.directory, "docker-host.log"),
    logs.stdout.toString() + logs.stderr
  )
  await docker(["rm", "--force", host.name], { timeoutMs: 30000 })
  assert.equal(host.outerNetwork, `${host.name}-outer`)
  await docker(["network", "rm", host.outerNetwork])
  if (removeData) {
    assert.deepEqual(host.volumes, [`${host.name}-docker`, `${host.name}-certs`])
    await docker(["volume", "rm", ...host.volumes], { timeoutMs: 30000 })
  }
}
