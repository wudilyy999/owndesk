import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
let count = 0
let failure
createServer((req, res) => {
  void (async () => {
    if (req.url === "/state") {
      res.end(JSON.stringify({ count, failure }))
      return
    }
    assert.equal(req.url, "/v1/chat/completions")
    assert.equal(req.headers.authorization, `Bearer ${process.env.FIXTURE_KEY}`)
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      assert(raw.length < 10000000)
    }
    assert(!raw.includes(process.env.FIXTURE_KEY))
    const body = JSON.parse(raw)
    const calls = body.messages.flatMap((message) => message.tool_calls ?? [])
    const latest = calls.at(-1)?.function.name
    const last = (name) => {
      const call = calls.findLast((call) => call.function.name === name)
      const content = body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === call.id
      ).content
      return JSON.parse(
        (Array.isArray(content)
          ? content.find((part) => part.type === "text").text
          : content
        ).split("\n")[0]
      )
    }
    let tool, input
    if (
      body.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("basic-cua-cancel")
      )
    ) {
      assert(
        !calls.some((call) => call.function.name === "shell"),
        "Cancellation must prevent another model request"
      )
      tool = "shell"
      input = {
        command:
          "while true; do date +%s%N >> /home/agent/basic-cua-heartbeat; sleep 0.1; done",
        timeout: 600,
      }
    } else if (!calls.some((call) => call.function.name === "browser_open")) {
      tool = "browser_open"
      input = {
        url: process.env.FIXTURE_REPORT_URL ?? "http://93.184.216.8:8081/reports",
      }
    } else if (
      latest === "screen_capture" &&
      calls.some((call) => call.function.name === "fs_write")
    ) {
      tool = "key_press"
      input = {
        observationId: last("screen_capture").observationId,
        key: "w",
        modifiers: ["ctrl"],
      }
    } else if (["browser_open", "request_takeover", "screen_capture"].includes(latest)) {
      tool = "browser_observe"
      input = { pageId: last("browser_open").pageId }
    } else if (latest === "browser_observe") {
      const observed = last("browser_observe")
      const base = { pageId: observed.pageId, observationId: observed.observationId }
      if (observed.text.includes("Signed in")) {
        tool = "browser_download"
        input = {
          ...base,
          ref: observed.elements.find((element) => element.name === "Week report").ref,
        }
      } else {
        tool = "browser_fill"
        input = {
          ...base,
          ref: observed.elements.find((element) => element.name === "username").ref,
          text: "demo",
        }
      }
    } else if (latest === "browser_fill") {
      tool = "request_takeover"
      input = { reason: "受控网站已填用户名，请在桌面输入样本密码并登录。" }
    } else if (latest === "browser_download") {
      tool = "fs_read"
      input = { path: last("browser_download").path }
    } else if (latest === "fs_read") {
      tool = "fs_write"
      input = { path: "cloud-report.csv", content: last("fs_read").content }
    } else if (latest === "fs_write" && process.env.FIXTURE_CLOSE_PAGE === "1") {
      tool = "screen_capture"
      input = {}
    } else if (latest === "fs_write" || latest === "key_press") {
      tool = "complete_task"
      input = {
        summary: "已下载受控云部署报表。",
        files: [
          { path: "cloud-report.csv", name: "cloud-report.csv", mediaType: "text/csv" },
        ],
      }
    } else throw new Error(`Unexpected cloud fixture tool ${latest}`)
    count++
    if (process.env.FIXTURE_DELAY_MS) await delay(Number(process.env.FIXTURE_DELAY_MS))
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `cloud-${count}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "cloud-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `cloud-call-${count}`,
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
    failure = error.message
    console.error(error)
    res.writeHead(500).end("Cloud fixture failed")
  })
}).listen(8080, "0.0.0.0")
