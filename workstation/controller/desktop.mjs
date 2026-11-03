// Adapted from the pinned MIT upstream lib/workstation.ts at the pinned MIT baseline.
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, open } from "node:fs/promises"
import { z } from "zod"
import { runProcess } from "./processes.mjs"
import { nativeSchemas } from "./native-schema.mjs"

const coordinates = {
  coordinateMode: z.enum(["pixels", "normalized_1000"]),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
}
const schemas = {
  pointer_click: z.object({
    ...coordinates,
    button: z.enum(["left", "right", "middle"]).default("left"),
    double: z.boolean().default(false),
  }),
  pointer_move: z.object(coordinates),
  pointer_drag: z.object({
    coordinateMode: coordinates.coordinateMode,
    fromX: coordinates.x,
    fromY: coordinates.y,
    toX: coordinates.x,
    toY: coordinates.y,
  }),
  pointer_scroll: z.object({
    ...coordinates,
    direction: z.enum(["up", "down"]),
    amount: z.number().int().min(1).max(30).default(3),
  }),
  key_type: z.object({ text: z.string().max(50000) }),
  key_press: z.object({
    key: z.string().min(1).max(30),
    modifiers: z.array(z.enum(["ctrl", "alt", "shift", "cmd"])).default([]),
  }),
}
let observation = null
let nativeObservation = null
const tagTargets = new Map()

export function invalidateDesktopObservation(clearTags = true) {
  observation = null
  nativeObservation = null
  if (clearTags) tagTargets.clear()
}

// Read native X11 window state; no generated commands or file mutations.
async function desktopState(actionId) {
  const geometry = await runProcess("xdotool", ["getdisplaygeometry"], {
    actionId: `${actionId}:display`,
  })
  if (geometry.exitCode !== 0) throw new Error("Cannot read desktop dimensions")
  const [width, height] = z
    .array(z.coerce.number().int().positive())
    .length(2)
    .parse(geometry.output.trim().split(/\s+/))
  const active = await runProcess("xprop", ["-root", "_NET_ACTIVE_WINDOW"], {
    actionId: `${actionId}:active`,
  })
  if (active.exitCode !== 0) throw new Error("Cannot read active window")
  const id = /# (0x[0-9a-f]+)/i.exec(active.output)?.[1]
  if (id === "0x0" || active.output.includes("no such atom"))
    return { width, height, window: null }
  if (!id) throw new Error("Unrecognized active-window response")
  const name = await runProcess("xdotool", ["getwindowname", id], {
    actionId: `${actionId}:title`,
  })
  const bounds = await runProcess("xwininfo", ["-id", id], {
    actionId: `${actionId}:bounds`,
  })
  const wmClass = await runProcess("xprop", ["-id", id, "WM_CLASS"], {
    actionId: `${actionId}:class`,
  })
  if ([name, bounds, wmClass].some((result) => result.exitCode !== 0))
    throw new Error("Active window changed while being observed")
  // xwininfo's absolute client position matches the screenshot. xdotool's
  // geometry double-counts Xfwm reparent offsets in this environment.
  const values = Object.fromEntries(
    [
      ["x", "Absolute upper-left X"],
      ["y", "Absolute upper-left Y"],
      ["width", "Width"],
      ["height", "Height"],
    ].map(([key, label]) => [
      key,
      Number(new RegExp(`^\\s*${label}:\\s*(-?\\d+)`, "m").exec(bounds.output)?.[1]),
    ])
  )
  const windowBounds = z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .parse(values)
  return {
    width,
    height,
    window: {
      id,
      title: name.output.trim(),
      wmClass: wmClass.output.trim(),
      boundsSpace: "screen_pixels_client_area",
      ...windowBounds,
    },
  }
}

const KEYS = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  capslock: "Caps_Lock",
  menu: "Menu",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  cmd: "super",
  super: "super",
  meta: "super",
  win: "super",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "-": "minus",
  "=": "equal",
  "+": "plus",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
}
function keysym(key) {
  const lower = key.toLowerCase()
  if (KEYS[lower]) return KEYS[lower]
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  return key
}

async function nativeRequest(actionId, request, mutating = false) {
  const result = await runProcess(
    "python3",
    ["/opt/owndesk-controller/accessibility.py"],
    {
      actionId: `${actionId}:accessibility`,
      input: JSON.stringify(request),
      timeoutMs:
        request.action === "type" ? 15000 + request.options.text.length * 20 : 10000,
      maxOutputBytes: 2000000,
    }
  )
  if (result.timedOut || result.exitCode !== 0 || result.bytes > 2000000) {
    throw Object.assign(
      new Error(result.timedOut ? "AT-SPI reader_timeout" : "AT-SPI reader_failed"),
      { status: mutating ? 500 : 409 }
    )
  }
  let output
  try {
    output = JSON.parse(result.output)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw Object.assign(new Error("AT-SPI invalid_reader_output"), {
      status: mutating ? 500 : 409,
    })
  }
  if (output.error)
    throw Object.assign(new Error(output.error), {
      status: output.effect === "none" ? 409 : 500,
      safeResult: output,
    })
  return output
}

async function readAccessibility(actionId, state, options) {
  try {
    return await nativeRequest(actionId, { action: "snapshot", state, options })
  } catch (error) {
    if (error.status !== 409) throw error
    return {
      accessibility: { source: "atspi2", status: "unavailable", reason: error.message },
      elements: [],
    }
  }
}

export async function nativeDesktop(kind, raw, actionId, binding) {
  const input = nativeSchemas[kind].parse(raw)
  if (kind === "desktop_list_windows") {
    return nativeRequest(actionId, {
      action: "snapshot",
      state: await desktopState(actionId),
      options: { ...input, action: "list_windows" },
    })
  }
  if (
    ["desktop_get_window_state", "desktop_ax_snapshot", "desktop_tag_context"].includes(
      kind
    )
  ) {
    const frame = await captureDesktop(
      actionId,
      binding,
      {
        ...input,
        action: kind.slice(8),
        include_tree: true,
        max_elements: 500,
      },
      null
    )
    if (kind === "desktop_tag_context" && frame.accessibility.status === "unavailable")
      throw Object.assign(
        new Error(frame.accessibility.error ?? frame.accessibility.reason),
        { status: 409 }
      )
    if (kind === "desktop_tag_context") {
      const output = await nativeRequest(actionId, {
        action: "tag_context",
        state: observation,
        options: { ...input, action: "tag_context" },
        expected: nativeObservation,
      })
      const token = randomUUID()
      tagTargets.clear()
      tagTargets.set(token, {
        ...output._tagTarget,
        epoch: binding.epoch,
        bootId: binding.bootId,
        expiresAt: Date.now() + 900000,
      })
      const { _tagTarget, ...publicResult } = output
      return { ...frame, ...publicResult, targetToken: token }
    }
    return frame
  }
  if (kind === "desktop_tag_release") {
    const entry = tagTargets.get(input.targetToken)
    if (!entry || entry.epoch !== binding.epoch || entry.bootId !== binding.bootId)
      return { released: false, targetToken: input.targetToken }
    tagTargets.delete(input.targetToken)
    return { released: true, targetToken: input.targetToken }
  }
  if (
    !observation ||
    !nativeObservation ||
    observation.observationId !== input.observationId ||
    observation.epoch !== binding.epoch ||
    observation.bootId !== binding.bootId
  )
    throw Object.assign(
      new Error("Stale native observation; observe the target window again"),
      { status: 409 }
    )
  const state = observation,
    expected = nativeObservation
  let options = { ...input, action: kind === "desktop_type" ? "type" : "element_action" }
  if (kind === "desktop_tag_replace") {
    const entry = tagTargets.get(input.targetToken)
    if (
      !entry ||
      entry.epoch !== binding.epoch ||
      entry.bootId !== binding.bootId ||
      entry.expiresAt < Date.now()
    )
      throw Object.assign(new Error("Stale native text target"), { status: 409 })
    options = { ...input, action: "tag_replace", tag: entry, window_id: entry.window_id }
  }
  invalidateDesktopObservation()
  const result = await nativeRequest(
    actionId,
    { action: options.action, state, options, expected },
    true
  )
  if (result.effect === "dispatched") await delay(250)
  try {
    return {
      ...result,
      ...(await captureDesktop(
        `${actionId}:look`,
        binding,
        {
          ...expected.options,
          window_id: result.window_id ?? options.window_id ?? expected.window?.window_id,
          action: "get_window_state",
          include_tree: true,
          max_elements: 500,
        },
        result.background_unavailable
          ? "native_fallback"
          : result.actual_dispatch === "foreground"
            ? "foreground_dispatch"
            : null
      )),
    }
  } catch (error) {
    return {
      ...result,
      observationId: null,
      image: null,
      observationError: error.message,
    }
  }
}

export async function captureDesktop(
  actionId,
  binding,
  nativeOptions = {
    max_nodes: 500,
    max_depth: 12,
    max_elements: 60,
    include_tree: false,
  },
  screenshotReason = "requested"
) {
  invalidateDesktopObservation(false)
  const before = await desktopState(`${actionId}:before`)
  const {
    _nativeSnapshot,
    effect: _observationEffect,
    ...accessibility
  } = await readAccessibility(actionId, before, nativeOptions)
  // null selects control-first observation; explicit screen capture always requests an image.
  let reason = screenshotReason
  if (reason === null) {
    if (accessibility.accessibility.status === "unavailable")
      reason = "native_unavailable"
    else if (!accessibility.elements.length) reason = "controls_missing"
    else if (
      accessibility.accessibility.status !== "ok" ||
      accessibility.accessibility.truncated
    )
      reason = "partial_controls"
    else if (
      accessibility.elements.some(
        (node) =>
          typeof node.value === "number" &&
          typeof node.text === "string" &&
          node.text.trim() !== "" &&
          Number.isFinite(Number(node.text)) &&
          Number(node.text) !== node.value
      )
    )
      reason = "control_value_conflict"
  }
  let screenshot = {}
  if (reason) {
    const shot = await runProcess("owndesk-shot", [], {
      actionId,
      maxOutputBytes: 2000000,
    })
    if (shot.exitCode !== 0 || shot.bytes > 2000000)
      throw new Error("Desktop screenshot failed or exceeded the image limit")
    screenshot = {
      image: shot.output.trim(),
      mediaType: "image/jpeg",
      screenshotCapturedAt: new Date().toISOString(),
    }
  }
  const after = await desktopState(`${actionId}:after`)
  if (!isDeepStrictEqual(before, after)) {
    invalidateDesktopObservation()
    throw Object.assign(new Error("Window changed during capture; observe again"), {
      status: 409,
    })
  }
  observation = {
    observationId: randomUUID(),
    ...binding,
    ...after,
    screenshot_status: reason ? "ok" : "omitted",
    ...(reason ? { screenshot_reason: reason } : {}),
    coordinateSpace: "screenshot_pixels",
    acceptedCoordinateModes: ["pixels", "normalized_1000"],
    mapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  }
  nativeObservation = _nativeSnapshot ?? null
  return {
    ...observation,
    ...accessibility,
    ...screenshot,
  }
}

export async function openDesktopApplication(actionId, binding) {
  invalidateDesktopObservation()
  // Fixed native application/argv. Generated commands and file modifications never enter this adapter.
  await mkdir("/tmp/personal-agent-processes", { recursive: true })
  const log = await open(
    `/tmp/personal-agent-processes/${encodeURIComponent(actionId)}-thunar`,
    "w+",
    0o600
  )
  try {
    const child = spawn("thunar", ["--window", "/home/agent"], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    })
    let exit = null
    child.once("exit", (code, signal) => {
      exit = { code, signal }
    })
    await once(child, "spawn")
    child.unref()
    await delay(1000)
    if (exit && exit.code !== 0) {
      const buffer = Buffer.alloc(20000)
      const { bytesRead } = await log.read(buffer, 0, buffer.length, 0)
      throw new Error(
        `Thunar startup failed (${exit.code ?? exit.signal}): ${buffer.subarray(0, bytesRead).toString()}`
      )
    }
  } finally {
    await log.close()
  }
  try {
    return { launched: "Thunar", ...(await captureDesktop(`${actionId}:look`, binding)) }
  } catch (error) {
    return {
      launched: "Thunar",
      observationId: null,
      image: null,
      observationError: error.message,
    }
  }
}

export async function desktopInput(kind, raw, actionId, binding) {
  const supplied = schemas[kind].extend({ observationId: z.uuid() }).parse(raw)
  let input = { ...supplied }
  if (
    !observation ||
    input.observationId !== observation.observationId ||
    binding.epoch !== observation.epoch ||
    binding.bootId !== observation.bootId
  )
    throw Object.assign(
      new Error("Stale desktop observation; capture the current screen before acting"),
      { status: 409 }
    )
  if (kind.startsWith("pointer_") && observation.screenshot_status !== "ok")
    throw Object.assign(
      new Error(
        "Coordinate input requires a fresh screenshot; call screen_capture and use its observationId"
      ),
      { status: 409 }
    )
  const observed = observation
  invalidateDesktopObservation() // Each frame authorizes one input, including concurrent requests.
  const current = await desktopState(`${actionId}:preflight`)
  if (
    !isDeepStrictEqual(current, {
      width: observed.width,
      height: observed.height,
      window: observed.window,
    })
  )
    throw Object.assign(
      new Error("Desktop window changed after observation; observe again"),
      { status: 409 }
    )
  for (const [key, value] of Object.entries(supplied)) {
    const size = ["x", "fromX", "toX"].includes(key)
      ? observed.width
      : ["y", "fromY", "toY"].includes(key)
        ? observed.height
        : null
    if (size === null) continue
    const maximum = supplied.coordinateMode === "normalized_1000" ? 1000 : size - 1
    if (value > maximum)
      throw Object.assign(new Error("Coordinates exceed the declared coordinate mode"), {
        status: 409,
      })
    input[key] =
      supplied.coordinateMode === "normalized_1000"
        ? Math.round((value * (size - 1)) / 1000)
        : value
  }
  let args,
    stdin,
    settle = 500
  switch (kind) {
    case "pointer_click":
      args = [
        "mousemove",
        String(input.x),
        String(input.y),
        "sleep",
        "0.05",
        "click",
        ...(input.double ? ["--repeat", "2", "--delay", "80"] : []),
        { left: "1", middle: "2", right: "3" }[input.button],
      ]
      settle = 900
      break
    case "pointer_move":
      args = ["mousemove", String(input.x), String(input.y)]
      settle = 400
      break
    case "pointer_drag":
      args = [
        "mousemove",
        String(input.fromX),
        String(input.fromY),
        "mousedown",
        "1",
        "sleep",
        "0.1",
        "mousemove",
        String(Math.round((input.fromX + input.toX) / 2)),
        String(Math.round((input.fromY + input.toY) / 2)),
        "sleep",
        "0.05",
        "mousemove",
        String(input.toX),
        String(input.toY),
        "mouseup",
        "1",
      ]
      break
    case "pointer_scroll":
      args = [
        "mousemove",
        String(input.x),
        String(input.y),
        "click",
        "--repeat",
        String(input.amount),
        "--delay",
        "40",
        input.direction === "up" ? "4" : "5",
      ]
      break
    case "key_type":
      args = ["type", "--delay", "8", "--clearmodifiers", "--file", "-"]
      stdin = input.text
      break
    case "key_press":
      args = [
        "key",
        "--clearmodifiers",
        [
          ...input.modifiers.filter((m) => m !== input.key.toLowerCase()).map(keysym),
          keysym(input.key),
        ].join("+"),
      ]
      settle = /^(enter|return)$/i.test(input.key) ? 1500 : 500
      break
  }
  const result = await runProcess("xdotool", args, {
    actionId,
    input: stdin,
    timeoutMs: 60000,
  })
  if (result.exitCode !== 0) throw new Error(`Desktop input failed: ${result.output}`)
  await delay(settle)
  // The input has happened. An observation failure is reported separately and never replays it.
  try {
    return {
      ...supplied,
      executedInput: input,
      ...(await captureDesktop(`${actionId}:look`, binding)),
    }
  } catch (error) {
    return {
      ...supplied,
      executedInput: input,
      observationId: null,
      image: null,
      mediaType: "image/jpeg",
      width: null,
      height: null,
      observationError: error.message,
    }
  }
}
