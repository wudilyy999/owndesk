import { createServer } from "node:http"
import { mkdir, appendFile } from "node:fs/promises"
const directory = "/home/agent/.fixture-effects"
await mkdir(directory, { recursive: true })
createServer(async (req, res) => {
  if (req.url === "/health") {
    res.end("ready")
    return
  }
  if (req.url === "/download") {
    await appendFile(`${directory}/downloads`, "download\n")
    setTimeout(
      () =>
        res
          .writeHead(200, {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="evidence.csv"',
          })
          .end("name,count\nfixture,1\n"),
      1500
    )
    return
  }
  if (req.url === "/submit" && req.method === "POST") {
    await appendFile(`${directory}/submits`, "submit\n")
    // Deliberately withhold the reply after committing the external effect.
    return
  }
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end('<html><body><a href="/download">Download</a></body></html>')
}).listen(8082, process.env.FIXTURE_HOST ?? "127.0.0.1")
