import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

// Synthetic, read-only console. Evaluation rules live separately on the host.
export type ConsoleState = {
  id: string
  layout: "sidebar" | "topbar"
  missing: boolean
  page: "home" | "products" | "instances" | "detail" | "backups" | "monitor"
  region: string
  instance: string
  tab: string
  range: string
  level: string
  applied: boolean
  events: {
    action: string
    value: string
    target: string
    before: string
    after: string
    visibleResult: string
  }[]
}
export const regions = ["华东一", "华北二"]
export function newConsole(
  layout: ConsoleState["layout"],
  missing = false
): ConsoleState {
  return {
    id: randomUUID(),
    layout,
    missing,
    page: "home",
    region: regions[0],
    instance: "",
    tab: "快照备份",
    range: "最近24小时",
    level: "全部",
    applied: false,
    events: [],
  }
}
export function consoleHeading(s: ConsoleState) {
  return {
    home: "控制台首页",
    products: "数据与存储",
    instances: "关系型数据库 · 实例列表",
    detail: "实例详情",
    backups: `备份与恢复 · ${s.tab}`,
    monitor: "可观测性 · 错误日志",
  }[s.page]
}
export function consoleInstances(s: ConsoleState) {
  return s.region === regions[0]
    ? ["db-demo-1010", "db-demo-101"]
    : s.missing
      ? ["db-eval-2090", "db-other-310"]
      : ["db-eval-2090", "db-eval-209"]
}
export function act(s: ConsoleState, action: string, value = "") {
  const before = consoleHeading(s)
  switch (action) {
    case "home":
      s.page = "home"
      break
    case "catalog":
      s.page = "products"
      break
    case "database":
      s.page = "instances"
      s.instance = ""
      break
    case "region":
      if (!regions.includes(value)) throw new Error("Unknown region")
      s.region = value
      s.instance = ""
      s.page = "instances"
      break
    case "instance":
      if (!consoleInstances(s).includes(value)) throw new Error("Instance unavailable")
      s.instance = value
      s.page = "detail"
      s.tab = "快照备份"
      s.applied = false
      break
    case "backups":
      s.page = "backups"
      break
    case "monitor":
      s.page = "monitor"
      break
    case "tab":
      if (!["快照备份", "归档日志", "备份策略"].includes(value))
        throw new Error("Unknown tab")
      s.tab = value
      s.applied = false
      break
    case "range":
      if (!["最近24小时", "最近30分钟", "最近7天"].includes(value))
        throw new Error("Unknown range")
      s.range = value
      s.applied = false
      break
    case "level":
      if (!["全部", "仅异常", "仅成功"].includes(value)) throw new Error("Unknown level")
      s.level = value
      s.applied = false
      break
    case "apply":
      s.applied = true
      break
    default:
      throw new Error("Unknown action")
  }
  const target = (
    {
      home: "控制台首页",
      catalog: "数据与存储",
      database: "关系型数据库",
      region: value,
      instance: "管理 " + value,
      backups: "备份与恢复",
      monitor: "可观测性",
      tab: value,
      range: value,
      level: value,
      apply: "应用筛选",
    } as Record<string, string>
  )[action]
  s.events.push({
    action,
    value,
    target,
    before,
    after: consoleHeading(s),
    visibleResult: `${s.region} / ${s.instance} / ${s.tab} / ${s.range} / ${s.level} / ${s.applied ? "已应用" : "未应用"}`,
  })
}

export function renderConsole(s: ConsoleState) {
  const button = (text: string, action: string, value = "", active = false) =>
    `<button class="${active ? "active" : ""}" onclick='send(${JSON.stringify(action)},${JSON.stringify(value)})'>${text}</button>`
  const menu = [button("控制台首页", "home"), button("数据与存储", "catalog")]
  if (s.page !== "home") menu.push(button("关系型数据库", "database"))
  if (s.instance)
    menu.push(
      button("实例概览", "instance", s.instance),
      button("可观测性", "monitor"),
      button("备份与恢复", "backups")
    )
  let content = ""
  if (s.page === "home")
    content = `<p>欢迎进入云资源控制台。</p><div class="tiles">${button("计算与网络", "home")}${button("数据与存储", "catalog")}${button("观测与运维", "monitor")}</div>`
  if (s.page === "products")
    content = `<p>数据服务</p><div class="tiles">${button("对象存储", "catalog")}${button("关系型数据库", "database")}${button("数据传输", "catalog")}</div>`
  if (s.page === "instances")
    content = `<div class="toolbar"><b>地域：</b>${regions.map((r) => button(r, "region", r, s.region === r)).join("")}</div><table><tr><th>实例 ID</th><th>状态</th><th>操作</th></tr>${consoleInstances(
      s
    )
      .map(
        (id) =>
          `<tr><td>${id}</td><td>运行中</td><td>${button("管理 " + id, "instance", id)}</td></tr>`
      )
      .join("")}</table>`
  if (s.page === "detail")
    content = `<p>实例 ${s.instance} 运行正常。</p><p>选择导航栏目查看实例数据。</p>`
  if (s.page === "monitor")
    content = `<p>当前为实例错误日志栏目。资源变更功能已禁用。</p>`
  if (s.page === "backups") {
    const tabs =
      s.layout === "sidebar"
        ? ["快照备份", "归档日志", "备份策略"]
        : ["备份策略", "快照备份", "归档日志"]
    content = `<div class="toolbar">${tabs.map((t) => button(t, "tab", t, t === s.tab)).join("")}</div>`
    if (s.tab === "归档日志")
      content += `<div class="panel"><p><b>时间范围</b></p>${["最近24小时", "最近30分钟", "最近7天"].map((v) => button(v, "range", v, s.range === v)).join("")}<p><b>记录状态</b></p>${["全部", "仅异常", "仅成功"].map((v) => button(v, "level", v, s.level === v)).join("")}<p>${button("应用筛选", "apply")}</p></div><p>当前筛选：${s.range} · ${s.level} · ${s.applied ? "已应用" : "未应用"}</p><table><tr><th>时间</th><th>归档记录</th><th>状态</th></tr><tr><td>10:20</td><td>归档段 008</td><td>异常</td></tr></table>`
    else content += `<p>${s.tab}列表（只读）</p>`
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${consoleHeading(s)} - 云控制台演练</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#202a38;font:17px system-ui,sans-serif}header{height:64px;background:#18263b;color:white;display:flex;align-items:center;padding:0 24px;gap:30px}small{font-size:13px;color:#c6cbd5}nav{background:white;padding:16px;display:${s.layout === "sidebar" ? "flex" : "block"};${s.layout === "sidebar" ? "width:210px;min-height:700px;flex-direction:column;float:left" : "border-bottom:1px solid #ddd"}}main{padding:26px;${s.layout === "sidebar" ? "margin-left:210px" : ""}}h1{font-size:25px;margin:0 0 18px}button{font:inherit;background:white;color:#263648;border:1px solid #cdd3dd;border-radius:6px;padding:11px 15px;margin:5px;cursor:pointer}button:hover{background:#edf3ff}button.active{background:#e7efff;border-color:#526eac;color:#24457d}nav button{text-align:left}table{border-collapse:collapse;background:white;width:100%;margin-top:20px}td,th{padding:15px;text-align:left;border-bottom:1px solid #e4e8ee}.toolbar,.panel{background:white;padding:13px;margin:15px 0;border-radius:6px}.tiles{display:flex;gap:15px;margin-top:25px}.identity{font-size:15px;color:#526176;margin-bottom:20px}</style><header><b>云控制台</b><span>只读演练环境</span><small>合成页面，不连接真实云账号</small></header><nav>${menu.join("")}</nav><main><h1>${consoleHeading(s)}</h1><div class="identity">地域：${s.region}${s.instance ? `　当前实例：${s.instance}` : ""}</div>${content}</main><script>async function send(action,value){const r=await fetch('/sessions/${s.id}/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})});if(!r.ok)throw Error(await r.text());location.reload()}</script></html>`
}

export function createConsoleServer() {
  const sessions = new Map<string, ConsoleState>()
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/sessions") {
        let raw = ""
        for await (const chunk of req) raw += chunk
        const input = JSON.parse(raw)
        if (!["sidebar", "topbar"].includes(input.layout))
          throw new Error("Unknown layout")
        const s = newConsole(input.layout, !!input.missing)
        sessions.set(s.id, s)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(s))
        return
      }
      if (req.url === "/health") {
        res.end("ready")
        return
      }
      const match = /^\/sessions\/([a-f0-9-]+)(\/state|\/action)?$/.exec(req.url ?? "")
      const s = match && sessions.get(match[1])
      if (!s) {
        res.writeHead(404).end("Not found")
        return
      }
      if (req.method === "GET" && !match[2]) {
        res.setHeader("Content-Type", "text/html;charset=utf-8")
        res.end(renderConsole(s))
        return
      }
      if (req.method === "GET" && match[2] === "/state") {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(s))
        return
      }
      if (req.method === "POST" && match[2] === "/action") {
        let raw = ""
        for await (const chunk of req) raw += chunk
        const a = JSON.parse(raw)
        act(s, a.action, a.value)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(s))
        return
      }
      res.writeHead(405).end("Method not allowed")
    } catch (error) {
      res.writeHead(400).end(String(error))
    }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createConsoleServer().listen(Number(process.argv[2] ?? 18087), "127.0.0.1")
}
