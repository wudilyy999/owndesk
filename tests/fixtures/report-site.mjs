import { createServer } from "node:http"

let downloads = 0
const csv =
  "date,site,amount\n2026-10-12,A,100\n2026-10-13,B,200\n2026-10-14,A,110\n2026-10-15,B,210\n"
const page = (content) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Controlled report site</title><style>body{font:20px system-ui;max-width:720px;margin:70px auto;padding:20px}label{display:block;margin:15px 0}input,button{font:inherit;padding:8px}a{display:block;margin:20px 0}</style>${content}</html>`
createServer(async (req, res) => {
  const authenticated =
    process.env.FIXTURE_AUTHENTICATED === "1" ||
    (req.headers.cookie ?? "").includes("fixture-session=demo")
  if (req.url === "/health") {
    res.end("ready")
    return
  }
  if (req.url === "/state") {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ downloads }))
    return
  }
  if (req.url === "/login" && req.method === "POST") {
    let data = ""
    for await (const chunk of req) data += chunk
    const form = new URLSearchParams(data)
    if (form.get("username") !== "demo" || form.get("password") !== "demo") {
      res.writeHead(403).end("Fixture credentials rejected")
      return
    }
    res
      .writeHead(303, {
        Location: "/reports",
        "Set-Cookie":
          "fixture-session=demo; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/",
      })
      .end()
    return
  }
  if (!authenticated) {
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        page(
          '<h1>Sign in to reports</h1><form method="POST" action="/login"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>'
        )
      )
    return
  }
  if (req.url === "/report.csv") {
    downloads++
    res
      .writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="week-report.csv"',
      })
      .end(csv)
    return
  }
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(
      page(
        '<h1>Reports</h1><p>Signed in as demo</p><a href="/report.csv">Week report</a><label>Shared field <input name="shared" value=""></label>'
      )
    )
}).listen(8081, process.env.FIXTURE_HOST ?? "127.0.0.1", () =>
  console.log("Controlled report fixture ready")
)
