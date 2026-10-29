import { createServer } from "node:http"

const downloads = {}
const parts = ["current-a", "current-b", "baseline-a", "baseline-b"]
createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8082")
  if (url.pathname === "/health") return res.end("ready")
  if (url.pathname === "/state")
    return res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(downloads))
  const mode = url.searchParams.get("mode")
  const part = url.pathname.slice(1).replace(/\.csv$/, "")
  if (parts.includes(part)) {
    const key = `${mode}:${part}`
    downloads[key] = (downloads[key] ?? 0) + 1
    const baseline = part.startsWith("baseline"),
      second = part.endsWith("b")
    const date = baseline
      ? second
        ? "2026-10-06"
        : "2026-10-05"
      : second
        ? "2026-10-13"
        : "2026-10-12"
    const value =
      baseline && mode === "zero"
        ? 0
        : second
          ? baseline || mode === "quiet"
            ? 200
            : 230
          : 100
    return res
      .writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${part}.csv"`,
      })
      .end(`date,site,amount\n${date},${second ? "B" : "A"},${value}\n`)
  }
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(
      `<!doctype html><html lang="en"><title>Periodic report fixture</title><h1>Known-answer weekly report parts</h1>${parts.map((part) => `<a href="/${part}.csv?mode=${encodeURIComponent(mode)}">${part}</a>`).join("<br>")}</html>`
    )
}).listen(8082, "127.0.0.1", () => console.log("Periodic report fixture ready"))
