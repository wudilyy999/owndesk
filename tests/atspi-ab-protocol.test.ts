import assert from "node:assert/strict"
import { test } from "node:test"
import { generateText, type ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { prepareModelContext, planContextCompaction } from "../lib/agent/context"
import { buildInstructions } from "../lib/agent/instructions"
import { toolsForTask } from "../lib/agent/tools"
import { nativeTools } from "../lib/agent/native-tools"
import {
  comparisonRequest,
  completedNativeRead,
  containsNativeObservation,
  omitNativeObservation,
} from "./atspi-ab-protocol"

const frame = {
  observationId: "fresh-frame",
  width: 1280,
  height: 800,
  window: { title: "Thunar" },
  accessibility: { source: "atspi2", status: "ok" },
  elements: [{ role: "push button", name: "Save", element_index: 7 }],
  tree: { role: "frame" },
}
const request = {
  model: "gpt-6.1-terra",
  store: false,
  input: [
    {
      role: "system",
      content:
        "# Identity\nOwnDesk\n# Workstation\nOld rules\n# Web and consent\nKeep consent.",
    },
    { type: "function_call", call_id: "call-1", name: "screen_capture", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: JSON.stringify(frame) },
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/jpeg;base64,test" }],
    },
  ],
  tools: [
    { name: "screen_capture", description: "AT-SPI observation" },
    {
      name: "pointer_click",
      description:
        "Click. Returns screenshot, available read-only AT-SPI elements, and observationId.",
    },
    { name: "desktop_list_windows" },
    { name: "desktop_get_window_state" },
    { name: "desktop_element_action" },
    { name: "complete_task" },
  ],
}

test("visual-only removes native data/tools without changing screenshot, ids or source", () => {
  const original = structuredClone(request)
  const body = comparisonRequest(request, "vision", false)
  assert.deepEqual(request, original)
  assert(!body.tools.some((tool: any) => tool.name.startsWith("desktop_")))
  assert.deepEqual(body.input[3], request.input[3])
  assert.equal(body.input[2].call_id, "call-1")
  assert.deepEqual(JSON.parse(body.input[2].output), {
    observationId: "fresh-frame",
    width: 1280,
    height: 800,
    window: { title: "Thunar" },
  })
  assert(body.input[0].content.includes("Keep consent."))
  assert(body.input[0].content.includes("visual-only"))
  assert.equal(body.model, request.model)
  assert.equal(body.store, false)
})

test("native-first gates the initial tool list, then retains original native observations", () => {
  const initial = comparisonRequest(request, "native-first", false)
  assert(!initial.tools.some((tool: any) => tool.name === "pointer_click"))
  assert(initial.tools.some((tool: any) => tool.name === "desktop_get_window_state"))
  const body = comparisonRequest(request, "native-first", true)
  assert(body.tools.some((tool: any) => tool.name === "desktop_element_action"))
  assert.equal(body.input[2].output, request.input[2].output)
  assert(body.input[0].content.includes("FALLBACK: reason"))
})

test("nested SDK text parts are stripped; unavailable trees do not unlock native-first", () => {
  const value = [{ type: "text", text: JSON.stringify({ type: "json", value: frame }) }]
  assert(containsNativeObservation(value))
  assert(!containsNativeObservation(omitNativeObservation(value)))
  assert(
    !containsNativeObservation({
      ...frame,
      accessibility: { source: "atspi2", status: "unavailable" },
    })
  )
})

test("unparsed native fragments fail closed before an invalid visual baseline is sent", () => {
  const body = structuredClone(request)
  body.input[2].output = '{"accessibility":{"source":"atspi2"},"elements":['
  assert.throws(() => comparisonRequest(body, "vision", false), /still contains native/)
})

test("hybrid unlock requires an explicit successful native read, not the automatic screenshot", () => {
  const action = {
    kind: "screen_capture",
    status: "succeeded",
    receipt: { output: frame },
  }
  assert(!completedNativeRead([action]))
  assert(
    !completedNativeRead([{ ...action, kind: "desktop_ax_snapshot", status: "rejected" }])
  )
  assert(completedNativeRead([{ ...action, kind: "desktop_get_window_state" }]))
})

test("real SDK wire requests and compaction sources keep a clean visual baseline", async () => {
  const config = {
    instructions: "",
    memories: [],
    workstationChannel: "desktop" as const,
  }
  const history: ModelMessage[] = [
    { role: "system", content: buildInstructions(config, "2026-10-30T00:00:00Z") },
    { role: "user", content: "Save the report through the desktop." },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_frame",
          toolName: "screen_capture",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_frame",
          toolName: "screen_capture",
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: JSON.stringify({ ...frame, epoch: 1, bootId: "boot" }),
              },
              { type: "image-data", data: "AA==", mediaType: "image/jpeg" },
            ],
          },
        },
      ],
    },
    { role: "assistant", content: "Continue checking the form." },
    { role: "user", content: "Continue." },
    { role: "assistant", content: "Check completion." },
  ]
  const compacted = planContextCompaction(history, 1, undefined, 30000)!
  assert(compacted)
  let calls = 0
  for (const messages of [history, compacted.messages]) {
    const model = createOpenAI({
      apiKey: "offline-placeholder",
      baseURL: "https://offline.invalid/v1",
      fetch: async (url, init) => {
        assert.equal(new URL(String(url)).hostname, "offline.invalid")
        const raw = JSON.parse(String(init!.body))
        const visual = comparisonRequest(raw, "vision", false)
        const hybrid = comparisonRequest(raw, "native-first", true)
        assert(!containsNativeObservation(visual.input))
        assert(!JSON.stringify(visual.input).includes('"Save"'))
        assert(
          containsNativeObservation(hybrid.input) ||
            JSON.stringify(hybrid.input).includes("Save")
        )
        if (messages === history) {
          assert(
            visual.input.some(
              (x: any) => x.type === "function_call_output" && x.call_id === "call_frame"
            )
          )
          assert(JSON.stringify(visual.input).includes("data:image/jpeg;base64,AA=="))
          assert(visual.input[0].content.includes("visual-only"))
          assert.equal(visual.store, false)
          assert.equal(visual.prompt_cache_key, raw.prompt_cache_key)
          assert(!visual.tools.some((x: any) => Object.hasOwn(nativeTools, x.name)))
        }
        calls++
        return new Response(
          JSON.stringify({ error: { message: "Offline comparison capture" } }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      },
    })("gpt-6.1-terra")
    await assert.rejects(
      generateText({
        model,
        ...prepareModelContext("openai/gpt-6.1-terra", messages, {
          taskId: "fixture",
          threadId: "fixture",
          segmentNo: 1,
          epoch: 1,
          bootId: "boot",
        }),
        tools: messages === history ? toolsForTask(config) : {},
        maxRetries: 0,
      }),
      /Offline comparison capture/
    )
  }
  assert.equal(calls, 2)
})
