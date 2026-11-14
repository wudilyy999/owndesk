// The lab: containers with no network, no Docker socket, no secrets and no owner data.
// They run from a "lab image" the evaluator builds from the *trusted* package lock (B1
// forbids dependency changes, so the candidate never influences what gets installed).
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { docker, dockerRaw } from "@/lib/docker"
import { env } from "@/lib/env"
import { archive, git, gitText } from "@/lib/evolution/repo"

export const LAB_LABEL = "owndesk.lab"
const prefix = () => `pa-${env.INSTALL_ID.slice(0, 8)}`
// Directories and files that are build or test output, never source
export const EXPORT_EXCLUDES = [
  "./node_modules",
  "./.next",
  "./data",
  "./test-results",
  "./next-env.d.ts",
  "*.tsbuildinfo",
]

async function trustedFile(commit: string, file: string) {
  return git(["show", `${commit}:${file}`])
}

// node image the trusted Dockerfile builds on
export async function baseImage(trustedCommit: string) {
  const dockerfile = (await trustedFile(trustedCommit, "Dockerfile")).toString("utf8")
  const match = /^FROM\s+(\S+)\s+AS\s+build/m.exec(dockerfile)
  if (!match) throw new Error("Trusted Dockerfile has no build stage")
  return match[1]
}

export async function ensureLabImage(
  trustedCommit: string,
  onLine?: (line: string) => void
) {
  const lock = await trustedFile(trustedCommit, "package-lock.json")
  const pkg = await trustedFile(trustedCommit, "package.json")
  const base = await baseImage(trustedCommit)
  // Git blob ids of the dependency files name the image: same lock, same image
  const blobs = await gitText([
    "rev-parse",
    `${trustedCommit}:package.json`,
    `${trustedCommit}:package-lock.json`,
  ])
  const tag = `owndesk-lab:${blobs
    .split("\n")
    .map((id) => id.slice(0, 10))
    .join("-")}`
  const present = await dockerRaw(["image", "inspect", tag], { timeoutMs: 30000 })
  if (present.exitCode === 0) return tag
  const context = await mkdtemp(path.join(os.tmpdir(), "owndesk-lab-image-"))
  try {
    await writeFile(path.join(context, "package.json"), pkg)
    await writeFile(path.join(context, "package-lock.json"), lock)
    await writeFile(
      path.join(context, "Dockerfile"),
      [
        `FROM ${base}`,
        "WORKDIR /lab",
        "ENV NEXT_TELEMETRY_DISABLED=1 CI=1",
        "COPY package.json package-lock.json ./",
        "RUN npm ci && chown -R node:node /lab",
        "USER node",
        "",
      ].join("\n")
    )
    await docker(["build", "--label", `${LAB_LABEL}=image`, "-t", tag, context], {
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 8 * 1024 * 1024,
      onLine,
    })
    return tag
  } finally {
    await rm(context, { recursive: true, force: true })
  }
}

export type LabContainer = { name: string }

export async function startLab(
  image: string,
  key: string,
  { memoryMb = 3072, cpus = 2 }: { memoryMb?: number; cpus?: number } = {}
): Promise<LabContainer> {
  const name = `${prefix()}-lab-${key}`.slice(0, 120)
  await dockerRaw(["rm", "-f", name], { timeoutMs: 60000 })
  await docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${LAB_LABEL}=${env.INSTALL_ID}`,
      "--network",
      "none",
      "--memory",
      `${memoryMb}m`,
      "--cpus",
      String(cpus),
      "--pids-limit",
      "2048",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,exec,size=1g",
      "--env",
      "HOME=/tmp",
      image,
      "sleep",
      "infinity",
    ],
    { timeoutMs: 120000 }
  )
  return { name }
}

export async function stopLab(lab: LabContainer) {
  await dockerRaw(["rm", "-f", lab.name], { timeoutMs: 60000 })
}

// Run a shell command in the lab. Never throws for a non-zero exit.
export async function labExec(
  lab: LabContainer,
  command: string,
  { input, timeoutMs = 300000, maxOutputBytes = 4 * 1024 * 1024 } = {} as {
    input?: string | Buffer
    timeoutMs?: number
    maxOutputBytes?: number
  }
) {
  const result = await dockerRaw(
    [
      "exec",
      ...(input !== undefined ? ["-i"] : []),
      "-w",
      "/lab",
      lab.name,
      "sh",
      "-c",
      command,
    ],
    { input, timeoutMs, maxOutputBytes }
  ).catch((error: Error) => ({
    exitCode: -1,
    stdout: Buffer.from(""),
    stderr: error.message,
  }))
  return {
    code: result.exitCode,
    output: `${result.stdout.toString("utf8")}${result.stderr ? `\n${result.stderr}` : ""}`,
  }
}

export async function loadCommit(lab: LabContainer, commit: string) {
  const tar = await archive(commit)
  const result = await labExec(lab, "tar -xf - -C /lab", {
    input: tar,
    timeoutMs: 120000,
  })
  if (result.code !== 0) throw new Error(`Could not load the source: ${result.output}`)
}

// Overwrite tests/ with the trusted copies (new test files from the candidate stay)
export async function overlayTrustedTests(lab: LabContainer, trustedCommit: string) {
  const tar = await git(["archive", "--format=tar", trustedCommit, "tests"])
  const result = await labExec(lab, "tar -xf - -C /lab", {
    input: tar,
    timeoutMs: 120000,
  })
  if (result.code !== 0) throw new Error(`Could not load trusted tests: ${result.output}`)
}

export async function exportTree(lab: LabContainer, target: string) {
  const excludes = EXPORT_EXCLUDES.map((item) => `--exclude='${item}'`).join(" ")
  const result = await dockerRaw(
    ["exec", "-w", "/lab", lab.name, "sh", "-c", `tar -cf - ${excludes} .`],
    { timeoutMs: 120000, maxOutputBytes: 512 * 1024 * 1024 }
  )
  if (result.exitCode !== 0)
    throw new Error(`Could not export the tree: ${result.stderr}`)
  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve, reject) => {
    const child = execFile("tar", ["-xf", "-", "-C", target], (error) =>
      error ? reject(error) : resolve()
    )
    child.stdin!.end(result.stdout)
  })
}

export async function removeLabContainers() {
  const ids = (
    await dockerRaw(["ps", "-aq", "--filter", `label=${LAB_LABEL}=${env.INSTALL_ID}`], {
      timeoutMs: 30000,
    })
  ).stdout
    .toString()
    .trim()
  if (ids) await dockerRaw(["rm", "-f", ...ids.split(/\s+/)], { timeoutMs: 60000 })
}

// A file's exact bytes from the lab, or null when it is missing
export async function readLabFile(lab: LabContainer, file: string) {
  const result = await dockerRaw(["exec", "-w", "/lab", lab.name, "cat", "--", file], {
    timeoutMs: 60000,
    maxOutputBytes: 8 * 1024 * 1024,
  })
  return result.exitCode === 0 ? result.stdout.toString("utf8") : null
}
