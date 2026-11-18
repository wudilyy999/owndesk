import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

// An explicit protocol fixture, independent of unpublished historical images.
// The current host must reject this contract before attempting any operation.
const bootId = randomUUID()
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json")
  if (request.method === "GET" && request.url === "/health") {
    response.end(
      JSON.stringify({
        ready: true,
        protocolVersion: 4,
        epoch: 0,
        mode: "idle",
        bootId,
        active: 0,
        shellUsed: false,
      })
    )
  } else {
    response.writeHead(400).end(JSON.stringify({ error: "Legacy protocol fixture" }))
  }
}).listen(6079, "127.0.0.1")
