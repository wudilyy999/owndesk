import assert from "node:assert/strict"
import { nativeTools } from "../lib/agent/native-tools"

export type ObservationArm = "vision" | "native-first"
const nativeNames = new Set(Object.keys(nativeTools))
const observationNames = new Set([
  "desktop_list_windows",
  "desktop_get_window_state",
  "desktop_ax_snapshot",
])
const nativeFields = new Set([
  "accessibility",
  "elements",
  "tree",
  "textRefs",
  "focused_text",
  "tag_text",
  "query",
  "node_count",
  "omittedElements",
  "omittedTextRefs",
])

// Applied only by the isolated experiment's loopback model relay. Production
// receipts, tool implementations, images, tool-call ids and billing stay intact.
export function omitNativeObservation(value: unknown): unknown {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text.startsWith("{") && !text.startsWith("[")) return value
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return value
    }
    return JSON.stringify(omitNativeObservation(parsed))
  }
  if (Array.isArray(value)) return value.map(omitNativeObservation)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !nativeFields.has(key))
        .map(([key, item]) => [key, omitNativeObservation(item)])
    )
  return value
}

const sharedWorkstation = `# Workstation
You control an isolated Debian/XFCE 1280x800 desktop through the supplied GUI tools. Do not use terminals, scripts, shell, file APIs, browser DOM or developer tools. Complete the user's actual application task and verify its final visible state.
Use coordinateMode=pixels for pointer input, relative to the latest original screenshot. Every input requires the latest observationId, consumed by that input; the returned frame authorizes the next action. Control changes invalidate old observations. Keep at most two current images. Never replay an unknown effect. Existing owner consent and protected-field rules still apply.
`
const strategy: Record<ObservationArm, string> = {
  vision:
    "Observation policy: visual-only. Use original screenshots, active window metadata and pointer/key tools. Native control trees and native control action tools are not provided.\n",
  "native-first":
    "Observation policy: native-first hybrid. First read desktop_get_window_state or desktop_ax_snapshot; list windows when needed. For each operation inspect the current AT-SPI roles, names, states and available actions. Prefer native press/focus/set_value on a uniquely identified supported control. Use a fresh scoped observation after changing windows. Check effect and the new state; a successful dispatch alone does not prove completion. Protected fields require the owner. Use visual/key fallback for a missing or ambiguous target, an unavailable tree, a control without the required native action, or an application keyboard shortcut. Before each fallback, write one short line 'FALLBACK: reason' stating the actual reason. Never invent a native action for a node that exposes none. Coordinates for a background window require foreground focus and a fresh screenshot.\n",
}

function replaceWorkstation(value: unknown, arm: ObservationArm): unknown {
  if (typeof value === "string")
    return value.replace(
      /# Workstation\n[\s\S]*?(?=\n# Web and consent)/g,
      sharedWorkstation + strategy[arm]
    )
  if (Array.isArray(value)) return value.map((item) => replaceWorkstation(item, arm))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceWorkstation(item, arm)])
    )
  return value
}

export function comparisonRequest(
  original: Record<string, any>,
  arm: ObservationArm,
  nativeObserved: boolean
) {
  let body = replaceWorkstation(structuredClone(original), arm) as Record<string, any>
  if (arm === "vision") {
    body.tools = body.tools?.filter((tool: any) => !nativeNames.has(tool.name))
    for (const tool of body.tools ?? []) {
      if (["screen_capture", "screen_share"].includes(tool.name))
        tool.description =
          "Return the original desktop screenshot, dimensions, active window and fresh observationId. Reobserve after a window/control change."
      else if (typeof tool.description === "string")
        tool.description = tool.description.replace(
          ", available read-only AT-SPI elements,",
          ","
        )
    }
    body = omitNativeObservation(body) as Record<string, any>
    // Fail before forwarding if a serialized/truncated native observation was
    // not understood. Such a cell is invalid, rather than a visual baseline.
    assert(
      !/\\?"(?:accessibility|elements|tree|element_index|objectId)\\?"\s*:/.test(
        JSON.stringify(body.input ?? [])
      ),
      "Visual baseline still contains native control information"
    )
  } else if (!nativeObserved && body.tools?.length) {
    body.tools = body.tools.filter(
      (tool: any) =>
        observationNames.has(tool.name) ||
        ["ask_user", "request_takeover", "complete_task"].includes(tool.name)
    )
  }
  return body
}

// The initial automatic screenshot already includes AT-SPI. Only a successful
// explicit native read in the action ledger unlocks the hybrid action tools.
export function completedNativeRead(
  actions: { kind: string; status: string; receipt: any }[]
) {
  return actions.some(
    (action) =>
      ["desktop_get_window_state", "desktop_ax_snapshot"].includes(action.kind) &&
      action.status === "succeeded" &&
      containsNativeObservation(action.receipt?.output)
  )
}

export function containsNativeObservation(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text.startsWith("{") && !text.startsWith("[")) return false
    try {
      return containsNativeObservation(JSON.parse(text))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return false
    }
  }
  if (Array.isArray(value)) return value.some(containsNativeObservation)
  if (value && typeof value === "object") {
    const item = value as Record<string, any>
    if (
      item.accessibility?.source === "atspi2" &&
      item.accessibility.status !== "unavailable" &&
      (Array.isArray(item.elements) || item.tree)
    )
      return true
    return Object.values(item).some(containsNativeObservation)
  }
  return false
}
