import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
// @ts-expect-error plain JS module that ships to the VPS
import { createRelay } from "../deploy/channel-relay/relay.mjs"

const KEY = "k".repeat(24)
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  )

test("relay refuses to start with a weak key", () => {
  assert.throws(() => createRelay({ key: "short" }))
})

test("relay forwards only allowed hosts, with the key, and passes webhooks to the app", async () => {
  const seen: {
    path?: string
    host?: string
    method?: string
    body: string
    key?: unknown
  }[] = []
  const upstream = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      seen.push({
        path: req.url,
        host: req.headers.host,
        method: req.method,
        body,
        key: req.headers["x-relay-key"],
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const upstreamPort = await listen(upstream)
  const relay = createRelay({
    key: KEY,
    hosts: "api.bot.qq.com",
    upstreamInsecure: true,
    upstreamResolve: () => ({ host: "127.0.0.1", port: upstreamPort }),
    appUpstream: `http://127.0.0.1:${upstreamPort}`,
  })
  const port = await listen(relay)
  const base = `http://127.0.0.1:${port}`
  try {
    const ok = await fetch(`${base}/forward/api.bot.qq.com/v2/users/u/messages?x=1`, {
      method: "POST",
      headers: {
        "x-relay-key": KEY,
        "content-type": "application/json",
        authorization: "QQBot t",
      },
      body: '{"content":"hi"}',
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(seen[0], {
      path: "/v2/users/u/messages?x=1",
      host: "api.bot.qq.com",
      method: "POST",
      body: '{"content":"hi"}',
      key: undefined,
    })
    assert.equal((await fetch(`${base}/forward/api.bot.qq.com/x`)).status, 401)
    assert.equal(
      (
        await fetch(`${base}/forward/api.bot.qq.com/x`, {
          headers: { "x-relay-key": "x".repeat(24) },
        })
      ).status,
      401
    )
    assert.equal(
      (
        await fetch(`${base}/forward/evil.example.com/x`, {
          headers: { "x-relay-key": KEY },
        })
      ).status,
      403
    )
    // Webhook pass-through is limited to the channel endpoints
    const hook = await fetch(`${base}/api/channels/qq`, { method: "POST", body: "{}" })
    assert.equal(hook.status, 200)
    assert.equal(seen.at(-1)?.path, "/api/channels/qq")
    assert.equal((await fetch(`${base}/api/companion`)).status, 404)
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
  } finally {
    relay.close()
    upstream.close()
  }
})
