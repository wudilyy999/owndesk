import assert from "node:assert/strict"
import { test } from "node:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { Agent } from "undici"
import { connectionConfigSchema } from "@/lib/connection-schema"
import { connectionEndpointAllowed, publicAddress } from "@/lib/connection-endpoint"
import { connectionFetch, connectionLookup } from "@/lib/connection-fetch"

const privateEndpoints = [
  "https://127.0.0.1/mcp",
  "https://localhost/mcp",
  "https://[::1]/mcp",
  "https://10.0.0.1/mcp",
  "https://172.16.0.1/mcp",
  "https://192.168.1.1/mcp",
  "https://169.254.169.254/latest",
  "https://100.64.0.1/mcp",
  "https://0.0.0.0/",
  "https://2130706433/",
  "https://0x7f000001/",
  "https://127.1/",
  "https://[::ffff:127.0.0.1]/",
  "https://[fc00::1]/",
  "https://[fe80::1]/",
  "https://[2001:db8::1]/",
  "https://224.0.0.1/",
  "https://metadata.internal/",
]
for (const url of privateEndpoints)
  test(`reject non-public MCP endpoint: ${url}`, () => {
    assert.equal(
      connectionConfigSchema.safeParse({ kind: "mcp_http", url }).success,
      false
    )
  })
test("public HTTPS only, credential/fragment rejection, and narrow explicit loopback opt-in", () => {
  for (const url of [
    "https://example.com/mcp",
    "https://8.8.8.8/mcp",
    "https://[2001:4860:4860::8888]/",
  ])
    assert(connectionEndpointAllowed(url))
  for (const url of [
    "http://example.com/mcp",
    "https://user:pass@example.com/",
    "https://example.com/#fragment",
    "file:///etc/passwd",
  ])
    assert(!connectionEndpointAllowed(url, true))
  for (const url of [
    "http://127.0.0.1:1234/mcp",
    "https://localhost/mcp",
    "http://[::1]/mcp",
  ])
    assert(
      connectionConfigSchema.safeParse({ kind: "mcp_http", url, allowLoopback: true })
        .success
    )
  for (const url of [
    "https://10.0.0.1/",
    "https://169.254.169.254/",
    "https://127.0.0.2/",
    "https://[fc00::1]/",
  ])
    assert(!connectionEndpointAllowed(url, true))
  assert(
    !connectionConfigSchema.safeParse({
      kind: "mcp_http",
      url: "https://example.com",
      oauth: {
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://192.168.0.1/token",
        clientId: "fixture",
      },
    }).success
  )
})

test("connection-time DNS validation rejects private, mixed, empty and rebound answers", async () => {
  const checks = [
    [],
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["169.254.169.254"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["8.8.8.8", "192.168.1.1"],
    ["fc00::1"],
  ]
  for (const addresses of checks) {
    const lookup = connectionLookup(false, async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
    )
    await new Promise<void>((resolve) =>
      lookup("public-looking.example", { all: true }, (error) => {
        assert(error)
        resolve()
      })
    )
  }
  let count = 0
  const lookup = connectionLookup(false, async () => [
    { address: count++ ? "127.0.0.1" : "8.8.8.8", family: 4 },
  ])
  await new Promise<void>((resolve) =>
    lookup("rebind.example", {}, (error, address) => {
      assert.equal(error, null)
      assert.equal(address, "8.8.8.8")
      resolve()
    })
  )
  await new Promise<void>((resolve) =>
    lookup("rebind.example", {}, (error) => {
      assert(error)
      resolve()
    })
  )
  assert.equal(count, 2)
  assert.equal(publicAddress("::ffff:8.8.8.8"), false)
})

test("DNS errors fail closed; all-address lookup pins exactly the validated public set", async () => {
  const addresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 },
  ]
  await new Promise<void>((resolve) =>
    connectionLookup(false, async () => addresses)(
      "example.com",
      { all: true },
      (error, received) => {
        assert.equal(error, null)
        assert.deepEqual(received, addresses)
        resolve()
      }
    )
  )
  await new Promise<void>((resolve) =>
    connectionLookup(false, async () => {
      throw new Error("DNS failed")
    })("example.com", {}, (error) => {
      assert.match(error!.message, /DNS failed/)
      resolve()
    })
  )
  await new Promise<void>((resolve) =>
    connectionLookup(true, async () => [{ address: "127.0.0.1", family: 4 }])(
      "public-looking.example",
      {},
      (error) => {
        assert(error, "loopback opt-in never authorizes arbitrary DNS aliases")
        resolve()
      }
    )
  )
})

test("real HTTP transport blocks DNS-to-loopback before connecting and refuses every redirect", async () => {
  let targetHits = 0
  const server = createServer((req, res) => {
    if (req.url === "/target") {
      targetHits++
      res.end("target")
      return
    }
    if (req.url === "/ok") {
      res.end("ok")
      return
    }
    res
      .writeHead(Number(req.url!.slice(1)), {
        Location: `http://127.0.0.1:${(server.address() as { port: number }).port}/target`,
      })
      .end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const agent = new Agent({
    connect: {
      lookup: connectionLookup(false, async () => [{ address: "127.0.0.1", family: 4 }]),
    },
  })
  try {
    await assert.rejects(
      fetch(
        `http://public-looking.invalid:${(server.address() as { port: number }).port}/target`,
        { dispatcher: agent } as RequestInit
      )
    )
    await assert.rejects(connectionFetch()(origin + "/target"))
    assert.equal(await (await connectionFetch(true)(origin + "/ok")).text(), "ok")
    assert.equal(
      await (
        await connectionFetch(true)(origin.replace("127.0.0.1", "localhost") + "/ok")
      ).text(),
      "ok"
    )
    for (const code of [301, 302, 303, 307, 308])
      await assert.rejects(
        connectionFetch(true)(origin + "/" + code, { redirect: "follow" })
      )
    assert.equal(targetHits, 0)
  } finally {
    await agent.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
