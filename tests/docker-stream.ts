import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker, dockerRaw, dockerStream, DockerError } from "@/lib/docker"
import { env } from "@/lib/env"

const name = `pa-stream-${randomUUID()}`
const directory = path.resolve("data/experiments", name)
await mkdir(directory, { recursive: true })
const checks: string[] = []
let passed = false
let created = false
try {
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "personal-agent.experiment=desktop-stream",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "128m",
    "--entrypoint",
    "node",
    env.WORKSTATION_IMAGE,
    "-e",
    "setInterval(() => {}, 1000)",
  ])
  created = true
  const stream = await dockerStream([
    "exec",
    "-i",
    name,
    "node",
    "-e",
    "process.stdin.pipe(process.stdout)",
  ])
  const payload = randomBytes(1024 * 1024)
  const chunks: Buffer[] = []
  stream.end(payload)
  for await (const chunk of stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), payload)
  checks.push("one MiB binary round-trip and remote EOF through real Docker exec")

  const rejected = await dockerStream([
    "exec",
    "-i",
    name,
    "node",
    "-e",
    "console.error('fixture exec rejected'); process.exit(23)",
  ])
  await assert.rejects(
    async () => {
      for await (const chunk of rejected) assert.fail(`Unexpected bytes: ${chunk.length}`)
    },
    (error: unknown) =>
      error instanceof DockerError &&
      error.exitCode === 23 &&
      error.message === "fixture exec rejected"
  )
  checks.push("nonzero remote exit preserves error even after stdout EOF")

  const marker = randomUUID()
  const waiting = await dockerStream([
    "exec",
    "-i",
    name,
    "node",
    "-e",
    `/*${marker}*/ console.log('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`,
  ])
  try {
    assert.equal((await once(waiting, "data"))[0].toString().trim(), "ready")
    assert((await docker(["top", name, "-eo", "pid,args"])).stdout.includes(marker))
    const closed = once(waiting, "close")
    waiting.destroy()
    await closed
    const deadline = Date.now() + 5000
    while (true) {
      const remote = (await docker(["top", name, "-eo", "pid,args"])).stdout.toString()
      const local = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
      if (!remote.includes(marker) && !local.includes(marker)) break
      assert(
        Date.now() < deadline,
        "Destroyed stream must terminate remote relay and local CLI"
      )
      await delay(50)
    }
    checks.push(
      "destroy delivers EOF and leaves neither remote process nor local Docker CLI"
    )
  } finally {
    waiting.destroy()
  }

  const absent = await dockerStream(["exec", `${name}-absent`, "true"])
  await assert.rejects(async () => {
    for await (const chunk of absent) assert.fail(`Unexpected bytes: ${chunk.length}`)
  }, DockerError)
  checks.push("missing-container transport failure propagates")
  passed = true
} catch (error) {
  await writeFile(path.join(directory, "failure.txt"), String(error))
  throw error
} finally {
  if (created) {
    const cleanup = await dockerRaw(["rm", "-f", name])
    if (cleanup.exitCode !== 0) throw new Error(cleanup.stderr)
  }
  const evidence = { passed, checks, directory, recordedAt: new Date().toISOString() }
  const json = JSON.stringify(evidence, null, 2) + "\n"
  await writeFile(path.join(directory, "result.json"), json)
  if (passed) await writeFile("docs/evidence/docker-stream.json", json)
  console.log(json)
}
