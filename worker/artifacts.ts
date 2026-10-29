import path from "node:path"
import { mkdir, writeFile, rename, readFile } from "node:fs/promises"
import { pool } from "@/db"
import type { CompletionContract } from "@/db/schema"
import { artifactDir } from "@/lib/env"
import { execFile } from "node:child_process"
import { docker, DockerError, DockerOutputLimitError } from "@/lib/docker"
import { verifyCsv, verifyDirectoryTree } from "@/lib/artifact-checks"
import { compareReports, type ComparisonResult } from "@/lib/report-comparison"
import { workstationName, assertAgentControl } from "@/lib/workstation"
import { appendEventInTransaction } from "@/lib/task-events"

export class ArtifactValidationError extends Error {}

export type Deliverable = { path: string; name?: string; mediaType: string }
export async function collectArtifacts(
  taskId: string,
  segmentNo: number,
  actionNo: number,
  agentId: string,
  files: Deliverable[],
  contract: CompletionContract
) {
  const normalize = (value: string) =>
    path.posix.resolve("/home/agent", value.replace(/^~(?=\/|$)/, "/home/agent"))
  const requiredFiles = [contract.artifact, contract.comparison?.baseline].filter(
    (item) => item !== undefined
  )
  if (
    new Set(requiredFiles.map((file) => normalize(file.path))).size !==
    requiredFiles.length
  )
    throw new ArtifactValidationError(
      "Current and baseline reports must be distinct files"
    )
  for (const required of requiredFiles)
    if (!files.some((file) => normalize(file.path) === normalize(required.path)))
      throw new ArtifactValidationError(`Deliver the required file: ${required.path}`)
  await assertAgentControl(taskId, agentId, segmentNo)
  const folder = path.join(artifactDir, taskId)
  await mkdir(folder, { recursive: true })
  const collected: {
    id: string
    name: string
    path: string
    verification: Record<string, unknown>
  }[] = []
  for (const [index, file] of files.entries()) {
    const source = normalize(file.path)
    if (!source.startsWith("/home/agent/") || source.includes("\0"))
      throw new ArtifactValidationError("Deliverables must be files under /home/agent")
    const id = `${taskId}-s${segmentNo}-a${actionNo}-f${index}`
    const {
      rows: [existing],
    } = await pool.query<{
      id: string
      name: string
      verification: Record<string, unknown>
    }>("SELECT id,name,verification FROM artifacts WHERE id=$1 AND task_id=$2", [
      id,
      taskId,
    ])
    if (existing) {
      collected.push({ ...existing, path: source })
      continue
    }
    const temporary = path.join(folder, `${id}.pending`)
    let archive: Buffer
    try {
      archive = (
        await docker(["cp", `${workstationName(agentId)}:${source}`, "-"], {
          timeoutMs: 60000,
          maxOutputBytes: 21000000,
        })
      ).stdout
    } catch (error) {
      if (error instanceof DockerOutputLimitError)
        throw new ArtifactValidationError("A deliverable must be at most 20 MB")
      if (
        error instanceof DockerError &&
        error.stderr.includes("Could not find the file")
      )
        throw new ArtifactValidationError(`File not found on workstation: ${file.path}`)
      throw error
    }
    const listing = (await tar(["-tvf", "-"], archive, 8192))
      .toString()
      .trim()
      .split("\n")
    if (listing.length !== 1 || !listing[0].startsWith("-"))
      throw new ArtifactValidationError(
        "Deliver one regular file; directories and links are not accepted"
      )
    const content = await tar(["-xOf", "-"], archive, 20000000)
    const info = { size: content.length }
    await writeFile(temporary, content)
    const required = requiredFiles.find((item) => normalize(item.path) === source)
    let verification: Record<string, unknown>
    if (required) {
      try {
        verification = verifyCsv(content.toString("utf8"), required)
      } catch (error) {
        throw new ArtifactValidationError(
          error instanceof Error ? error.message : String(error)
        )
      }
    } else
      verification = {
        grade: "file_copied",
        checks: { regularFile: true, bytes: info.size },
        unverified: ["Business contents have not been independently validated."],
      }
    const name = path.posix.basename(file.name ?? source)
    const storagePath = path.join(taskId, id)
    await rename(temporary, path.join(artifactDir, storagePath))
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `INSERT INTO artifacts(id,task_id,name,storage_path,media_type,size,verification,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(task_id,storage_path) DO NOTHING`,
        [
          id,
          taskId,
          name,
          storagePath,
          file.mediaType,
          info.size,
          JSON.stringify(verification),
        ]
      )
      await appendEventInTransaction(
        client,
        taskId,
        `artifact:${id}`,
        "artifact_created",
        { id, name, path: source, bytes: info.size, verification }
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    collected.push({ id, name, path: source, verification })
  }
  let comparison: ComparisonResult | undefined
  if (contract.comparison) {
    const current = collected.find(
      (file) => file.path === normalize(contract.artifact!.path)
    )!
    const baseline = collected.find(
      (file) => file.path === normalize(contract.comparison!.baseline.path)
    )!
    // Stable artifact IDs point to host-owned bytes, not the mutable guest files.
    const contents = await Promise.all(
      [current, baseline].map((file) => readFile(path.join(folder, file.id), "utf8"))
    )
    try {
      comparison = {
        ...compareReports(
          contents[0],
          contents[1],
          contract.artifact!,
          contract.comparison
        ),
        currentArtifactId: current.id,
        baselineArtifactId: baseline.id,
      }
    } catch (error) {
      throw new ArtifactValidationError((error as Error).message)
    }
  }
  let directoryTree: Record<string, unknown> | undefined
  if (contract.directoryTree) {
    const { root } = contract.directoryTree
    let archive: Buffer
    try {
      archive = (
        await docker(["cp", `${workstationName(agentId)}:${root}`, "-"], {
          timeoutMs: 30000,
          maxOutputBytes: 2000000,
        })
      ).stdout
    } catch (error) {
      if (error instanceof DockerOutputLimitError)
        throw new ArtifactValidationError(
          "Directory check exceeds its 2 MB snapshot limit"
        )
      if (
        error instanceof DockerError &&
        error.stderr.includes("Could not find the file")
      )
        throw new ArtifactValidationError("Required directory does not exist")
      throw error
    }
    const names = (await tar(["-tf", "-"], archive, 100000)).toString().trim().split("\n")
    const types = (await tar(["-tvf", "-"], archive, 200000))
      .toString()
      .trim()
      .split("\n")
    try {
      directoryTree = verifyDirectoryTree(names, types, contract.directoryTree)
    } catch (error) {
      throw new ArtifactValidationError((error as Error).message)
    }
  }
  return { files: collected, comparison, directoryTree }
}

// Native tar reads an in-memory bounded archive. No archive paths are extracted on the host.
function tar(args: string[], input: Buffer, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "tar",
      args,
      {
        encoding: "buffer",
        maxBuffer,
        timeout: 10000,
        // GNU tar escapes UTF-8 names in the production image's default C locale.
        env: { ...process.env, LC_ALL: "C.UTF-8" },
      },
      (error, stdout) => {
        if (error) {
          reject(
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? new ArtifactValidationError("A deliverable must be at most 20 MB")
              : error
          )
          return
        }
        resolve(stdout)
      }
    )
    child.stdin!.end(input)
  })
}
