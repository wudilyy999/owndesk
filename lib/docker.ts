import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Duplex } from "node:stream"

// OwnDesk drives Docker through the docker command itself, so whatever it is
// pointed at (Docker Desktop, Docker Engine, Colima, OrbStack, a context)
// just works, and there is no extra client library to keep in step.

export class DockerError extends Error {
  name = "DockerError"
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message)
  }
}

export class DockerOutputLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Docker output exceeded ${limit} bytes`)
  }
}

export class DockerMissingError extends Error {
  name = "DockerMissingError"
  constructor() {
    super(
      "Docker CLI is unavailable. Install Docker Engine or Docker Desktop, then restart the worker."
    )
  }
}

const programFiles = process.env.ProgramFiles || "C:\\Program Files"

const DESKTOP_APP =
  process.platform === "win32"
    ? path.join(programFiles, "Docker", "Docker", "Docker Desktop.exe")
    : process.platform === "darwin"
      ? "/Applications/Docker.app"
      : null

// Where the CLI lives when the server was started before Docker was on PATH
const FALLBACK_BINARIES =
  process.platform === "win32"
    ? [path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")]
    : process.platform === "darwin"
      ? [
          "/usr/local/bin/docker",
          "/opt/homebrew/bin/docker",
          "/Applications/Docker.app/Contents/Resources/bin/docker",
        ]
      : ["/usr/bin/docker", "/usr/local/bin/docker"]

type Result = { exitCode: number | null; stdout: Buffer; stderr: string }

export type RunOptions = {
  input?: string | Buffer
  timeoutMs?: number
  maxOutputBytes?: number
  // Called with each line of output as it arrives (builds)
  onLine?: (line: string) => void
  env?: Record<string, string>
}

const globalForDocker = globalThis as unknown as {
  __owndeskDocker?: {
    binary: string | null
    engine: { at: number; value: EngineState } | null
    probing: Promise<EngineState> | null
    starting: Promise<EngineState> | null
  }
}
const shared = (globalForDocker.__owndeskDocker ??= {
  binary: null,
  engine: null,
  probing: null,
  starting: null,
})

function spawnOnce(binary: string, args: string[], options: RunOptions) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let pending = ""
    let outputBytes = 0,
      outputError: Error | undefined
    const accept = (chunk: Buffer) => {
      if (outputError) return false
      outputBytes += chunk.length
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        outputError = new DockerOutputLimitError(options.maxOutputBytes)
        child.kill("SIGKILL")
        return false
      }
      return true
    }
    const lines = (chunk: Buffer) => {
      if (!options.onLine) return
      pending += chunk.toString("utf8")
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ""
      for (const line of parts) if (line.trim()) options.onLine(line)
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (!accept(chunk)) return
      stdout.push(chunk)
      lines(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (!accept(chunk)) return
      stderr.push(chunk)
      lines(chunk)
    })

    const timer = options.timeoutMs
      ? setTimeout(() => child.kill(), options.timeoutMs)
      : null
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer)
      if (pending.trim()) options.onLine?.(pending)
      if (outputError) {
        reject(outputError)
        return
      }
      resolve({
        exitCode: signal ? null : exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

// Runs `docker <args>` and reports how it went, whatever the exit code
export async function dockerRaw(args: string[], options: RunOptions = {}) {
  if (shared.binary) {
    try {
      return await spawnOnce(shared.binary, args, options)
    } catch (error) {
      if (!isMissing(error)) throw error
      shared.binary = null
    }
  }
  for (const binary of ["docker", ...FALLBACK_BINARIES]) {
    if (binary !== "docker" && !fs.existsSync(binary)) continue
    try {
      const result = await spawnOnce(binary, args, options)
      shared.binary = binary
      return result
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  throw new DockerMissingError()
}

// The most useful line of what Docker printed when something failed
export function dockerReason(stderr: string) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines.findLast((l) => /error/i.test(l)) ?? lines.at(-1) ?? ""
  return line.replace(/^Error( response from daemon)?:\s*/i, "")
}

// Runs `docker <args>` and throws unless it succeeded
export async function docker(args: string[], options: RunOptions = {}) {
  const result = await dockerRaw(args, options)
  if (result.exitCode !== 0) {
    throw new DockerError(
      dockerReason(result.stderr) ||
        (result.exitCode === null
          ? `docker ${args[0]} timed out`
          : `docker ${args[0]} exited with ${result.exitCode}`),
      result.exitCode,
      result.stderr
    )
  }
  return result
}

// Interactive exec keeps bytes on Docker's authenticated transport, without a guest port.
export async function dockerStream(args: string[]): Promise<Duplex> {
  if (!shared.binary)
    await docker(["version", "--format", "{{.Client.Version}}"], { timeoutMs: 15000 })
  const child = spawn(shared.binary!, args, { windowsHide: true })
  const stream = new Duplex({
    read() {
      child.stdout.resume()
    },
    write(chunk, encoding, callback) {
      child.stdin.write(chunk, encoding, callback)
    },
    final(callback) {
      child.stdin.end(callback)
    },
    destroy(error, callback) {
      // Deliver EOF to the remote relay before terminating an unresponsive local CLI.
      child.stdin.end()
      child.stdout.destroy()
      if (child.exitCode === null && child.signalCode === null) {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 1000).unref()
        child.once("close", () => clearTimeout(timeout))
      }
      callback(error)
    },
  })
  child.stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) child.stdout.pause()
  })
  child.stdout.once("error", (error) => stream.destroy(error))
  child.stdin.once("error", (error) => stream.destroy(error))
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  })
  child.once("error", (error) => stream.destroy(error))
  child.once("close", (code) => {
    if (code === 0) stream.push(null)
    else if (!stream.destroyed)
      stream.destroy(
        new DockerError(dockerReason(stderr) || "Docker stream closed", code, stderr)
      )
  })
  return stream
}

/* ───────────────────────────── engine ───────────────────────────── */

export type EngineState =
  | { state: "missing" }
  | { state: "stopped"; canStart: boolean; detail: string }
  | { state: "ready"; version: string; os: string; cpus: number; memoryBytes: number }

const STALE_MS = 15_000

export function probeEngine(): Promise<EngineState> {
  shared.probing ??= (async (): Promise<EngineState> => {
    try {
      const { exitCode, stdout, stderr } = await dockerRaw(
        [
          "info",
          "--format",
          "{{.ServerVersion}}\t{{.OperatingSystem}}\t{{.NCPU}}\t{{.MemTotal}}",
        ],
        { timeoutMs: 20_000 }
      )
      const [version, os, cpus, memory] = stdout.toString("utf8").trim().split("\t")
      if (exitCode === 0 && version) {
        return {
          state: "ready",
          version,
          os,
          cpus: Number(cpus) || 0,
          memoryBytes: Number(memory) || 0,
        }
      }
      return {
        state: "stopped",
        canStart: !!DESKTOP_APP && fs.existsSync(DESKTOP_APP),
        detail: dockerReason(stderr) || "Docker isn't running.",
      }
    } catch (error) {
      if (error instanceof DockerMissingError) return { state: "missing" }
      throw error
    }
  })()
    .then((value) => {
      shared.engine = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      shared.probing = null
    })
  return shared.probing
}

// What was last seen, without waiting. Looks again in the background when
// the answer is getting old.
export function engineSnapshot(): EngineState | null {
  if (!shared.engine || Date.now() - shared.engine.at > STALE_MS) {
    probeEngine().catch((error) => console.error("Docker engine probe failed", error))
  }
  return shared.engine?.value ?? null
}

function launchDesktopApp() {
  if (!DESKTOP_APP) return false
  if (process.platform === "win32") {
    spawn(DESKTOP_APP, [], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  } else {
    spawn("open", ["-a", DESKTOP_APP], { detached: true, stdio: "ignore" }).unref()
  }
  return true
}

// Docker running, starting Docker Desktop and waiting for it if necessary
export function ensureEngine(
  timeoutMs = 150_000
): Promise<EngineState & { state: "ready" }> {
  const existing = shared.starting
  const task =
    existing ??
    (async () => {
      let engine = await probeEngine()
      if (engine.state === "ready") return engine
      if (engine.state === "missing") throw new DockerMissingError()
      if (!engine.canStart) {
        throw new Error(
          process.platform === "linux"
            ? "Docker isn't running. Start it with `sudo systemctl start docker`."
            : `Docker isn't running: ${engine.detail}`
        )
      }
      launchDesktopApp()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        engine = await probeEngine()
        if (engine.state === "ready") return engine
      }
      throw new Error("Docker Desktop didn't start in time. Open it, then try again.")
    })().finally(() => {
      shared.starting = null
    })
  shared.starting = task
  return task as Promise<EngineState & { state: "ready" }>
}
