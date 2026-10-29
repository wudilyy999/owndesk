import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import path from "node:path"
import { generateText, type ModelMessage, type ToolResultPart } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import {
  compactContext,
  forProvider,
  prepareModelContext,
  contextMessages,
  planContextCompaction,
  estimateContextTokens,
  validateContextSummary,
  isContextWindowError,
} from "@/lib/agent/context"
import { agentTools, toolsForCoordinateMode } from "@/lib/agent/tools"
import { buildInstructions } from "@/lib/agent/instructions"

test("plain DOM results keep bounded complete element records without adding screenshots", () => {
  const input: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "browser_observe",
          toolCallId: "dom",
          output: {
            type: "json",
            value: {
              observationId: "dom",
              elements: Array.from({ length: 150 }, (_, i) => ({
                ref: `r${i}`,
                tag: "button",
                name: `Control ${i} ${"label ".repeat(20)}`,
                type: null,
              })),
              text: "page data ".repeat(5000),
              textRefs: [{ ref: "t0", tag: "p", text: "Order total" }],
            },
          },
        },
      ],
    },
  ]
  const result = compactContext(input)
  const output = (result[0].content as ToolResultPart[])[0].output
  assert(output.type === "json")
  const value = output.value as any
  assert(JSON.stringify(value).length <= 12000)
  assert(value.elements.length > 20 && value.elements.length < 150)
  assert.equal(value.omittedElements, 150 - value.elements.length)
  assert.deepEqual(
    value.elements[0],
    (input[0].content as any)[0].output.value.elements[0]
  )
  assert(!("image" in value))
})

function screenshot(id: string, epoch: number, bootId: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "screen_capture",
        output: {
          type: "content",
          value: [
            { type: "text", text: JSON.stringify({ observationId: id, epoch, bootId }) },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: { type: "data", data: `image-${id}` },
            },
          ],
        },
      },
    ],
  }
}

test("AT-SPI observations preserve availability and complete native records alongside recent screenshots", () => {
  const elements = Array.from({ length: 60 }, (_, index) => ({
    role: "push button",
    name: `Save ${index} ${"label ".repeat(15)}`,
    states: ["showing", "enabled"],
    bounds: { x: index * 10, y: 100, width: 80, height: 24 },
  }))
  const messages = ["old", "previous", "current"].map((id) => {
    const message = screenshot(id, 4, "boot")
    const part = (message.content as any)[0].output.value[0]
    part.text = JSON.stringify({
      observationId: id,
      epoch: 4,
      bootId: "boot",
      width: 1280,
      height: 800,
      accessibility: { source: "atspi2", status: "partial", truncated: true },
      elements,
    })
    return message
  })
  const result = compactContext(messages) as any[]
  assert.equal(
    result.flatMap((m) => m.content[0].output.value).filter((p) => p.type === "file")
      .length,
    2
  )
  const text = result[2].content[0].output.value[0].text
  const projected = JSON.parse(text)
  assert.equal(projected.accessibility.status, "partial")
  assert.equal(projected.accessibility.truncated, true)
  assert(projected.elements.length > 0 && projected.elements.length < elements.length)
  assert.equal(projected.omittedElements, elements.length - projected.elements.length)
  assert.deepEqual(projected.elements[0], elements[0])
  assert(text.length <= 12000)
})

test("even the newest large tool output is bounded with its beginning and error tail retained", () => {
  const input: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_large",
          toolName: "shell",
          output: {
            type: "error-text",
            value: `START\n${"x".repeat(70000)}\nFATAL: permission denied`,
          },
        },
      ],
    },
  ]
  const original = JSON.stringify(input)
  const result = compactContext(input)[0]
  assert(result.role === "tool")
  const part = result.content[0]
  assert(part.type === "tool-result" && part.output.type === "error-text")
  assert.equal(part.toolCallId, "call_large")
  assert.equal(part.output.value.length, 12000)
  assert(part.output.value.startsWith("START\n"))
  assert(part.output.value.endsWith("FATAL: permission denied"))
  assert(part.output.value.includes("Tool output trimmed"))
  assert.equal(JSON.stringify(input), original, "the audit history is immutable")
})

test("old output batches compact together while call/result pairs and intermediate prefixes stay stable", () => {
  const turns: ModelMessage[][] = Array.from({ length: 12 }, (_, index) => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call_${index}`,
          toolName: "shell",
          input: { command: `read-file-${index}` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${index}`,
          toolName: "shell",
          output: { type: "text", value: `${index}: ${"x".repeat(2000)} END` },
        },
      ],
    },
  ])
  const seven = compactContext(turns.slice(0, 7).flat())
  const eight = compactContext(turns.slice(0, 8).flat())
  assert.deepEqual(eight.slice(0, seven.length), seven)
  const twelve = compactContext(turns.flat())
  const toolMessages = twelve.filter((message) => message.role === "tool")
  for (const [index, message] of toolMessages.entries()) {
    const part = message.content[0]
    assert(part.type === "tool-result" && part.output.type === "text")
    assert.equal(part.toolCallId, `call_${index}`)
    assert.equal(part.output.value.includes("Tool output trimmed"), index < 6)
    if (index < 6) assert.equal(part.output.value.length, 600)
  }
  assert.deepEqual(
    twelve.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-call" ? [part.toolCallId] : []
          )
        : []
    ),
    toolMessages.flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "tool-result" ? [part.toolCallId] : []
      )
    )
  )
})

test("cache routing follows the local thread and segment without creating remote conversation state", () => {
  const history: ModelMessage[] = [
    { role: "system", content: "Keep the completion contract and require approval." },
    { role: "user", content: "Create the requested directory; do not send messages." },
    screenshot("current", 4, "boot"),
  ]
  const session = {
    taskId: "f9cb0de4-5ed7-471c-91c7-bc9e978614fa",
    threadId: "030499a8-44f2-4f17-ab12-9443244657f8",
    segmentNo: 1,
    epoch: 4,
    bootId: "boot",
  }
  const original = JSON.stringify(history)
  const context = prepareModelContext("openai/gpt-6.1-sol", history, session)
  assert.deepEqual(context.instructions, [history[0]])
  assert.deepEqual(context.messages[0], history[1])
  const options = context.providerOptions!.openai
  assert.equal(options.store, false)
  assert.deepEqual(options.include, ["reasoning.encrypted_content"])
  assert(options.promptCacheKey.length <= 64)
  assert(!("previousResponseId" in options))
  assert(!("conversation" in options))
  const next = prepareModelContext("openai/gpt-6.1-sol", history, {
    ...session,
    taskId: "another-task-in-the-same-local-thread",
  })
  assert.equal(next.providerOptions!.openai.promptCacheKey, options.promptCacheKey)
  for (const changed of [{ threadId: "new-thread" }, { segmentNo: 2 }])
    assert.notEqual(
      prepareModelContext("openai/gpt-6.1-sol", history, { ...session, ...changed })
        .providerOptions!.openai.promptCacheKey,
      options.promptCacheKey
    )
  assert.equal(
    prepareModelContext("custom/test", history, session).providerOptions,
    undefined
  )
  assert.equal(JSON.stringify(history), original)
})

test("actual Responses serialization sends stateless reasoning and preserves tool IDs without remote item references", async () => {
  const history: ModelMessage[] = [
    { role: "system", content: "Inspect the desktop." },
    { role: "user", content: "Continue the current task." },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: {
            openai: {
              itemId: "rs_previous",
              reasoningEncryptedContent: "opaque-offline-reasoning",
            },
          },
        },
        {
          type: "tool-call",
          toolCallId: "call_frame",
          toolName: "screen_capture",
          input: {},
          providerOptions: { openai: { itemId: "fc_previous" } },
        },
      ],
    },
    screenshot("call_frame", 4, "boot"),
  ]
  const context = prepareModelContext("openai/gpt-6.1-sol", history, {
    taskId: "task",
    threadId: "thread",
    segmentNo: 1,
    epoch: 4,
    bootId: "boot",
  })
  const original = JSON.stringify(history)
  const captured: Record<string, any>[] = []
  const model = createOpenAI({
    apiKey: "offline-placeholder",
    baseURL: "https://offline.invalid/v1",
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "offline.invalid")
      captured.push(JSON.parse(String(init!.body)))
      return new Response(
        JSON.stringify({ error: { message: "Offline serialization capture" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    },
  })("gpt-6.1-sol")
  await assert.rejects(
    generateText({
      model,
      ...context,
      tools: { screen_capture: agentTools.screen_capture },
      maxRetries: 0,
    }),
    /Offline serialization capture/
  )
  assert.equal(captured.length, 1)
  const body = captured[0]
  assert.equal(body.store, false)
  assert.equal(body.prompt_cache_key, context.providerOptions!.openai.promptCacheKey)
  assert(body.include.includes("reasoning.encrypted_content"))
  assert(!body.input.some((part: any) => part.type === "item_reference"))
  assert(
    body.input.some(
      (part: any) =>
        part.type === "reasoning" && part.encrypted_content === "opaque-offline-reasoning"
    )
  )
  for (const type of ["function_call", "function_call_output"])
    assert.equal(body.input.find((part: any) => part.type === type).call_id, "call_frame")
  assert.equal(JSON.stringify(history), original)
})

test("model context retains only the latest two images of the current control epoch and boot", () => {
  const input = [
    screenshot("old", 3, "old-boot"),
    screenshot("discarded", 4, "boot"),
    screenshot("first", 4, "boot"),
    screenshot("latest", 4, "boot"),
    screenshot("foreign", 5, "boot"),
  ]
  const original = JSON.stringify(input)
  const compacted = compactContext(input, { epoch: 4, bootId: "boot" })
  const text = JSON.stringify(compacted)
  assert(text.includes("image-first"))
  assert(text.includes("image-latest"))
  for (const id of ["old", "discarded", "foreign"]) assert(!text.includes(`image-${id}`))
  assert.equal(JSON.stringify(input), original, "durable audit history remains intact")
  const lifted = forProvider("custom/test", compacted)
  assert.equal(lifted.filter((message) => message.role === "user").length, 2)
  assert(JSON.stringify(lifted).includes("image-first"))
  assert(JSON.stringify(lifted).includes("image-latest"))
  assert(
    !JSON.stringify(compactContext(input, { epoch: 4, bootId: "new-boot" })).includes(
      '"type":"file"'
    )
  )
})

test("screenshot limit is shared across tool, assistant and lifted user messages", () => {
  const provider = screenshot("provider", 4, "boot")
  assert(provider.role === "tool")
  const result = provider.content[0]
  assert(result.type === "tool-result")
  const input: ModelMessage[] = [
    screenshot("oldest", 4, "boot"),
    { role: "assistant", content: [result] },
    {
      role: "user",
      content: [{ type: "image", image: "lifted-latest-image" }],
      providerOptions: { owndesk: { screenshot: true, epoch: 4, bootId: "boot" } },
    },
    {
      role: "user",
      content: [{ type: "image", image: "stale-lifted-image" }],
      providerOptions: { owndesk: { screenshot: true, epoch: 4, bootId: "old-boot" } },
    },
  ]
  const original = JSON.stringify(input)
  const text = JSON.stringify(compactContext(input, { epoch: 4, bootId: "boot" }))
  assert(text.includes("image-provider"))
  assert(text.includes("lifted-latest-image"))
  assert(!text.includes("image-oldest"))
  assert(!text.includes("stale-lifted-image"))
  assert.equal(JSON.stringify(input), original)
})

test("desktop tools require a frame and consistently declare absolute screenshot pixels", () => {
  const observationId = "2ee6c0a6-7d53-4f7f-a583-2a63a54c9ebd"
  const schema = agentTools.pointer_click.inputSchema as any
  assert(!schema.safeParse({ coordinateMode: "pixels", x: 640, y: 400 }).success)
  assert(!schema.safeParse({ observationId, x: 640, y: 400 }).success)
  assert(
    schema.safeParse({ observationId, coordinateMode: "pixels", x: 640, y: 400 }).success
  )
  assert(
    schema.safeParse({ observationId, coordinateMode: "normalized_1000", x: 500, y: 500 })
      .success
  )
  assert(
    !schema.safeParse({ observationId, coordinateMode: "pixels", x: -1, y: 400 }).success
  )
  assert(
    !schema.safeParse({ observationId, coordinateMode: "pixels", x: 0.5, y: 0.5 }).success
  )
  const instructions = buildInstructions(
    { instructions: "", memories: [] },
    "2026-10-26T00:00:00Z"
  )
  assert.match(instructions, /this task uses coordinateMode=pixels/)
  assert.match(instructions, /640,400/)
  assert.match(instructions, /latest observationId/)
  const normalized = toolsForCoordinateMode("normalized_1000").pointer_click
    .inputSchema as any
  assert(
    normalized.safeParse({
      observationId,
      coordinateMode: "normalized_1000",
      x: 500,
      y: 500,
    }).success
  )
  assert(
    !normalized.safeParse({ observationId, coordinateMode: "pixels", x: 500, y: 500 })
      .success
  )
})

test("all SDK output kinds are bounded, valid, typed, immutable and preserve control metadata", () => {
  const payload = '\n"\\\u0001中文'.repeat(14000)
  const json = {
    content: payload,
    ok: false,
    effect: "unknown",
    exitCode: 1,
    error: "permission denied",
    path: "/home/agent/report.csv",
    entries: Array.from({ length: 2000 }, (_, n) => ({ n, text: payload.slice(0, 100) })),
  }
  const variants: ToolResultPart["output"][] = [
    { type: "text", value: payload },
    { type: "error-text", value: payload },
    { type: "json", value: json },
    { type: "error-json", value: json },
    { type: "execution-denied", reason: payload },
    { type: "execution-denied" },
    ...[null, true, 0, "", payload, [json, json]].map((value) => ({
      type: "json" as const,
      value,
    })),
    { type: "content", value: [] },
    {
      type: "content",
      value: Array.from({ length: 40 }, (_, index) => ({
        type: "text" as const,
        text: `${index}:${payload}`,
      })),
    },
  ]
  for (const output of variants) {
    const message: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolName: "test", toolCallId: "call", output }],
    }
    const before = JSON.stringify(message)
    for (const old of [false, true]) {
      const history: ModelMessage[] = [
        message,
        ...(old ? Array.from({ length: 11 }, () => message) : []),
      ]
      const result = compactContext(history)[0]
      assert(result.role === "tool" && result.content[0].type === "tool-result")
      const actual = result.content[0].output
      assert.equal(actual.type, output.type)
      const limit = old ? 600 : 12000
      if (actual.type === "json" || actual.type === "error-json") {
        assert(JSON.stringify(actual.value).length <= limit)
        if ("value" in output && output.value === json) {
          const value = actual.value as typeof json
          assert.equal(value.ok, false)
          assert.equal(value.effect, "unknown")
          assert.equal(value.exitCode, 1)
          assert.equal(value.error, "permission denied")
        }
      } else if (actual.type === "text" || actual.type === "error-text")
        assert(actual.value.length <= limit)
      else if (actual.type === "execution-denied")
        assert((actual.reason?.length ?? 0) <= limit)
      else if (actual.type === "content")
        assert(
          actual.value.reduce(
            (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
            0
          ) <= limit
        )
    }
    assert.equal(JSON.stringify(message), before)
  }
})

test("media returns keep one bound image; PDFs, audio, video, binary, text attachments and custom parts become bounded references", () => {
  const bytes = "OMITTED_MEDIA_BODY".repeat(10000)
  const parts: Extract<ToolResultPart["output"], { type: "content" }>["value"] = [
    { type: "text", text: "{ordinary text, not valid JSON" },
    {
      type: "text",
      text: JSON.stringify({
        epoch: 4,
        bootId: "boot",
        observationId: "latest",
        width: 1280,
        height: 800,
      }),
    },
    ...["application/pdf", "audio/wav", "video/mp4", "application/octet-stream"].map(
      (mediaType) => ({
        type: "file" as const,
        mediaType,
        filename: "attachment",
        data: { type: "data" as const, data: bytes },
      })
    ),
    {
      type: "file",
      mediaType: "application/pdf",
      filename: "ref.pdf",
      data: { type: "url", url: new URL("https://example.invalid/ref.pdf") },
    },
    {
      type: "file",
      mediaType: "application/pdf",
      data: { type: "reference", reference: { openai: "file-ref" } },
    },
    { type: "file", mediaType: "text/plain", data: { type: "text", text: bytes } },
    { type: "custom", providerOptions: { test: { payload: bytes } } },
    { type: "file-data", mediaType: "application/pdf", data: bytes },
    {
      type: "file-url",
      mediaType: "application/pdf",
      url: "data:application/pdf;base64," + bytes,
    },
    { type: "file-id", fileId: { openai: "file-id" } },
    { type: "file-reference", providerReference: { anthropic: "file-provider-ref" } },
    { type: "image-data", mediaType: "image/png", data: "old-image" },
    { type: "image-url", url: "https://example.invalid/screen.png" },
    { type: "image-file-id", fileId: "image-id" },
    { type: "image-file-reference", providerReference: { openai: "latest-image-ref" } },
  ]
  const history: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "media",
          toolCallId: "media",
          output: { type: "content", value: parts },
        },
      ],
    },
  ]
  const before = JSON.stringify(history)
  const result = compactContext(history, { epoch: 4, bootId: "boot" })
  const serialized = JSON.stringify(result)
  assert(serialized.length < 15000)
  assert(!serialized.includes(bytes))
  assert(!serialized.includes("data:application/pdf"))
  assert(serialized.includes("latest-image-ref"))
  const tool = result[0]
  assert(
    tool.role === "tool" &&
      tool.content[0].type === "tool-result" &&
      tool.content[0].output.type === "content"
  )
  assert.equal(
    tool.content[0].output.value.filter((part) => part.type === "file").length,
    1
  )
  const lifted = forProvider("custom/test", result)
  assert.equal(lifted.filter((message) => message.role === "user").length, 1)
  assert.equal(JSON.stringify(history), before)
  const unbound = compactContext(
    [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "unbound",
            toolName: "media",
            output: {
              type: "content",
              value: [
                parts[0],
                { type: "image-data", mediaType: "image/png", data: "unbound-image" },
              ],
            },
          },
        ],
      },
    ],
    { epoch: 4, bootId: "boot" }
  )
  assert(!JSON.stringify(unbound).includes("unbound-image"))
})

test("compaction keeps pinned inputs and complete recent tool batches and carries summaries forward", () => {
  const history: ModelMessage[] = [
    { role: "system", content: "Standing rules and memory snapshot" },
    { role: "user", content: "Earlier request" },
    { role: "assistant", content: "Earlier outcome" },
    { role: "user", content: "CURRENT GOAL and completion contract" },
  ]
  for (let index = 0; index < 8; index++) {
    history.push(
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "opaque old reasoning" },
          {
            type: "tool-call",
            toolName: "shell",
            toolCallId: `a${index}`,
            input: { command: "read " + "x".repeat(5000) },
          },
          {
            type: "tool-call",
            toolName: "fs_read",
            toolCallId: `b${index}`,
            input: { path: "/home/agent/report.csv" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "shell",
            toolCallId: `a${index}`,
            output: { type: "text", value: "done" },
          },
          {
            type: "tool-result",
            toolName: "fs_read",
            toolCallId: `b${index}`,
            output: {
              type: "json",
              value: { path: "/home/agent/report.csv", content: "中文\n".repeat(9000) },
            },
          },
        ],
      }
    )
    if (index === 3)
      history.push({ role: "user", content: "Owner correction: do not send email" })
  }
  const before = JSON.stringify(history)
  const plan = planContextCompaction(history, 3, undefined, 20000)
  assert(plan)
  assert(estimateContextTokens(plan.messages) <= 20000)
  assert(!JSON.stringify(plan.messages).includes("opaque old reasoning"))
  const checkpoint = {
    through: plan.through,
    summary: "Historical work; /home/agent/report.csv; unknown effects need review.",
  }
  const view = contextMessages(history, 3, checkpoint)
  assert(view.some((message) => message === history[0]))
  assert(view.some((message) => message === history[3]))
  assert(
    view.some((message) => message.content === "Owner correction: do not send email")
  )
  const pending = new Set<string>()
  for (const message of view)
    if (Array.isArray(message.content))
      for (const part of message.content) {
        if (part.type === "tool-call") pending.add(part.toolCallId)
        if (part.type === "tool-result") assert(pending.delete(part.toolCallId))
      }
  assert.equal(pending.size, 0)
  const next = planContextCompaction(
    history,
    3,
    { through: plan.through - 4, summary: "PREVIOUS CHECKPOINT" },
    20000
  )
  assert(next)
  assert(JSON.stringify(next.messages).includes("PREVIOUS CHECKPOINT"))
  assert.equal(JSON.stringify(history), before)
  assert.throws(
    () => contextMessages(history, 3, { through: history.length + 1, summary: "bad" }),
    /exceeds/
  )
})

test("GUI compaction retains task goals and observed state instead of nested trimmed wrappers", () => {
  const goal =
    "Verify /home/agent/交付/预算汇总.csv, set DejaVu Sans 11, then return and complete"
  const history: ModelMessage[] = [
    { role: "system", content: "Standing rules" },
    { role: "user", content: goal },
  ]
  for (let index = 0; index < 10; index++) {
    history.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "pointer_click",
            toolCallId: `gui-${index}`,
            input: { x: 400, y: 300 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "pointer_click",
            toolCallId: `gui-${index}`,
            output: {
              type: "content",
              value: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    epoch: 7,
                    bootId: "old-boot",
                    observationId: `old-${index}`,
                    window: {
                      title: "Appearance",
                      app_name: "xfce4-appearance-settings",
                    },
                    accessibility: {
                      source: "atspi2",
                      status: "partial",
                      truncated: true,
                    },
                    elements: [
                      ...Array.from({ length: 80 }, (_, n) => ({
                        role: "button",
                        name: `Unselected font ${n}`,
                        states: ["visible"],
                      })),
                      {
                        role: "table cell",
                        name: "DejaVu Sans Book",
                        states: ["selected"],
                      },
                      {
                        role: "spin button",
                        name: "Font size",
                        value: 11,
                        states: ["focused", "editable"],
                      },
                      {
                        role: "text",
                        name: "Location",
                        text: "/home/agent/交付/",
                        states: ["editable"],
                      },
                    ],
                  }),
                },
                {
                  type: "file",
                  mediaType: "image/jpeg",
                  data: { type: "data", data: "historical-image-body" },
                },
              ],
            },
          },
        ],
      }
    )
  }
  history.push({
    role: "user",
    content: "Keep the original budget file; this is a copy.",
  })
  const plan = planContextCompaction(history, 1, undefined, 20000)
  assert(plan)
  const payload = JSON.parse(String(plan.messages[1].content))
  assert.equal(payload.currentTask[0], goal)
  assert(payload.currentTask.includes("Keep the original budget file; this is a copy."))
  const transcript = JSON.stringify(payload.transcript)
  assert(transcript.includes("Appearance"))
  assert(transcript.includes("DejaVu Sans Book"))
  assert(transcript.includes('"value":11'))
  assert(transcript.includes("/home/agent/交付/"))
  assert(!transcript.includes("historical-image-body"))
  assert(!transcript.includes("old-boot"))
  assert(estimateContextTokens(plan.messages) <= 20000)
  const checkpoint = {
    through: plan.through,
    summary:
      "Observed font size 11 and delivery folder; next verify budget copy and finish.",
  }
  const view = contextMessages(history, 1, checkpoint)
  assert(view.some((m) => m.content === goal))
  assert(JSON.stringify(view).includes(checkpoint.summary))
  const recovered = planContextCompaction(
    history,
    1,
    {
      through: plan.through - 4,
      summary: "Legacy summary: application and current values were unknown.",
    },
    20000
  )
  assert(recovered)
  const resumed = JSON.parse(String(recovered.messages[1].content))
  assert.equal(resumed.currentTask[0], goal)
  assert(resumed.previousSummary.includes("Legacy summary"))
  assert(JSON.stringify(resumed.transcript).includes('"value":11'))
})

test("compaction retains browser leaf text, tool failures and denials without media bodies", () => {
  const history: ModelMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "Inspect the current filter state" },
  ]
  const outputs: ToolResultPart["output"][] = [
    {
      type: "json",
      value: {
        url: "https://example.test/console",
        elements: [],
        text: "Page shows backup-filter-ACTIVE",
        textRefs: [{ ref: "t1", text: "Instance id db-evidence-42" }],
      },
    },
    {
      type: "error-json",
      value: {
        error: "native target changed",
        rejectedBeforeEffect: true,
        effect: "none",
      },
    },
    { type: "execution-denied", reason: "Owner approval required for external send" },
    {
      type: "content",
      value: [
        { type: "text", text: "Audio transcript only" },
        {
          type: "file",
          mediaType: "audio/wav",
          data: { type: "data", data: "private-audio-bytes" },
        },
      ],
    },
  ]
  for (let n = 0; n < 8; n++)
    history.push(
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "inspect", toolCallId: `mixed-${n}`, input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "inspect",
            toolCallId: `mixed-${n}`,
            output: outputs[n % outputs.length],
          },
        ],
      }
    )
  const plan = planContextCompaction(history, 1, undefined, 20000)
  assert(plan)
  const payload = JSON.parse(String(plan.messages[1].content))
  const text = JSON.stringify(payload.transcript)
  for (const fact of [
    "backup-filter-ACTIVE",
    "db-evidence-42",
    "native target changed",
    "rejectedBeforeEffect",
    "Owner approval required",
    "Audio transcript only",
  ])
    assert(text.includes(fact), fact)
  assert(!text.includes("private-audio-bytes"))
})

test("committed memory deletion survives a misleading summary without resurrecting the saved value", () => {
  const history: ModelMessage[] = [
    { role: "system", content: "memory rules" },
    { role: "user", content: "goal" },
  ]
  for (const [name, value] of [
    ["memory_write", { ok: true, id: "note", saved: "obsolete preference" }],
    ["memory_forget", { ok: true, forgotten: "note" }],
  ] as const)
    history.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: name,
          toolCallId: name,
          output: { type: "json", value },
        },
      ],
    })
  const view = contextMessages(history, 1, {
    through: history.length,
    summary: "obsolete preference",
  })
  const overlay = view.find(
    (message) => message.role === "system" && message.content !== "memory rules"
  )!
  assert(String(overlay.content).includes('"forgotten":true'))
  assert(!String(overlay.content).includes("obsolete preference"))
})

test("invalid summaries and uncompactable current input fail explicitly without fabricating a fallback", () => {
  for (const [text, calls, finish] of [
    ["", [], "stop"],
    ["x".repeat(12001), [], "stop"],
    ["partial", [], "length"],
    ["summary", [{}], "tool-calls"],
  ] as const)
    assert.throws(() => validateContextSummary(text, [...calls], finish), /compaction/)
  assert.equal(validateContextSummary("valid summary", [], "stop"), "valid summary")
  assert.equal(
    planContextCompaction(
      [
        { role: "system", content: "standing" },
        { role: "user", content: "goal" },
      ],
      1,
      undefined,
      20000
    ),
    null
  )
})

test("provider-executed assistant results share the same output budget and long screenshot metadata remains usable", () => {
  const history: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-result",
          toolName: "provider-search",
          toolCallId: "built-in",
          output: { type: "text", value: "search-results".repeat(10000) },
        },
      ],
    },
  ]
  const result = compactContext(history)[0]
  assert(result.role === "assistant" && Array.isArray(result.content))
  const part = result.content[0]
  assert(part.type === "tool-result" && part.output.type === "text")
  assert.equal(part.output.value.length, 12000)
  const image = screenshot("frame", 4, "boot")
  assert(
    image.role === "tool" &&
      image.content[0].type === "tool-result" &&
      image.content[0].output.type === "content"
  )
  image.content[0].output.value.unshift({
    type: "text",
    text: "large DOM text ".repeat(3000),
  })
  const projected = compactContext([image], { epoch: 4, bootId: "boot" })[0]
  assert(
    projected.role === "tool" &&
      projected.content[0].type === "tool-result" &&
      projected.content[0].output.type === "content"
  )
  const texts = projected.content[0].output.value.filter((part) => part.type === "text")
  assert.equal(JSON.parse(texts[0].text).observationId, "frame")
  assert(texts.reduce((sum, part) => sum + part.text.length, 0) <= 12000)
})

test("Chinese history is locally reprojected to fit the summary request and tool batches are never split", () => {
  const history: ModelMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "goal" },
  ]
  for (let index = 0; index < 40; index++)
    history.push(
      { role: "assistant", content: "历史事实与文件路径".repeat(1000) },
      { role: "user", content: "更早的用户会话".repeat(1000) }
    )
  const plan = planContextCompaction(history, history.length, undefined, 20000)
  assert(plan)
  assert(estimateContextTokens(plan.messages) <= 20000)
  assert(JSON.stringify(plan.messages).includes("trimmed"))
  const batch: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "read", input: {} },
        { type: "tool-call", toolCallId: "b", toolName: "read", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "read",
          output: { type: "text", value: "a" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "read",
          output: { type: "text", value: "b" },
        },
      ],
    },
    { role: "assistant", content: "recent" },
    { role: "assistant", content: "latest" },
  ]
  assert.equal(planContextCompaction(batch, 0, undefined, 8000)?.through, 3)
})

test("explicit provider context rejections are distinguished from gateway, rate limit and timeout errors", () => {
  assert(
    isContextWindowError(
      Object.assign(new Error("Invalid request"), {
        statusCode: 400,
        data: { error: { code: "context_length_exceeded" } },
      })
    )
  )
  assert(
    isContextWindowError(
      Object.assign(new Error("prompt is too long"), { statusCode: 400 })
    )
  )
  assert(
    !isContextWindowError(
      Object.assign(new Error("maximum context length"), { statusCode: 502 })
    )
  )
  assert(
    !isContextWindowError(Object.assign(new Error("rate limited"), { statusCode: 429 }))
  )
  assert(!isContextWindowError(new Error("timeout")))
})

test("DBOS error serialization retains the compaction decision number used by owner review", async () => {
  const require = createRequire(import.meta.url)
  const codec = require(
    path.join(path.dirname(require.resolve("@dbos-inc/dbos-sdk")), "serialization.js")
  )
  const { ModelRequestError } = await import("@/worker/model")
  const { pool } = await import("@/db")
  try {
    const saved = await codec.serializeResErrorWithSerializer(
      new ModelRequestError("controlled compaction failure", -7),
      codec.DBOSJSON,
      codec.DBOSJSON.name()
    )
    const restored = await codec.deserializeResError(
      saved.serializedValue,
      saved.serialization,
      codec.DBOSJSON
    )
    assert.equal(restored.name, "ModelRequestError")
    assert.equal(restored.decisionNo, -7)
  } finally {
    await pool.end()
  }
})
