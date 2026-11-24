import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import {
  startCandidateStack,
  removeCandidateStack,
  verifyCandidateWorkstation,
  CandidateSession,
} from "../lib/evolution/evaluator.ts"
import { docker } from "../lib/docker.ts"
import { pool } from "../db/index.ts"
assert.equal(process.env.DISPOSABLE_STACK_ONLY, "1")
const key = "gate-" + randomUUID()
let stack
try {
  stack = await startCandidateStack({
    key,
    images: { worker: process.env.PROOF_WORKER, web: process.env.PROOF_WEB },
    trial: true,
    workstation: true,
    log: (s) => console.log(s),
  })
  const w = stack.containers.worker,
    agent = stack.agentIds[0]
  const cls = async (...args) => (await docker(args)).stdout.toString().trim()
  assert.equal(
    await cls("inspect", "--format", "{{len .HostConfig.PortBindings}}", w),
    "0"
  )
  const mounts = JSON.parse(await cls("inspect", "--format", "{{json .Mounts}}", w))
  assert(!mounts.some((m) => m.Destination.endsWith("docker.sock") || m.Type === "bind"))
  const js = `import{ensureWorkstation,controller}from'./lib/workstation.ts';import{pool}from'./db/index.ts';import{createHash}from'node:crypto';const id=process.argv[1];const row=await ensureWorkstation(id);const epoch=row.epoch+1;await controller(id,'/control',{epoch,mode:'agent'});await controller(id,'/desktop_open_application',{epoch,application:'Mousepad'});const v=await controller(id,'/screen_capture',{epoch});if(!v.diaryActivity)throw Error('No diary');const buf=Buffer.from(v.image,'base64');console.log(JSON.stringify({activity:v.diaryActivity,bytes:buf.length,sha:createHash('sha256').update(buf).digest('hex'),screenshot:v.screenshot_status}));await pool.end()`
  const result = JSON.parse(
    await cls(
      "exec",
      w,
      "node",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      js,
      agent
    )
  )
  assert.equal(result.screenshot, "ok")
  assert(result.bytes > 1000)
  const session = new CandidateSession(stack)
  await session.signIn()
  const base = await session.request(
    "GET",
    "/api/companion/images/" + result.activity + "?agentId=" + agent
  )
  assert.equal(base.status, 200)
  const actual = Buffer.from(await base.arrayBuffer())
  assert.equal(actual.length, result.bytes)
  assert.equal(createHash("sha256").update(actual).digest("hex"), result.sha)
  assert(actual.subarray(0, 2).equals(Buffer.from([255, 216])))
  const guests = await cls(
    "ps",
    "--filter",
    "label=owndesk.lab.stack=" + key,
    "--format",
    "{{.Names}}"
  )
  assert(guests.includes("-ws-" + agent))
  const independent = await verifyCandidateWorkstation(stack)
  assert(independent.ok)
  console.log(independent.detail)
  console.log(
    "PASS candidate Worker created a real guest via the gate and saved a screenshot to a diary entry; authenticated download matched every byte."
  )
  await writeFile(
    process.env.PROOF_OUT,
    JSON.stringify({
      key,
      agent,
      ...result,
      workerSocketMount: false,
      workerPublishedPorts: 0,
    })
  )
} finally {
  await removeCandidateStack(key)
  for (const [kind, args] of [
    ["container", ["ps", "-aq"]],
    ["volume", ["volume", "ls", "-q"]],
    ["network", ["network", "ls", "-q"]],
  ])
    assert.equal(
      (await docker([...args, "--filter", "label=owndesk.lab.stack=" + key])).stdout
        .toString()
        .trim(),
      "",
      kind + " still exists"
    )
  await pool.end()
}
