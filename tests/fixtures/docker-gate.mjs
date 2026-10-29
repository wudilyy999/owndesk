// Host-only acceptance breakpoint. Never journal stdin: vault values also use this pipe.
import assert from "node:assert/strict"
import { readFile, writeFile, rename } from "node:fs/promises"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

const args = process.argv.slice(2)
const request =
  args.includes("/opt/owndesk-controller/request.mjs") && args.at(-1) === "/actions"
let input
if (request) {
  input = ""
  for await (const chunk of process.stdin) input += chunk
  const { id, kind } = JSON.parse(input)
  const gate = JSON.parse(await readFile(process.env.PA_TEST_DOCKER_GATE, "utf8"))
  if (gate && id.startsWith(`${gate.taskId}-s`) && kind === gate.kind) {
    const ready = `${process.env.PA_TEST_DOCKER_GATE}.ready`
    await writeFile(
      `${ready}.tmp`,
      JSON.stringify({ id, kind, pid: process.pid, token: gate.token, forwarded: false })
    )
    await rename(`${ready}.tmp`, ready)
    while (
      JSON.parse(await readFile(process.env.PA_TEST_DOCKER_GATE, "utf8"))?.token ===
      gate.token
    )
      await delay(50)
  }
}
assert(process.env.PA_TEST_NATIVE_DOCKER)
const child = spawn(process.env.PA_TEST_NATIVE_DOCKER, args, {
  stdio: [request ? "pipe" : "inherit", "inherit", "inherit"],
})
if (request) child.stdin.end(input)
const [code, signal] = await once(child, "exit")
if (signal) process.kill(process.pid, signal)
else process.exitCode = code
