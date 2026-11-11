import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { startMcpFixture } from "./fixtures/mcp-server.mjs"

process.loadEnvFile(".env")
const database = `agent_connections_${randomUUID().replaceAll("-", "")}`,
  directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!),
  admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
const fixture = await startMcpFixture(),
  checks: string[] = []
let passed = false
try {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  await once(child, "exit")
  assert.equal(child.exitCode, 0)
  const { pool } = await import("@/db")
  try {
    const {
      saveConnection,
      listConnections,
      connectionSnapshot,
      discoverConnection,
      callConnection,
      setConnectionEnabled,
      authorizeConnection,
      finishConnectionAuthorization,
      disconnectConnection,
    } = await import("@/lib/connections")
    const owner = "connection-owner"
    const configured = await saveConnection(owner, {
      name: "Remote fixture",
      config: {
        kind: "mcp_http",
        allowLoopback: true,
        url: fixture.url + "/mcp",
        bearer: "fixture-access",
      },
    })
    assert.equal((await connectionSnapshot(owner)).length, 0)
    const catalog = await discoverConnection(owner, configured.id)
    assert.equal(catalog.tools.length, 2)
    assert.equal(
      catalog.tools.find((tool) => tool.name === "fixture_read")!.readOnly,
      false
    )
    await setConnectionEnabled(owner, configured.id, true)
    const reference = (await connectionSnapshot(owner))[0]
    assert.match(
      JSON.stringify(
        await callConnection(owner, reference.id, reference.revision, "fixture_read", {
          query: "hello",
        })
      ),
      /Read: hello/
    )
    assert.match(
      JSON.stringify(
        await callConnection(owner, reference.id, reference.revision, "fixture_write", {
          text: "one",
        })
      ),
      /Written: one/
    )
    assert.deepEqual(fixture.writes, ["one"])
    await assert.rejects(
      callConnection(owner, reference.id, reference.revision, "fixture_write", {
        text: 42,
      }),
      { status: 400 }
    )
    await assert.rejects(
      callConnection("other-owner", reference.id, reference.revision, "fixture_read", {
        query: "no",
      }),
      { status: 404 }
    )
    await setConnectionEnabled(owner, reference.id, false)
    await assert.rejects(
      callConnection(owner, reference.id, reference.revision, "fixture_write", {
        text: "blocked",
      }),
      { status: 409 }
    )
    checks.push(
      "Actual HTTP MCP initialize/discovery/read/write; enabled revisions and owner isolation fence calls"
    )
    const local = await saveConnection(owner, {
      name: "Local fixture",
      enabled: true,
      config: {
        kind: "mcp_stdio",
        command: process.execPath,
        args: [path.resolve("tests/fixtures/mcp-server.mjs"), "--stdio"],
        env: {},
      },
    })
    await discoverConnection(owner, local.id)
    const localRef = (await connectionSnapshot(owner)).find(
      (item) => item.id === local.id
    )!
    assert.match(
      JSON.stringify(
        await callConnection(owner, localRef.id, localRef.revision, "fixture_read", {
          query: "stdio",
        })
      ),
      /Read: stdio/
    )
    checks.push(
      "Actual local stdio MCP server discovers and answers through SDK lifecycle"
    )
    const oauth = await saveConnection(owner, {
      name: "OAuth fixture",
      enabled: true,
      config: {
        kind: "mcp_http",
        allowLoopback: true,
        url: fixture.url + "/mcp",
        oauth: {
          authorizationUrl: fixture.url + "/authorize",
          tokenUrl: fixture.url + "/token",
          clientId: "fixture-client",
          clientSecret: "fixture-client-secret",
          scope: "read write",
        },
      },
    })
    const authorization = new URL((await authorizeConnection(owner, oauth.id)).url)
    assert(authorization.searchParams.get("code_challenge"))
    assert(authorization.searchParams.get("state"))
    await assert.rejects(
      finishConnectionAuthorization(owner, oauth.id, "bad-state", "fixture-code"),
      { status: 400 }
    )
    await finishConnectionAuthorization(
      owner,
      oauth.id,
      authorization.searchParams.get("state")!,
      "fixture-code"
    )
    await assert.rejects(
      finishConnectionAuthorization(
        owner,
        oauth.id,
        authorization.searchParams.get("state")!,
        "fixture-code"
      ),
      { status: 409 }
    )
    await discoverConnection(owner, oauth.id)
    assert.equal(fixture.tokens.length, 2)
    assert.equal(fixture.tokens[0].grant_type, "authorization_code")
    assert(fixture.tokens[0].code_verifier)
    assert.equal(fixture.tokens[1].grant_type, "refresh_token")
    const exposed = JSON.stringify(await listConnections(owner)),
      stored = JSON.stringify((await pool.query("SELECT * FROM app_connections")).rows)
    for (const secret of ["fixture-access", "fixture-refresh", "fixture-client-secret"]) {
      assert(!exposed.includes(secret))
      assert(!stored.includes(secret))
    }
    await disconnectConnection(owner, oauth.id)
    assert.equal(
      (await listConnections(owner)).find((row) => row.id === oauth.id).authorized,
      false
    )
    await disconnectConnection(owner, local.id, true)
    assert(!(await listConnections(owner)).some((row) => row.id === local.id))
    checks.push(
      "OAuth state and PKCE, one-use callback, token exchange/refresh, encrypted credentials, disconnect and delete"
    )
    const { callGoogle, googleTools } = await import("@/lib/google-connection")
    const nativeFetch = globalThis.fetch,
      requests: { url: string; method: string; body: string }[] = []
    try {
      globalThis.fetch = async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        })
        return Response.json({ id: "fixture-result" })
      }
      await callGoogle("token", "email_list", { query: "from:fixture@example.com" })
      await callGoogle("token", "email_read", { id: "message/with path" })
      await callGoogle("token", "email_send", {
        to: ["owner@example.com"],
        subject: "邮件标题",
        body: "正文",
      })
      await callGoogle("token", "calendar_list", { timeMin: "2026-11-08T00:00:00Z" })
      const event = {
        summary: "Meeting",
        start: { dateTime: "2026-11-09T10:00:00Z" },
        end: { dateTime: "2026-11-09T11:00:00Z" },
      }
      await callGoogle("token", "calendar_create", { event })
      await callGoogle("token", "calendar_update", { eventId: "event/1", event })
      await callGoogle("token", "calendar_delete", { eventId: "event/1" })
      assert.equal(requests.length, 7)
      assert.equal(googleTools.length, 7)
      assert.match(requests[1].url, /message%2Fwith%20path/)
      assert.match(
        Buffer.from(JSON.parse(requests[2].body).raw, "base64url").toString(),
        /To: owner@example.com/
      )
      assert.equal(requests[6].method, "DELETE")
      await assert.rejects(
        callGoogle("token", "email_send", {
          to: ["owner@example.com"],
          subject: "subject\r\nBcc: injected@example.com",
          body: "x",
        })
      )
    } finally {
      globalThis.fetch = nativeFetch
    }
    checks.push(
      "All seven Gmail/calendar adapters construct correct requests and reject header injection (controlled HTTP responses)"
    )
    passed = true
  } finally {
    await pool.end()
  }
} finally {
  await fixture.close()
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed, checks, database }, null, 2)
  )
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
