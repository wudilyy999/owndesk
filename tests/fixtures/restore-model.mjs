import assert from "node:assert/strict"
import { createServer } from "node:http"

const calls = {}
createServer((req, res) => {
  void (async () => {
    if (req.url === "/state") {
      res.end(JSON.stringify(calls))
      return
    }
    assert.equal(req.headers.authorization, `Bearer ${process.env.FIXTURE_KEY}`)
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      assert(raw.length < 10000000)
    }
    const body = JSON.parse(raw)
    calls[body.model] = (calls[body.model] ?? 0) + 1
    if (body.model === "restore-pending") return // Commit receipt/count, withhold a possibly billed answer.
    const tools = body.messages.flatMap((message) => message.tool_calls ?? [])
    let tool, input
    if (body.model === "restore-unknown") {
      assert.equal(calls[body.model], 1, "Unknown submit was automatically regenerated")
      tool = "shell"
      input = {
        command: "curl --max-time 600 -X POST http://93.184.216.10:8082/submit",
        timeout: 650,
      }
    } else {
      assert.equal(body.model, "restore-browser")
      const last = tools.at(-1)
      const result =
        last &&
        JSON.parse(
          body.messages.find((m) => m.role === "tool" && m.tool_call_id === last.id)
            .content
        )
      if (!tools.some((call) => call.function.name === "browser_open")) {
        tool = "browser_open"
        input = { url: "http://93.184.216.8:8081/reports" }
      } else if (last.function.name === "browser_open") {
        tool = "browser_observe"
        input = { pageId: result.pageId }
      } else {
        assert.equal(last.function.name, "browser_observe")
        assert(
          result.text.includes("Signed in as demo"),
          "Restored browser login cookie was lost"
        )
        tool = "complete_task"
        input = { summary: "恢复后的真实浏览器仍已登录受控站点。", files: [] }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `restore-${body.model}-${calls[body.model]}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `restore-call-${body.model}-${calls[body.model]}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(input) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
    )
  })().catch((error) => {
    console.error(error)
    res.writeHead(500).end("Restore fixture assertion failed")
  })
}).listen(8080, "0.0.0.0")
