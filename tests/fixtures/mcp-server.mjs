import { createServer } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

function makeServer(onWrite) {
  const server = new McpServer({ name: "fixture", version: "1.0.0" })
  server.registerTool(
    "fixture_read",
    {
      description: "Read controlled data",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ({ content: [{ type: "text", text: `Read: ${query}` }] })
  )
  server.registerTool(
    "fixture_write",
    {
      description: "Write controlled data",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ text }) => {
      onWrite(text)
      return { content: [{ type: "text", text: `Written: ${text}` }] }
    }
  )
  return server
}
export async function startMcpFixture() {
  const writes = [],
    tokens = [],
    sessions = []
  const http = createServer(async (req, res) => {
    try {
      if (req.url === "/token") {
        let body = ""
        for await (const chunk of req) body += chunk
        const params = new URLSearchParams(body)
        tokens.push(Object.fromEntries(params))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "Bearer",
            expires_in: params.get("grant_type") === "refresh_token" ? 3600 : 1,
          })
        )
        return
      }
      if (req.url !== "/mcp") {
        res.writeHead(404)
        res.end()
        return
      }
      if (req.headers.authorization !== "Bearer fixture-access") {
        res.writeHead(401)
        res.end()
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      const server = makeServer((text) => {
        writes.push(text)
        if (text === "lose-receipt") res.destroy()
      })
      sessions.push(server)
      await server.connect(transport)
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(500)
        res.end(String(error))
      }
    }
  })
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    writes,
    tokens,
    close: async () => {
      for (const server of sessions) await server.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    },
  }
}
if (process.argv.includes("--stdio"))
  await makeServer(() => {}).connect(new StdioServerTransport())
