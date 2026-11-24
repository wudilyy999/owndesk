// A scoped Docker Engine endpoint. The candidate can reach only this listener;
// the real Unix socket and the immutable launch recipe stay with the trusted Worker.
import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { pipeline } from "node:stream/promises"
import { Transform } from "node:stream"
import { gatePolicy, demand } from "./workstation-gate-policy.mjs"
const maxIO = 64 * 1024 * 1024
function limiter(limit) {
  let n = 0
  return new Transform({
    transform(b, _e, cb) {
      n += b.length
      cb(n > limit ? new Error("Size limit") : null, b)
    },
  })
}
async function body(req) {
  let n = 0
  const parts = []
  for await (const b of req) {
    n += b.length
    demand(n <= 65536, 413)
    parts.push(b)
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString())
  } catch {
    demand(false, 400)
  }
  demand(parsed && typeof parsed === "object" && !Array.isArray(parsed), 400)
  return parsed
}
const safeError = (e) =>
  [400, 403, 404, 409, 413, 429].includes(e?.status) ? e.status : 503
export async function startWorkstationGate(cfg) {
  const policy = gatePolicy(cfg),
    socketPath = cfg.socketPath ?? "/var/run/docker.sock",
    token = randomBytes(32).toString("hex"),
    containers = new Map(),
    volumes = new Set(),
    execs = new Map(),
    sockets = new Set()
  let creates = Promise.resolve(),
    closed = false
  function exclusive(fn) {
    const p = creates.then(() => {
      demand(!closed)
      return fn()
    })
    creates = p.catch(() => {})
    return p
  }
  const daemon = (method, path, data) =>
    new Promise((resolve, reject) => {
      const q = http.request(
        {
          socketPath,
          path,
          method,
          headers: data ? { "content-type": "application/json" } : {},
          timeout: 45000,
        },
        resolve
      )
      q.once("timeout", () => q.destroy(Error("Daemon timeout")))
      q.once("error", reject)
      q.end(data ? JSON.stringify(data) : undefined)
    })
  async function json(method, path, data) {
    const resp = await daemon(method, path, data)
    let n = 0
    const parts = []
    for await (const b of resp) {
      n += b.length
      demand(n <= 4194304)
      parts.push(b)
    }
    const code = resp.statusCode
    if (code >= 400) throw Object.assign(Error("Docker request failed"), { status: code })
    return { code, data: n ? JSON.parse(Buffer.concat(parts).toString()) : null }
  }
  function auth(req) {
    const supplied = Buffer.from(String(req.headers["x-owndesk-session"] ?? ""))
    demand(
      !closed &&
        supplied.length === token.length &&
        timingSafeEqual(supplied, Buffer.from(token))
    )
  }
  function route(req) {
    auth(req)
    demand(/^\/(?!\/)/.test(req.url) && !/[\\#\s]/.test(req.url))
    const u = new URL(req.url, "http://gate")
    const p = decodeURIComponent(u.pathname).replace(/^\/v1\.\d{1,3}(?=\/)/, "")
    demand(!p.includes("..") && !p.includes("\\"))
    return { p, params: u.searchParams }
  }
  async function owned(ref) {
    let id = containers.get(ref)
    if (!id) {
      for (const v of containers.values())
        if (v === ref) {
          id = v
          break
        }
    }
    demand(id, 404)
    const { data: c } = await json("GET", "/containers/" + id + "/json")
    const name = c.Name.slice(1),
      { agent } = policy.object(name, ["ws", "viewer"])
    demand(
      c.Id === id && containers.get(name) === id && policy.owns(c.Config.Labels, agent)
    )
    return c
  }
  async function volumeOwned(n) {
    const { agent } = policy.object(n, ["home", "display"])
    demand(volumes.has(n), 404)
    const { data: v } = await json("GET", "/volumes/" + n)
    demand(policy.owns(v.Labels, agent))
    return v
  }
  const send = (res, code, v) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(v == null ? undefined : JSON.stringify(v))
  }
  function keys(p, allowed) {
    for (const k of p.keys()) demand(allowed.includes(k) && p.getAll(k).length === 1)
  }
  async function execRef(id) {
    const parent = execs.get(id)
    demand(parent, 404)
    await owned(parent)
    const { data: x } = await json("GET", "/exec/" + id + "/json")
    demand(x.ContainerID === parent)
    return x
  }
  async function handle(req, res) {
    const { p, params } = route(req),
      method = req.method
    if (p === "/_ping" && ["GET", "HEAD"].includes(method)) {
      res.writeHead(200, { "API-Version": "1.52", OSType: "linux" })
      res.end("OK")
      return
    }
    if (p === "/version" && method === "GET") {
      send(res, 200, {
        Version: "29.0.0",
        ApiVersion: "1.52",
        MinAPIVersion: "1.44",
        Os: "linux",
      })
      return
    }
    if (p.startsWith("/images/") && p.endsWith("/json") && method === "GET") {
      demand([cfg.image, cfg.ref].includes(p.slice(8, -5)), 404)
      send(res, 200, { Id: cfg.image, RepoTags: [cfg.ref], Os: "linux" })
      return
    }
    if (p === "/volumes/create" && method === "POST") {
      const b = await body(req),
        spec = policy.volume(b.Name, b)
      await exclusive(async () => {
        if (!volumes.has(b.Name)) {
          let exists
          try {
            exists = (await json("GET", "/volumes/" + b.Name)).data
          } catch (e) {
            if (e.status !== 404) throw e
          }
          demand(!exists, 409)
          const { data: v } = await json("POST", "/volumes/create", spec)
          demand(
            v.Name === b.Name &&
              policy.owns(v.Labels, spec.Labels["personal-agent.agent"])
          )
          volumes.add(b.Name)
        }
        send(res, 201, { Name: b.Name, Driver: "local", Labels: spec.Labels })
      })
      return
    }
    let m = /^\/volumes\/([a-zA-Z0-9_-]+)$/.exec(p)
    if (m && ["GET", "DELETE"].includes(method)) {
      keys(params, [])
      const v = await volumeOwned(m[1])
      if (method === "GET")
        send(res, 200, { Name: v.Name, Labels: v.Labels, Driver: "local" })
      else {
        await exclusive(async () => {
          await volumeOwned(v.Name)
          await json("DELETE", "/volumes/" + v.Name)
          volumes.delete(v.Name)
        })
        send(res, 204)
      }
      return
    }
    if (p === "/containers/create" && method === "POST") {
      keys(params, ["name"])
      const name = params.get("name"),
        b = await body(req),
        spec = policy.create(name, b)
      await exclusive(async () => {
        demand(!containers.has(name), 409)
        for (const mount of spec.HostConfig.Binds) await volumeOwned(mount.split(":")[0])
        const { data: c } = await json(
          "POST",
          "/containers/create?name=" + encodeURIComponent(name),
          spec
        )
        demand(/^[a-f0-9]{64}$/.test(c.Id))
        containers.set(name, c.Id)
        send(res, 201, c)
      })
      return
    }
    if (p === "/containers/json" && method === "GET") {
      keys(params, ["all", "filters", "limit", "size"])
      const list = []
      for (const [name, id] of containers) {
        const c = await owned(id)
        if (params.get("all") === "1" || c.State.Running)
          list.push({
            Id: id,
            Names: ["/" + name],
            Image: cfg.image,
            ImageID: cfg.image,
            State: c.State.Status,
            Labels: c.Config.Labels,
            Ports: [],
          })
      }
      send(res, 200, list)
      return
    }
    m =
      /^\/containers\/([a-zA-Z0-9_-]+)(?:\/(json|start|stop|restart|exec|archive))?$/.exec(
        p
      )
    if (m) {
      const c = await owned(m[1]),
        base = "/containers/" + c.Id,
        op = m[2]
      if (op === "json" && method === "GET") {
        send(res, 200, {
          Id: c.Id,
          Name: c.Name,
          Image: c.Image,
          State: c.State,
          Config: { Labels: c.Config.Labels, Env: c.Config.Env },
          HostConfig: {
            PortBindings: {},
            NetworkMode: c.HostConfig.NetworkMode,
            CapDrop: c.HostConfig.CapDrop,
            Sysctls: c.HostConfig.Sysctls,
            Dns: c.HostConfig.Dns,
          },
          NetworkSettings: { Ports: {} },
        })
        return
      }
      if (["start", "stop", "restart"].includes(op) && method === "POST") {
        keys(params, ["t"])
        const resp = await daemon(
          method,
          base + "/" + op + (op === "start" ? "" : "?t=5")
        )
        resp.resume()
        demand(resp.statusCode < 400, 409)
        send(res, resp.statusCode)
        return
      }
      if (!op && method === "DELETE") {
        keys(params, ["force", "v"])
        await json("DELETE", base + "?force=1&v=1")
        containers.delete(c.Name.slice(1))
        for (const [k, v] of execs) if (v === c.Id) execs.delete(k)
        send(res, 204)
        return
      }
      if (op === "exec" && method === "POST") {
        const b = await body(req)
        demand(
          !b.Privileged &&
            !b.User &&
            !b.Tty &&
            !b.WorkingDir &&
            !b.Env?.length &&
            Array.isArray(b.Cmd) &&
            b.Cmd.length > 0 &&
            b.Cmd.every((x) => typeof x === "string")
        )
        demand(execs.size < 512, 429)
        const { data: x } = await json("POST", base + "/exec", {
          Cmd: b.Cmd,
          User: "agent",
          AttachStdin: b.AttachStdin === true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Privileged: false,
        })
        demand(/^[0-9a-f]{64}$/.test(x.Id))
        execs.set(x.Id, c.Id)
        send(res, 201, x)
        return
      }
      if (op === "archive" && ["HEAD", "GET", "PUT"].includes(method)) {
        keys(params, ["path", "noOverwriteDirNonDir", "copyUIDGID"])
        const path = params.get("path")
        demand(
          (path === "/home/agent" || path?.startsWith("/home/agent/")) &&
            !path.split("/").includes("..") &&
            !/[\x00-\x1f\\]/.test(path)
        )
        const outbound = http.request({
          socketPath,
          method,
          path: base + "/archive?path=" + encodeURIComponent(path),
          headers: method === "PUT" ? { "content-type": "application/x-tar" } : {},
          timeout: 60000,
        })
        outbound.once("timeout", () => outbound.destroy(Error("Archive timeout")))
        const ready = new Promise((resolve, reject) => {
          outbound.once("response", resolve)
          outbound.once("error", reject)
        })
        if (method === "PUT")
          void pipeline(req, limiter(maxIO), outbound).catch(() => outbound.destroy())
        else outbound.end()
        const r = await ready,
          headers = {}
        for (const k of ["content-type", "x-docker-container-path-stat"])
          if (r.headers[k]) headers[k] = r.headers[k]
        res.writeHead(r.statusCode, headers)
        await pipeline(r, limiter(maxIO), res)
        return
      }
    }
    m = /^\/exec\/([a-f0-9]{64})\/json$/.exec(p)
    if (m && method === "GET") {
      const x = await execRef(m[1])
      if (!x.Running) execs.delete(m[1])
      send(res, 200, {
        ID: x.ID,
        Running: x.Running,
        ExitCode: x.ExitCode,
        ContainerID: x.ContainerID,
      })
      return
    }
    demand(false)
  }
  const { data: isolation } = await json(
    "GET",
    "/networks/" + encodeURIComponent(cfg.network)
  )
  demand(
    isolation.Driver === "bridge" &&
      isolation.Internal === true &&
      isolation.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated"
  )
  const pending = new Set()
  const server = http.createServer((req, res) => {
    if (pending.size >= 24) {
      send(res, 429, { message: "Too many workstation requests" })
      return
    }
    const operation = handle(req, res).catch((e) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const code = safeError(e)
      send(res, code, {
        message:
          code === 404 ? "No such container or volume" : "Workstation request refused",
      })
    })
    pending.add(operation)
    void operation.finally(() => pending.delete(operation))
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.once("close", () => sockets.delete(s))
  })
  server.on("upgrade", (req, down, head) => {
    down.setTimeout(90000, () => down.destroy())
    void (async () => {
      const { p, params } = route(req)
      const m = /^\/exec\/([a-f0-9]{64})\/start$/.exec(p)
      demand(m && req.method === "POST" && params.size === 0)
      const len = Number(req.headers["content-length"])
      demand(
        Number.isInteger(len) &&
          len > 0 &&
          len <= 256 &&
          !req.headers["transfer-encoding"]
      )
      await execRef(m[1])
      let buf = head
      while (buf.length < len) {
        const chunk = await new Promise((resolve, reject) => {
          const done = () => {
              down.off("readable", read)
              down.off("close", end)
            },
            read = () => {
              const b = down.read()
              if (b) {
                done()
                resolve(b)
              }
            },
            end = () => {
              done()
              reject(Error("Client closed"))
            }
          down.once("close", end)
          down.on("readable", read)
          read()
        })
        buf = Buffer.concat([buf, chunk])
      }
      const b = JSON.parse(buf.subarray(0, len))
      demand(!b.Detach && !b.Tty)
      const payload = JSON.stringify({ Detach: false, Tty: false })
      const q = http.request({
        socketPath,
        path: p,
        method: "POST",
        headers: {
          connection: "Upgrade",
          upgrade: "tcp",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      })
      q.on("error", () => down.destroy())
      q.on("response", (r) => {
        r.resume()
        down.destroy()
      })
      q.on("upgrade", (r, up, extra) => {
        down.write(
          "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n"
        )
        if (extra.length) down.write(extra)
        if (buf.length > len) up.write(buf.subarray(len))
        down.on("error", () => up.destroy())
        up.on("error", () => down.destroy())
        down.once("close", () => up.destroy())
        up.once("close", () => down.end())
        void pipeline(down, limiter(maxIO), up).catch(() => up.destroy())
        void pipeline(up, limiter(maxIO), down).catch(() => down.destroy())
      })
      q.end(payload)
    })().catch(() => down.destroy())
  })
  server.requestTimeout = 60000
  server.headersTimeout = 15000
  server.maxConnections = 40
  await new Promise((ok, fail) => {
    server.once("error", fail)
    server.listen(0, cfg.host, ok)
  })
  return {
    host: `tcp://${cfg.host}:${server.address().port}`,
    token,
    close: async () => {
      closed = true
      const done = new Promise((resolve) => server.close(resolve))
      for (const s of sockets) s.destroy()
      await done
      await Promise.allSettled([...pending])
      await creates
    },
  }
}
