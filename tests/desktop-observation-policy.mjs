import assert from "node:assert/strict"
import { beforeEach, mock, test } from "node:test"

const binding = { epoch: 4, bootId: "offline-boot" }
const windowId = "atspi-pid:15:path:0.0"
const original = {
  accessibility: { source: "atspi2", status: "ok", truncated: false },
  window_id: windowId,
  elements: [
    {
      element_index: 0,
      path: [0, 0, 0],
      role: "button",
      name: "Save",
      actions: [{ name: "click" }],
    },
    { element_index: 1, path: [0, 0, 1], role: "spin button", text: "11", value: 11 },
  ],
}
let snapshot
let nativeResult
let shots = 0
let inputs = 0
let nativeInputs = 0
let shotFails = false

mock.module(new URL("../workstation/controller/processes.mjs", import.meta.url).href, {
  exports: {
    runProcess: async (program, args, options) => {
      let output = ""
      let exitCode = 0
      if (program === "python3") {
        const request = JSON.parse(options.input)
        if (request.action === "snapshot") {
          output = JSON.stringify({
            ...snapshot,
            _nativeSnapshot: {
              window: { window_id: windowId },
              nodes: snapshot.elements,
              options: request.options,
            },
          })
        } else {
          nativeInputs++
          output = JSON.stringify(nativeResult)
        }
      } else if (program === "owndesk-shot") {
        shots++
        output = "AA=="
        if (shotFails) exitCode = 1
      } else if (program === "xprop") {
        output = args[0] === "-root" ? "window id # 0x1" : 'WM_CLASS = "fixture"'
      } else if (program === "xwininfo") {
        output =
          "Absolute upper-left X: 10\nAbsolute upper-left Y: 20\nWidth: 600\nHeight: 400"
      } else if (program === "xdotool") {
        if (args[0] === "getdisplaygeometry") output = "1280 800"
        else if (args[0] === "getwindowname") output = "Fixture"
        else inputs++
      } else throw new Error(`Unexpected program: ${program}`)
      return { output, exitCode, bytes: Buffer.byteLength(output), timedOut: false }
    },
  },
})

const { captureDesktop, nativeDesktop, desktopInput, invalidateDesktopObservation } =
  await import("../workstation/controller/desktop.mjs")

beforeEach(() => {
  snapshot = structuredClone(original)
  nativeResult = {
    effect: "dispatched",
    actual_dispatch: "background",
    window_id: windowId,
  }
  shots = inputs = nativeInputs = 0
  shotFails = false
  invalidateDesktopObservation()
})

test("complete native observations and background actions avoid screenshot work", async () => {
  const state = await nativeDesktop("desktop_get_window_state", {}, "read", binding)
  assert.equal(state.screenshot_status, "omitted")
  assert(!("image" in state))
  assert(!("screenshotCapturedAt" in state))
  assert.equal(shots, 0)
  const next = await nativeDesktop(
    "desktop_element_action",
    {
      observationId: state.observationId,
      element_index: 0,
    },
    "press",
    binding
  )
  assert.equal(next.effect, "dispatched")
  assert.equal(next.screenshot_status, "omitted")
  assert.notEqual(next.observationId, state.observationId)
  assert.equal(shots, 0)
  assert.equal(nativeInputs, 1)
  await assert.rejects(
    nativeDesktop(
      "desktop_element_action",
      {
        observationId: state.observationId,
        element_index: 0,
      },
      "stale",
      binding
    ),
    /Stale native observation/
  )
  assert.equal(nativeInputs, 1)
})

test("missing, incomplete and conflicting native states automatically include visual evidence", async () => {
  for (const [change, reason] of [
    [
      { accessibility: { source: "atspi2", status: "unavailable" } },
      "native_unavailable",
    ],
    [{ elements: [] }, "controls_missing"],
    [
      { accessibility: { source: "atspi2", status: "partial", truncated: true } },
      "partial_controls",
    ],
    [
      { elements: [{ ...original.elements[1], text: "11", value: 10 }] },
      "control_value_conflict",
    ],
  ]) {
    snapshot = { ...structuredClone(original), ...change }
    const state = await nativeDesktop("desktop_get_window_state", {}, reason, binding)
    assert.equal(state.screenshot_status, "ok")
    assert.equal(state.screenshot_reason, reason)
    assert.equal(state.image, "AA==")
    assert(state.screenshotCapturedAt)
  }
  assert.equal(shots, 4)
})

test("explicit capture always returns an image and only its fresh ID permits coordinates", async () => {
  const first = await captureDesktop("requested", binding)
  assert.equal(first.screenshot_reason, "requested")
  assert.equal(first.image, "AA==")
  const state = await nativeDesktop("desktop_get_window_state", {}, "native", binding)
  const pointer = { coordinateMode: "pixels", x: 20, y: 30 }
  await assert.rejects(
    desktopInput(
      "pointer_move",
      {
        ...pointer,
        observationId: first.observationId,
      },
      "old-image",
      binding
    ),
    /Stale desktop observation/
  )
  await assert.rejects(
    desktopInput(
      "pointer_move",
      {
        ...pointer,
        observationId: state.observationId,
      },
      "no-image",
      binding
    ),
    /call screen_capture/
  )
  assert.equal(inputs, 0)
  const fresh = await captureDesktop("uncertain", binding)
  const next = await desktopInput(
    "pointer_move",
    {
      ...pointer,
      observationId: fresh.observationId,
    },
    "pointer",
    binding
  )
  assert.equal(inputs, 1)
  assert.equal(next.screenshot_status, "ok")
  assert(next.image)
  assert.notEqual(next.observationId, fresh.observationId)
})

test("native fallback and foreground dispatch include screenshots without replaying inputs", async () => {
  for (const [result, reason] of [
    [
      { effect: "none", background_unavailable: true, actual_dispatch: "none" },
      "native_fallback",
    ],
    [{ effect: "dispatched", actual_dispatch: "foreground" }, "foreground_dispatch"],
  ]) {
    const state = await nativeDesktop("desktop_get_window_state", {}, "read", binding)
    nativeResult = { ...result, window_id: windowId }
    const next = await nativeDesktop(
      "desktop_element_action",
      {
        observationId: state.observationId,
        element_index: 0,
      },
      reason,
      binding
    )
    assert.equal(next.effect, result.effect)
    assert.equal(next.screenshot_reason, reason)
    assert(next.image)
  }
  assert.equal(nativeInputs, 2)
  assert.equal(shots, 2)
})

test("post-input capture failure preserves dispatch and supplies no authorization to repeat", async () => {
  const state = await nativeDesktop("desktop_get_window_state", {}, "read", binding)
  snapshot.accessibility.status = "partial"
  shotFails = true
  const result = await nativeDesktop(
    "desktop_element_action",
    {
      observationId: state.observationId,
      element_index: 0,
    },
    "press",
    binding
  )
  assert.equal(result.effect, "dispatched")
  assert.equal(result.observationId, null)
  assert.match(result.observationError, /Desktop screenshot failed/)
  assert.equal(nativeInputs, 1)
  await assert.rejects(
    nativeDesktop(
      "desktop_element_action",
      {
        observationId: state.observationId,
        element_index: 0,
      },
      "retry",
      binding
    ),
    /Stale native observation/
  )
  assert.equal(nativeInputs, 1)
})
