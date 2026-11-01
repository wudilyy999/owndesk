// Fixed-IP egress relay for the companion channels. Run it on a machine whose public IP is
// stable (a small VPS). owndesk sends calls for QQ / WeChat there, and QQ / WeChat see the
// VPS address, which is the one you put on their IP allowlist.
//
//   owndesk  --https-->  https://relay.example.com/forward/api.bot.qq.com/app/getAppAccessToken
//   relay    --https-->  https://api.bot.qq.com/app/getAppAccessToken
//
// Safe by construction: it refuses to start without RELAY_KEY, only forwards to hosts in
// RELAY_HOSTS, and never follows redirects. Optional: with APP_UPSTREAM set it also passes
// /api/channels/* through to owndesk, so the same VPS can be the public webhook URL.
// No dependencies; Node 20+.
import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import { request as httpRequest } from "node:http"
import { timingSafeEqual } from "node:crypto"

const DEFAULT_HOSTS =
  "api.bot.qq.com,bots.qq.com,sandbox.api.sgroup.qq.com,api.weixin.qq.com"

export function createRelay(config) {
  const key = Buffer.from(config.key ?? "")
  if (key.length < 16) throw new Error("RELAY_KEY must be at least 16 characters")
  const hosts = new Set(
    (config.hosts ?? DEFAULT_HOSTS)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )
  const upstreamRequest = config.upstreamInsecure ? httpRequest : httpsRequest
  const app = config.appUpstream ? new URL(config.appUpstream) : null
  const hop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "x-relay-key",
  ])

  const authorised = (header) => {
    const given = Buffer.from(String(header ?? ""))
    return given.length === key.length && timingSafeEqual(given, key)
  }
  const pipe = (req, res, options, requestFn) => {
    const upstream = requestFn(options, (answer) => {
      const headers = { ...answer.headers }
      delete headers["transfer-encoding"]
      delete headers.connection
      res.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(res)
    })
    upstream.setTimeout(config.timeoutMs ?? 30_000, () =>
      upstream.destroy(new Error("timeout"))
    )
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "upstream", message: error.message }))
    })
    req.pipe(upstream)
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay")
    const forward = /^\/forward\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (forward) {
      if (!authorised(req.headers["x-relay-key"])) {
        res.writeHead(401, { "content-type": "application/json" })
        return res.end('{"error":"unauthorized"}')
      }
      const host = decodeURIComponent(forward[1]).toLowerCase()
      if (!hosts.has(host)) {
        res.writeHead(403, { "content-type": "application/json" })
        return res.end('{"error":"host not allowed"}')
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !hop.has(name))
      )
      const target = config.upstreamResolve?.(host) ?? { host, port: undefined }
      return pipe(
        req,
        res,
        {
          method: req.method,
          hostname: target.host,
          port: target.port,
          path: `${forward[2] ?? "/"}${url.search}`,
          headers: { ...headers, host },
        },
        upstreamRequest
      )
    }
    // Webhook pass-through: only the channel endpoints, never the rest of the app
    if (app && /^\/api\/channels\/(qq|wechat-oa)\/?$/.test(url.pathname)) {
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !hop.has(name))
      )
      return pipe(
        req,
        res,
        {
          method: req.method,
          hostname: app.hostname,
          port: app.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, host: app.host },
        },
        app.protocol === "http:" ? httpRequest : httpsRequest
      )
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" })
      return res.end("ok")
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end('{"error":"not found"}')
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRelay({
    key: process.env.RELAY_KEY,
    hosts: process.env.RELAY_HOSTS,
    appUpstream: process.env.APP_UPSTREAM,
  })
  const port = Number(process.env.PORT ?? 8787)
  server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
    console.log(`channel relay listening on :${port}`)
  )
}
