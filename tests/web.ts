import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { env } from "@/lib/env"
import { pool } from "@/db"
import { ensureRecoveryLab } from "./fixtures/recovery-lab"

// Local development owner only; no real user credentials or external services.
const credentials = JSON.parse(await readFile("data/dev-owner.json", "utf8"))
const base = env.APP_URL
const checks: string[] = []
const authHeaders = { "Content-Type": "application/json", Origin: base }
try {
  assert.equal((await fetch(`${base}/api/tasks`)).status, 401)
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      email: "unauthorized@fixture.test",
      password: "test-password-never-used",
      name: "Intruder",
    }),
  })
  assert.equal(signup.status, 400)
  assert.equal((await signup.json()).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED")
  checks.push("Unauthenticated tasks rejected; public registration disabled")
  const login = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(credentials),
  })
  assert.equal(login.status, 200, await login.text())
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
  assert(cookie)
  const headers = { ...authHeaders, Cookie: cookie }
  const agent = { id: await ensureRecoveryLab() }
  const input = {
    agentId: agent.id,
    goal: "Web authenticated recovery fixture",
    clientRequestId: randomUUID(),
  }
  const badOrigin = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { ...headers, Origin: "https://untrusted.fixture.test" },
    body: JSON.stringify(input),
  })
  assert.equal(badOrigin.status, 403)
  const accepted = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  })
  assert.equal(accepted.status, 202, await accepted.clone().text())
  const { taskId } = await accepted.json()
  const duplicate = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).taskId, taskId)
  checks.push("Authenticated submit, source deduplication and Origin checks")

  let task:
    | {
        status: string
        error: string
        artifacts: { id: string; verification: { grade: string } }[]
      }
    | undefined
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`${base}/api/tasks/${taskId}`, { headers })
    assert.equal(response.status, 200)
    task = await response.json()
    if (task!.status === "completed") break
    if (task!.status === "failed") throw new Error(task!.error)
    await delay(100)
  }
  assert.equal(task!.status, "completed")
  assert.equal(task!.artifacts.length, 1)
  const artifactUrl = `${base}/api/artifacts/${task!.artifacts[0].id}`
  assert.equal((await fetch(artifactUrl)).status, 401)
  const artifact = await fetch(artifactUrl, { headers })
  assert.equal(artifact.status, 200)
  assert.match(await artifact.text(), /^date,site,amount\n/)
  checks.push("Completed task exposes a verified, owner-only downloadable artifact")

  const abort = new AbortController()
  const stream = await fetch(`${base}/api/tasks/${taskId}/events`, {
    headers: { ...headers, "Last-Event-ID": "2" },
    signal: abort.signal,
  })
  assert.equal(stream.status, 200)
  const reader = stream.body!.getReader()
  let data = ""
  while (!data.includes('"seq":4')) {
    const chunk = await reader.read()
    assert(!chunk.done)
    data += new TextDecoder().decode(chunk.value)
  }
  abort.abort()
  assert(!data.includes('"seq":1'))
  assert(!data.includes('"seq":2'))
  checks.push("SSE resumes after Last-Event-ID without replaying acknowledged events")
  const logout = await fetch(`${base}/api/auth/sign-out`, {
    method: "POST",
    headers,
    body: "{}",
  })
  assert.equal(logout.status, 200)
  assert.equal((await fetch(`${base}/api/tasks/${taskId}`, { headers })).status, 401)
  checks.push("Sign-out invalidates the owner session")
  await mkdir("docs/evidence", { recursive: true })
  await writeFile(
    "docs/evidence/web.json",
    JSON.stringify(
      {
        passed: true,
        fixtureOnly: true,
        taskId,
        checks,
        recordedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  )
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
} finally {
  await pool.end()
}
