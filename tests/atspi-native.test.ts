import assert from "node:assert/strict"
import test from "node:test"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenAI } from "@ai-sdk/openai"
import { compactContext, prepareModelContext } from "@/lib/agent/context"
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

test("native context retains actionable records and omission counts while raw hierarchy stays intact", () => {
  const nodes = Array.from({ length: 120 }, (_, i) => ({
    path: [0, 0, i],
    parentPath: [0, 0],
    element_index: i,
    role: "button",
    name: `Save ${i} ${"label ".repeat(12)}`,
    title: `Save ${i} ${"label ".repeat(12)}`,
    pid: 15,
    states: ["enabled"],
    bounds: { x: i * 2, y: 20, width: 20, height: 20 },
    frame: {
      x: i * 2,
      y: 20,
      width: 20,
      height: 20,
      normalized_x: i / 640,
      normalized_y: 0.025,
    },
    objectId: { bus: ":1.5", path: `/node/${i}` },
    actions: [
      { name: "click", description: "Clicks this button", key_binding: "<Alt>s" },
    ],
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
  const { objectId, parentPath, title, pid, frame, actions, ...control } = nodes[0]
  assert.deepEqual(projected.elements[0], { ...control, actions: ["click"] })
  assert(!("tree" in projected))
  assert(!("objectId" in projected.elements[0]))
  assert(JSON.stringify(projected).length <= 12000)
  assert.equal(value.elements.length, 120, "audit source is immutable")
  assert.deepEqual(value.tree.children[0].objectId, objectId)
  assert.equal(value.tree.children[0].actions[0].description, "Clicks this button")
})

test("dense native observations keep late status, selected values and dialog controls in JSON and screenshot results", () => {
  const noise = Array.from({ length: 100 }, (_, i) => ({
    element_index: i,
    path: [3, 0, i],
    parentPath: [3, 0],
    role: "table cell",
    name: `Font ${i} ${"family ".repeat(25)}`,
    title: `Font ${i} ${"family ".repeat(25)}`,
    objectId: { bus: ":1.5", path: `/font/${i}` },
    pid: 15,
    states: ["enabled", "showing", "visible"],
    frame: { x: 20, y: i * 20, width: 100, height: 20, normalized_width: 0.08 },
    bounds: { x: 20, y: i * 20, width: 100, height: 20 },
    actions: [
      {
        name: "activate",
        description: "Activate the font family row",
        key_binding: "Enter",
      },
    ],
  }))
  const critical = [
    {
      element_index: 100,
      path: [3, 0, 100],
      role: "status bar",
      name: "3 files: 114 bytes",
      states: ["showing"],
    },
    {
      element_index: 101,
      path: [3, 0, 101],
      role: "spin button",
      name: "Font size",
      text: "11",
      value: 10,
      states: ["focused", "editable"],
    },
    {
      element_index: 102,
      path: [3, 0, 102],
      role: "table cell",
      name: "DejaVu Sans",
      states: ["selected"],
    },
    {
      element_index: 103,
      path: [3, 0, 103],
      role: "page tab",
      name: "Fonts",
      states: ["showing"],
    },
    {
      element_index: 104,
      path: [3, 0, 104],
      role: "button",
      name: "Select",
      states: ["enabled"],
      actions: [{ name: "click", description: "Confirms the dialog" }],
    },
    {
      element_index: 105,
      path: [3, 0, 105],
      role: "password text",
      name: "[redacted]",
      redacted: true,
      states: ["protected"],
    },
  ]
  const value = {
    observationId,
    epoch: 4,
    bootId: "boot",
    window_id: "atspi-pid:15:path:3.0",
    window: { title: "Appearance" },
    accessibility: {
      source: "atspi2",
      status: "partial",
      scope: "target_window",
      truncated: true,
      warnings: [{ error: "defunct_node" }],
      capturedAt: "2026-10-31T00:00:00Z",
      completedAt: "2026-10-31T00:00:01Z",
      pid: 15,
      visited: 120,
    },
    elements: [...noise, ...critical],
    tree: { path: [3, 0], role: "dialog", children: [...noise, ...critical] },
    omittedElements: 7,
  }
  const original = structuredClone(value)
  for (const image of [false, true]) {
    const message: any = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "dense",
          toolName: "desktop_get_window_state",
          output: image
            ? {
                type: "content",
                value: [
                  { type: "text", text: JSON.stringify(value) },
                  {
                    type: "file",
                    mediaType: "image/jpeg",
                    data: { type: "data", data: "original-pixels" },
                  },
                ],
              }
            : { type: "json", value },
        },
      ],
    }
    const output = (
      compactContext([message], { epoch: 4, bootId: "boot" })[0].content as any
    )[0].output
    const projected = image ? JSON.parse(output.value[0].text) : output.value
    assert(JSON.stringify(projected).length <= 12000)
    assert(
      projected.elements.length > critical.length &&
        projected.elements.length < value.elements.length
    )
    assert.deepEqual(
      projected.elements.slice(0, 3).map((n: any) => n.element_index),
      [100, 101, 102]
    )
    for (const name of [
      "3 files: 114 bytes",
      "Font size",
      "DejaVu Sans",
      "Fonts",
      "Select",
    ])
      assert(
        projected.elements.some((n: any) => n.name === name),
        `Dropped critical control ${name}`
      )
    assert.deepEqual(projected.elements.find((n: any) => n.name === "Select").actions, [
      "click",
    ])
    const spin = projected.elements.find((n: any) => n.name === "Font size")
    assert.equal(spin.text, "11")
    assert.equal(spin.value, 10)
    assert.equal(
      projected.omittedElements,
      value.elements.length + 7 - projected.elements.length
    )
    assert.equal(projected.observationId, observationId)
    assert.equal(projected.window_id, value.window_id)
    assert.equal(projected.accessibility.status, "partial")
    assert.equal(projected.accessibility.truncated, true)
    assert.deepEqual(projected.accessibility.warnings, value.accessibility.warnings)
    assert(!("tree" in projected))
    assert(!("capturedAt" in projected.accessibility))
    assert(!JSON.stringify(projected).includes("objectId"))
    if (image) assert.equal(output.value[1].data.data, "original-pixels")
  }
  assert.deepEqual(value, original, "the full native audit receipt is unchanged")
})

test("one oversized native record does not hide later small controls", () => {
  const value = {
    observationId,
    epoch: 4,
    bootId: "boot",
    accessibility: { source: "atspi2", status: "ok", truncated: false },
    elements: [
      {
        element_index: 0,
        path: [0, 0, 0],
        role: "button",
        name: "x".repeat(14000),
        actions: [{ name: "click" }],
      },
      {
        element_index: 1,
        path: [0, 0, 1],
        role: "button",
        name: "Select",
        actions: [{ name: "click" }],
      },
    ],
  }
  const message: any = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "desktop_ax_snapshot",
        toolCallId: "oversized",
        output: { type: "json", value },
      },
    ],
  }
  const projected = (compactContext([message])[0].content as any)[0].output.value
  assert.deepEqual(
    projected.elements.map((n: any) => n.element_index),
    [1]
  )
  assert.equal(projected.omittedElements, 1)
  assert.equal(value.elements.length, 2)
})

test("actual SDK requests keep native-only results image-free and allow explicit visual inspection", async () => {
  for (const withImage of [false, true]) {
    const metadata = {
      observationId,
      epoch: 4,
      bootId: "boot",
      window_id: "atspi-pid:15:path:0.0",
      screenshot_status: withImage ? "ok" : "omitted",
      ...(withImage ? { screenshot_reason: "requested" } : {}),
      accessibility: { source: "atspi2", status: "ok", truncated: false },
      elements: [{ element_index: 0, path: [0, 0, 0], role: "button", name: "Save" }],
    }
    const toolName = withImage ? "screen_capture" : "desktop_get_window_state"
    const callId = withImage ? "inspect-visually" : "inspect-controls"
    const history: any = [
      { role: "user", content: "Inspect this task." },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: callId, toolName, input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: callId,
            toolName,
            output: withImage
              ? {
                  type: "content",
                  value: [
                    { type: "text", text: JSON.stringify(metadata) },
                    { type: "image-data", data: "AA==", mediaType: "image/jpeg" },
                  ],
                }
              : { type: "json", value: metadata },
          },
        ],
      },
    ]
    let requests = 0
    const model = createOpenAI({
      baseURL: "http://offline.invalid/v1",
      apiKey: "offline-placeholder",
      fetch: async (url, init) => {
        assert.equal(new URL(String(url)).hostname, "offline.invalid")
        const body = JSON.parse(String(init!.body))
        const wire = JSON.stringify(body.input)
        assert.equal(wire.includes("data:image/jpeg;base64,AA=="), withImage)
        assert(wire.includes(metadata.screenshot_status))
        assert(wire.includes("Save"))
        assert(
          body.input.some(
            (m: any) => m.type === "function_call_output" && m.call_id === callId
          )
        )
        if (withImage) assert(wire.includes("requested"))
        requests++
        return new Response(
          JSON.stringify({ error: { message: "Offline adaptive capture complete" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          }
        )
      },
    })("adaptive")
    await assert.rejects(
      generateText({
        model,
        ...prepareModelContext("openai/offline", history, {
          taskId: "fixture",
          threadId: "fixture",
          segmentNo: 1,
          epoch: 4,
          bootId: "boot",
        }),
        maxRetries: 0,
      }),
      /Offline adaptive capture complete/
    )
    assert.equal(requests, 1)
  }
})

test("adaptive native projection preserves table drilldown and focus evidence", () => {
  const value = {
    observationId,
    epoch: 4,
    bootId: "boot",
    focus_verified: true,
    focus_mode: "descendant",
    focused_path: [0, 0, 2],
    focused_role: "paragraph",
    accessibility: {
      source: "atspi2",
      status: "partial",
      truncated: true,
      policy: "adaptive",
      requestedDepth: 8,
      maxDepthSeen: 6,
      omitReasons: [
        { reason: "table_summarized", path: [0, 0, 1], nRows: 1048576, nCols: 16384 },
      ],
    },
    elements: [
      {
        element_index: 0,
        path: [0, 0, 1],
        role: "table",
        tableSummary: { nRows: 1048576, nCols: 16384, omittedCells: 17179869182 },
      },
      {
        element_index: 1,
        path: [0, 0, 1, 0],
        role: "table cell",
        name: "A1",
        tableCell: { row: 0, col: 0 },
      },
    ],
  }
  const message: any = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "desktop_get_window_state",
        toolCallId: "adaptive",
        output: { type: "json", value },
      },
    ],
  }
  const projected = (compactContext([message])[0].content as any)[0].output.value
  assert.deepEqual(projected.accessibility.omitReasons, value.accessibility.omitReasons)
  assert.deepEqual(projected.elements[0].tableSummary, value.elements[0].tableSummary)
  assert.deepEqual(projected.elements[1].tableCell, value.elements[1].tableCell)
  assert.equal(projected.focus_mode, "descendant")
  assert.deepEqual(projected.focused_path, value.focused_path)
  assert.equal(projected.accessibility.policy, "adaptive")
  assert(JSON.stringify(projected).length <= 12000)
})

test("adaptive observation schemas expose bounded multi-level defaults", () => {
  const defaults = nativeSchemas.desktop_get_window_state.parse({})
  assert.equal(defaults.max_depth, 8)
  assert.equal(defaults.max_nodes, 160)
  assert.equal(defaults.max_chars, 64000)
  assert.equal(defaults.child_expand_cap, 80)
  assert.equal(defaults.compact_structure, true)
  for (const params of [
    { max_chars: 1999 },
    { max_chars: 120001 },
    { child_expand_cap: 121 },
  ]) {
    assert.equal(nativeSchemas.desktop_get_window_state.safeParse(params).success, false)
  }
})
