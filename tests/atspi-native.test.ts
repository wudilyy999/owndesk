import assert from "node:assert/strict"
import test from "node:test"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { compactContext } from "@/lib/agent/context"
import { toolsForTask } from "@/lib/agent/tools"
import { nativeSchemas } from "@/workstation/controller/native-schema.mjs"

const observationId = "f9cb0de4-5ed7-471c-91c7-bc9e978614fa"
test("native refined schemas serialize into actual SDK tool definitions without network requests", async () => {
  let captured: any
  const model = createOpenAICompatible({
    name: "native-schema-fixture",
    baseURL: "http://native-schema.invalid/v1",
    apiKey: "offline-placeholder",
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "native-schema.invalid")
      captured = JSON.parse(String(init!.body))
      return new Response(
        JSON.stringify({ error: { message: "Offline native schema capture complete" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    },
  }).chatModel("native-schema")
  const tools = toolsForTask({ workstationChannel: "desktop" })
  await assert.rejects(
    generateText({ model, prompt: "Check native tools", tools, maxRetries: 0 }),
    /Offline native schema capture complete/
  )
  for (const name of Object.keys(nativeSchemas)) {
    const definition = captured.tools.find(
      (entry: any) => entry.function.name === name
    ).function
    assert.equal(definition.parameters.type, "object")
    assert(Object.keys(definition.parameters.properties).length)
  }
})
test("native input schemas bind observations and reject invalid boundaries", () => {
  for (const kind of [
    "desktop_element_action",
    "desktop_ax_action",
    "desktop_type",
    "desktop_tag_replace",
  ] as const)
    assert(!nativeSchemas[kind].safeParse({}).success)
  assert(
    nativeSchemas.desktop_element_action.safeParse({
      observationId,
      element_index: 3,
      operation: "press",
      dispatch: "background",
    }).success
  )
  assert(
    !nativeSchemas.desktop_element_action.safeParse({ observationId, element_index: -1 })
      .success
  )
  assert(
    !nativeSchemas.desktop_element_action.safeParse({ observationId, target: {} }).success
  )
  for (const target of [
    { name: "   " },
    { actions: [] },
    { states: [""] },
    { value: "" },
  ])
    assert(!nativeSchemas.desktop_ax_action.safeParse({ observationId, target }).success)
  assert(
    !nativeSchemas.desktop_element_action.safeParse({
      observationId,
      element_index: 1,
      operation: "press",
      submit: true,
    }).success
  )
  assert(!nativeSchemas.desktop_get_window_state.safeParse({ max_nodes: 501 }).success)
  assert(!nativeSchemas.desktop_ax_snapshot.safeParse({ max_depth: 13 }).success)
  assert(!nativeSchemas.desktop_type.safeParse({ observationId, text: "x" }).success)
  assert(
    !nativeSchemas.desktop_tag_replace.safeParse({
      observationId,
      targetToken: observationId,
      replacement: "",
    }).success
  )
  const desktop = toolsForTask({ workstationChannel: "desktop" })
  for (const name of Object.keys(nativeSchemas))
    assert(name in desktop, `Native tool absent from desktop-only channel: ${name}`)
  assert(!("shell" in desktop))
})

test("native tree context retains intact records, hierarchy and original omission counts", () => {
  const nodes = Array.from({ length: 120 }, (_, i) => ({
    path: [0, 0, i],
    parentPath: [0, 0],
    element_index: i,
    role: "button",
    name: `Save ${i} ${"label ".repeat(12)}`,
    states: ["enabled"],
    bounds: { x: i * 2, y: 20, width: 20, height: 20 },
    objectId: { bus: ":1.5", path: `/node/${i}` },
  }))
  const value = {
    observationId,
    epoch: 4,
    bootId: "boot",
    window_id: "atspi-pid:15:path:0.0",
    effect: "dispatched",
    focus_verified: true,
    requested_dispatch: "auto",
    actual_dispatch: "foreground",
    foreground_fallback_used: true,
    reason: "Native Action interface is unavailable; use a fresh screenshot",
    app_name: "Native editor",
    window_title: "Draft document",
    screenshot_status: "ok",
    tag_text: "@a0.editor summarize this",
    accessibility: { source: "atspi2", status: "partial", truncated: true },
    elements: nodes,
    omittedElements: 7,
    tree: { path: [0, 0], role: "frame", children: nodes },
  }
  const messages: any = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "desktop_get_window_state",
          toolCallId: "native",
          output: { type: "json", value },
        },
      ],
    },
  ]
  const projected: any = (compactContext(messages)[0].content as any)[0].output.value
  assert.equal(projected.window_id, value.window_id)
  assert.equal(projected.effect, "dispatched")
  assert.equal(projected.focus_verified, true)
  assert.equal(projected.actual_dispatch, "foreground")
  assert.equal(projected.foreground_fallback_used, true)
  assert.equal(projected.reason, value.reason)
  assert.equal(projected.app_name, value.app_name)
  assert.equal(projected.window_title, value.window_title)
  assert.equal(projected.screenshot_status, "ok")
  assert.equal(projected.tag_text, value.tag_text)
  assert.equal(projected.accessibility.status, "partial")
  assert(projected.elements.length > 0 && projected.elements.length < 120)
  assert.equal(projected.omittedElements, 127 - projected.elements.length)
  assert.deepEqual(projected.elements[0], nodes[0])
  assert.deepEqual(projected.tree.children[0], nodes[0])
  assert.equal(projected.tree.children.length, projected.elements.length)
  assert(JSON.stringify(projected).length <= 12000)
  assert.equal(value.elements.length, 120, "audit source is immutable")
})
