import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker, dockerRaw } from "@/lib/docker"

const phase = process.argv[2] ?? "observe"
assert(
  [
    "observe",
    "desktop-tree",
    "actions",
    "keyboard",
    "safety",
    "tag",
    "edges",
    "tag-guards",
    "journal",
    "applications",
    "offscreen",
    "limits",
    "scope-parity",
    "tag-parity",
    "long-type",
    "action-read-failure",
    "preflight-tail",
    "hidden-semantic",
    "window-resolution",
    "package",
  ].includes(phase)
)
const directory = path.resolve(`data/experiments/atspi-native-${phase}-${Date.now()}`)
await mkdir(directory, { recursive: true })
const container = `pa-native-${phase}-${Date.now()}`
const checks: string[] = []
const receipts: any[] = []
let passed = false
const image = process.env.ATSPI_TEST_IMAGE ?? "owndesk-workstation:0.7.0"
async function request(route: string, body: unknown) {
  const r = await docker(
    ["exec", "-i", container, "node", "/opt/owndesk-controller/request.mjs", route],
    { input: JSON.stringify(body), maxOutputBytes: 15000000 }
  )
  return JSON.parse(r.stdout.toString())
}
async function action(kind: string, params: Record<string, unknown>, id = randomUUID()) {
  await request("/actions", { id, kind, params: { epoch: 1, ...params } })
  const deadline =
    Date.now() + 15000 + (kind === "desktop_type" ? String(params.text).length * 20 : 0)
  while (Date.now() < deadline) {
    const r = await request("/action-status", { id })
    if (["succeeded", "rejected", "unknown"].includes(r.status)) {
      receipts.push({ kind, ...r })
      return r
    }
    await delay(60)
  }
  throw new Error(`Action ${kind} did not finish`)
}
async function success(kind: string, params: Record<string, unknown> = {}) {
  const r = await action(kind, params)
  if (r.status !== "succeeded") {
    await docker(["cp", "/workspace/ref/lsapps.py", `${container}:/tmp/lsapps.py`])
    const o = await docker(["exec", container, "bash", "-c", 'pid=$(pgrep -f "owndesk-controller/server" | head -1); env $(tr "\\0" "\\n" </proc/$pid/environ | grep -E "^(DBUS|DISPLAY|NO_AT|GTK_MOD)" | tr "\\n" " ") python3 /tmp/lsapps.py'])
    console.log("APPS-AT-FAIL", o.stdout.toString(), JSON.stringify(params))
    const l = await action("desktop_list_windows", {})
    console.log("LIST", JSON.stringify(l.result?.windows?.map((w: any) => [w.name, w.window_id])))
  }
  assert.equal(r.status, "succeeded", `${kind}: ${r.error}`)
  return r.result
}
async function truth() {
  await delay(150)
  const r = await docker(["exec", container, "cat", "/tmp/atspi-native-truth.json"])
  return JSON.parse(r.stdout.toString())
}
let main: any, other: any
async function observe(window_id = main.window_id, more: Record<string, unknown> = {}) {
  return success("desktop_get_window_state", {
    window_id,
    max_depth: 12,
    max_nodes: 500,
    ...more,
  })
}
function node(frame: any, name: string) {
  const n = frame.elements.find((n: any) => n.name === name)
  assert(n, `Missing ${name}: ${JSON.stringify(frame.accessibility)}`)
  return n
}
async function native(
  name: string,
  options: Record<string, unknown> = {},
  window_id = main.window_id
) {
  const frame = await observe(window_id)
  const selected = node(frame, name)
  return success("desktop_element_action", {
    observationId: frame.observationId,
    window_id,
    element_index: selected.element_index,
    ...options,
  })
}
try {
  await docker(
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "personal-agent.experiment=atspi-migration",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--shm-size",
      "512m",
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      image,
    ],
    {
      env: {
        PA_WORKSPACE_TOKEN: randomBytes(32).toString("hex"),
        OWNDESK_VNC_PASSWORD: randomBytes(12).toString("hex"),
      },
    }
  )
  await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
  await request("/control", { epoch: 1, mode: "agent" })
  await docker([
    "cp",
    "tests/fixtures/atspi-native.py",
    `${container}:/tmp/atspi-native.py`,
  ])
  await success("shell", {
    command: "python3 /tmp/atspi-native.py >/tmp/atspi-native.log 2>&1 &",
    timeout: 5,
  })
  await delay(1200)
  const listing = await success("desktop_list_windows")
  main = listing.windows.find((w: any) => w.name === "AT-SPI Observation Fixture")
  other = listing.windows.find((w: any) => w.name === "Background fixture")
  assert(main && other, JSON.stringify(listing))
  assert.equal(listing.count, listing.windows.length)
  assert(main.app_name && typeof main.visible === "boolean")
  if (phase === "package") {
    const health = JSON.parse(
      (
        await docker(["exec", container, "curl", "-fsS", "http://127.0.0.1:6079/health"])
      ).stdout.toString()
    )
    assert(
      health.ready &&
        health.protocolVersion === 6 &&
        health.capabilities.includes("atspi-native-v1")
    )
    const versions = await docker([
      "exec",
      container,
      "dpkg-query",
      "-W",
      "python3-pyatspi",
      "python3-gi",
      "gir1.2-atspi-2.0",
      "at-spi2-core",
      "libatk-adaptor",
    ])
    await writeFile(
      path.join(directory, "package-versions.log"),
      versions.stdout.toString()
    )
    for (const file of [
      "accessibility.py",
      "atspi_core.py",
      "desktop.mjs",
      "native-schema.mjs",
      "a0-connector-LICENSE",
    ]) {
      const actual = path.join(directory, `packaged-${file}`)
      await docker(["cp", `${container}:/opt/owndesk-controller/${file}`, actual])
      assert(
        (await readFile(actual)).equals(
          await readFile(path.join("workstation/controller", file))
        ),
        `Packaged source differs: ${file}`
      )
    }
    for (const pkg of ["python3-pyatspi", "python3-gi", "at-spi2-core"])
      await docker(["exec", container, "test", "-s", `/usr/share/doc/${pkg}/copyright`])
    assert.equal(
      (await docker(["exec", container, "node", "--version"])).stdout.toString().trim(),
      "v24.20.0"
    )
    const frame = await observe()
    assert(frame.app_name && frame.image && frame.tree && frame.elements.length)
    await writeFile(path.join(directory, "frame.json"), JSON.stringify(frame, null, 2))
    await writeFile(path.join(directory, "frame.jpg"), Buffer.from(frame.image, "base64"))
    checks.push(
      "clean image boots with required native dependencies, guest6/capability, Node24 and shipped license notices; packaged native sources byte-match current files; original screenshot and native hierarchy are usable"
    )
  }
  if (phase === "observe") {
    const frame = await observe()
    assert.notEqual(frame.accessibility.status, "unavailable")
    assert(frame.tree.children && frame.image && frame.observationId)
    assert.equal(node(frame, "Report title").text, "Quarterly report")
    assert.equal(node(frame, "Volume").value, 37)
    assert(node(frame, "Save report").actions.length)
    assert(node(frame, "Disabled export").states.includes("disabled"))
    assert(!JSON.stringify(frame).includes("FIXTURE_PASSWORD_MUST_NOT_LEAK"))
    assert(!JSON.stringify(frame).includes("HIDDEN_CONTROL_MUST_NOT_LEAK"))
    assert(!frame.elements.some((n: any) => n.name === "Background action"))
    assert(frame.elements.some((n: any) => n.redacted))
    assert(
      frame.elements.every(
        (n: any) => n.objectId.bus && n.objectId.path && Array.isArray(n.path)
      )
    )
    await writeFile(path.join(directory, "frame.json"), JSON.stringify(frame, null, 2))
    await writeFile(path.join(directory, "frame.jpg"), Buffer.from(frame.image, "base64"))
    checks.push(
      "window enumeration, scoped hierarchy, object identities, names/actions/text/numeric values/states and protected/hidden/background filtering"
    )
    const bg = await observe(other.window_id)
    assert(node(bg, "Background action"))
    assert.equal(
      bg.window.title,
      "AT-SPI Observation Fixture",
      "background observation preserves active foreground window"
    )
    checks.push("background window observation without focus changes")
    const limited = await observe(main.window_id, { max_nodes: 3 })
    assert(limited.accessibility.truncated)
    assert.equal(limited.accessibility.status, "partial")
    checks.push("bounded partial snapshot")
  }
  if (phase === "desktop-tree") {
    const whole = await success("desktop_ax_snapshot", { max_nodes: 500, max_depth: 12 })
    assert.equal(whole.accessibility.scope, "desktop")
    assert(node(whole, "Background action"))
    checks.push("desktop-wide AX tree traverses application containers")
  }
  if (phase === "limits") {
    const limited = await observe(main.window_id, { max_nodes: 3 })
    assert.equal(limited.node_count, 3)
    assert(limited.accessibility.truncated)
    assert.equal(limited.accessibility.status, "partial")
    assert(limited.image && limited.observationId)
    checks.push(
      "node-budget truncation explicitly returns a partial native tree together with the original screenshot"
    )
  }
  if (phase === "hidden-semantic") {
    const visible = await observe()
    assert(!visible.elements.some((e: any) => e.name === "Hidden report title"))
    const explicit = await observe(main.window_id, { include_hidden: true })
    assert.equal(node(explicit, "Hidden report title").text, "Hidden original")
    const output = await success("desktop_ax_action", {
      observationId: explicit.observationId,
      target: { name: "Hidden report title", role: "text" },
      operation: "set_value",
      value: "Hidden updated",
      dispatch: "background",
    })
    assert.equal(output.effect, "dispatched")
    assert.equal((await truth()).hiddenTitle, "Hidden updated")
    checks.push(
      "explicit hidden-node observation carries its scope into semantic native value assignment; default observations omit that field"
    )
  }
  if (phase === "window-resolution") {
    const output = await native("Save report")
    assert.equal(output.effect, "dispatched")
    assert.equal((await truth()).hits.save, 1)
    await docker([
      "cp",
      "tests/fixtures/atspi-window-resolution.py",
      `${container}:/tmp/atspi-window-resolution.py`,
    ])
    const pure = await docker([
      "exec",
      container,
      "python3",
      "/tmp/atspi-window-resolution.py",
    ])
    await writeFile(path.join(directory, "resolver-check.log"), pure.stdout.toString())
    checks.push(
      "real native press uses direct observed-window resolution; synthetic 105-app/capped traversal, exact PID/path and enumeration failures pass"
    )
  }
  if (phase === "scope-parity") {
    for (const mode of ["element_index", "path", "target"]) {
      const frame = await success("desktop_ax_snapshot", {
        max_nodes: 500,
        max_depth: 12,
      })
      assert(!frame.accessibility.truncated)
      const save = node(frame, "Save report")
      const selected =
        mode === "target" ? { name: "Save report", role: "button" } : save[mode]
      const output = await success("desktop_ax_action", {
        observationId: frame.observationId,
        [mode]: selected,
      })
      assert.equal(output.effect, "dispatched")
      assert.equal(output.window_id, main.window_id)
    }
    assert.equal((await truth()).hits.save, 3)
    checks.push(
      "whole-desktop snapshot index/path/unique semantic targets resolve their observed native window without requiring an additional window_id"
    )
  }
  if (phase === "tag-parity") {
    await native("Report title", {
      operation: "set_value",
      value: "@a0.editor exact request",
    })
    await native("Report title", { operation: "focus", dispatch: "foreground" })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "caret_end" }),
    })
    await delay(200)
    const first = await success("desktop_tag_context", { window_id: main.window_id })
    const second = await success("desktop_tag_context", { window_id: main.window_id })
    assert.equal(second.tag_text, "@a0.editor exact request")
    assert.equal(second.window_title, main.name)
    assert(second.app_name)
    assert.equal(second.screenshot_status, "ok")
    assert.equal(
      (
        await action("desktop_tag_replace", {
          observationId: second.observationId,
          targetToken: first.targetToken,
          replacement: "obsolete target",
        })
      ).status,
      "rejected"
    )
    assert.equal(
      (await success("desktop_tag_release", { targetToken: first.targetToken })).released,
      false
    )
    assert.equal(
      (await success("desktop_tag_release", { targetToken: second.targetToken }))
        .released,
      true
    )
    assert.equal(
      (await success("desktop_tag_release", { targetToken: second.targetToken }))
        .released,
      false
    )
    const pending = await success("desktop_tag_context", { window_id: main.window_id })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "main_title", value: "Changed document title" }),
    })
    await delay(200)
    const changed = await action("desktop_tag_replace", {
      observationId: pending.observationId,
      targetToken: pending.targetToken,
      replacement: "changed title target",
    })
    assert.equal(changed.status, "rejected")
    assert.match(changed.error, /window title changed/)
    assert.equal((await truth()).title, "@a0.editor exact request")
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "editable", value: false }),
    })
    await delay(200)
    const readonly = await success("desktop_tag_context", { window_id: main.window_id })
    assert.equal(readonly.replace_supported, false)
    const blocked = await action("desktop_tag_replace", {
      observationId: readonly.observationId,
      targetToken: readonly.targetToken,
      replacement: "must remain readonly",
    })
    assert.equal(blocked.status, "rejected")
    assert.match(blocked.error, /no editable text interface/)
    assert.equal((await truth()).title, "@a0.editor exact request")
    checks.push(
      "inline metadata, single-current-target semantics, idempotent release, window-title binding and readonly replacement checks match upstream behavior"
    )
  }
  if (phase === "long-type") {
    await native("Report title", { operation: "focus", dispatch: "foreground" })
    let frame = await observe()
    frame = await success("key_press", {
      observationId: frame.observationId,
      key: "a",
      modifiers: ["ctrl"],
    })
    const text = "long-native-" + "a".repeat(900) + "-中文"
    const typed = await success("desktop_type", {
      observationId: frame.observationId,
      window_id: main.window_id,
      text,
    })
    assert.equal(typed.effect, "dispatched")
    assert.equal(typed.focus_verified, true)
    assert.equal((await truth()).title, text)
    checks.push(
      "native-window keyboard input longer than the former fixed timeout completes with exact Unicode content and verified focus"
    )
  }
  if (phase === "action-read-failure") {
    const frame = await observe()
    await docker([
      "exec",
      "--user",
      "0",
      container,
      "mv",
      "/opt/owndesk-controller/accessibility.py",
      "/opt/owndesk-controller/accessibility-real.py",
    ])
    const wrapper = `import runpy
import atspi_core as ax
original = ax._safe_call
def failed_action_name(element, method, *args):
    if method == "get_action_name":
        ax.READ_ERRORS.append({"method":method,"error":"injected_DBus_read_failure"})
        return None
    return original(element, method, *args)
ax._safe_call = failed_action_name
runpy.run_path("/opt/owndesk-controller/accessibility-real.py", run_name="__main__")
`
    await docker(
      [
        "exec",
        "--user",
        "0",
        "-i",
        container,
        "tee",
        "/opt/owndesk-controller/accessibility.py",
      ],
      { input: wrapper }
    )
    const blocked = await action("desktop_element_action", {
      observationId: frame.observationId,
      element_index: node(frame, "Save report").element_index,
    })
    assert.equal(blocked.status, "rejected")
    assert.equal(blocked.result.effect, "none")
    assert.equal(blocked.result.code, "ACTION_READ_FAILED")
    assert.equal((await truth()).hits.save, 0)
    checks.push(
      "injected native action-name read failure rejects before dispatch with explicit effect=none"
    )
    await docker([
      "exec",
      "--user",
      "0",
      container,
      "mv",
      "/opt/owndesk-controller/accessibility-real.py",
      "/opt/owndesk-controller/accessibility.py",
    ])
  }
  if (phase === "preflight-tail") {
    const canvas = await native("Canvas region", { dispatch: "auto" })
    assert.equal(canvas.effect, "none")
    assert.equal(canvas.background_unavailable, true)
    await docker([
      "exec",
      container,
      "python3",
      "-c",
      `import sys; sys.path.insert(0,"/opt/owndesk-controller"); import accessibility as a
try:
 a.x11_window({"name":"missing process ID"})
except a.ax.PortalError as error:
 assert error.code == "WINDOW_PID_UNAVAILABLE"
else:
 raise AssertionError("Missing native PID must refuse foreground input")
`,
    ])
    checks.push(
      "known absence of native Action remains an explicit no-effect fallback; missing process ID rejects foreground dispatch before input"
    )
  }

  if (phase === "actions") {
    const saved = await native("Save report")
    assert.equal(saved.effect, "dispatched")
    assert.equal((await truth()).hits.save, 1)
    checks.push(
      "native index press dispatch triggers independent GTK callback exactly once"
    )
    let frame = await observe()
    await success("desktop_ax_action", {
      observationId: frame.observationId,
      window_id: main.window_id,
      target: { name: "Enable sync", role: "check box" },
      operation: "press",
    })
    assert.equal((await truth()).sync, false)
    frame = await observe()
    await success("desktop_ax_action", {
      observationId: frame.observationId,
      path: node(frame, "Report title").path,
      operation: "set_value",
      value: "原生输入验证",
    })
    assert.equal((await truth()).title, "原生输入验证")
    await native("Volume", { operation: "set_value", value: 61 })
    assert.equal((await truth()).volume, 61)
    checks.push(
      "semantic targeting, path targeting, Unicode editable text and numeric value assignment"
    )
    const bg = await native("Background action", {}, other.window_id)
    assert.equal(bg.actual_dispatch, "background")
    assert.equal((await truth()).hits.background, 1)
    assert.equal(bg.window.title, "AT-SPI Observation Fixture")
    checks.push(
      "background native action affects the named background window without moving foreground focus"
    )
    const nofocus = await native(
      "Background fixture",
      { operation: "focus" },
      other.window_id
    )
    assert.equal(nofocus.background_unavailable, true)
    assert.equal(nofocus.effect, "none")
    const focused = await native(
      "Background fixture",
      { operation: "focus", dispatch: "auto" },
      other.window_id
    )
    assert.equal(focused.actual_dispatch, "foreground")
    assert.equal(focused.focus_verified, true)
    assert.equal(focused.window.title, "Background fixture")
    checks.push(
      "background focus refusal and explicit auto-to-foreground focus verification"
    )
  }
  if (phase === "keyboard") {
    await native("Report title", { operation: "focus", dispatch: "foreground" })
    const frame = await observe()
    const typed = await success("desktop_type", {
      observationId: frame.observationId,
      window_id: main.window_id,
      text: "Z",
    })
    assert.equal(typed.focus_verified, true)
    assert((await truth()).title.includes("Z"))
    checks.push("guarded keyboard input verifies both AT-SPI and X11 target focus")
  }
  if (phase === "safety") {
    let frame = await observe()
    const old = frame.observationId
    await observe()
    assert.equal(
      (
        await action("desktop_element_action", {
          observationId: old,
          element_index: node(frame, "Save report").element_index,
        })
      ).status,
      "rejected"
    )
    frame = await observe()
    const r = await action("desktop_element_action", {
      observationId: frame.observationId,
      target: { name: "Duplicate action" },
    })
    assert.equal(r.status, "rejected")
    assert.match(r.error, /Several controls/)
    frame = await observe()
    assert.equal(
      (
        await action("desktop_element_action", {
          observationId: frame.observationId,
          window_id: other.window_id,
          target: { name: "Save report" },
        })
      ).status,
      "rejected"
    )
    frame = await observe()
    assert.equal(
      (
        await action("desktop_element_action", {
          observationId: frame.observationId,
          element_index: node(frame, "Disabled export").element_index,
        })
      ).status,
      "rejected"
    )
    frame = await observe()
    const password = frame.elements.find((n: any) => n.redacted)
    assert.equal(
      (
        await action("desktop_element_action", {
          observationId: frame.observationId,
          element_index: password.element_index,
          operation: "set_value",
          value: "blocked",
        })
      ).status,
      "rejected"
    )
    checks.push(
      "superseded observations, ambiguous semantic targets, wrong windows, disabled and protected controls rejected before effects"
    )
    frame = await observe()
    const frozen = node(frame, "Save report")
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "rebind_save" }),
    })
    await delay(300)
    const rebound = await action("desktop_element_action", {
      observationId: frame.observationId,
      element_index: frozen.element_index,
    })
    assert.equal(rebound.status, "rejected")
    assert.match(rebound.error, /different control|properties changed/)
    assert.equal((await truth()).hits.save, 0)
    checks.push(
      "same-label child-path rebinding rejected by D-Bus object identity; no callback fired"
    )
    frame = await observe()
    const params = {
      observationId: frame.observationId,
      element_index: node(frame, "Save report").element_index,
    }
    const id = randomUUID(),
      first = await action("desktop_element_action", params, id)
    assert.equal(first.status, "succeeded", first.error)
    const replay = await action("desktop_element_action", params, id)
    assert.deepEqual(replay.result, first.result)
    assert.equal((await truth()).hits.save, 1)
    assert.equal((await action("desktop_element_action", params)).status, "rejected")
    checks.push(
      "durable native receipt replay does not repeat input; consumed observation rejected"
    )
    await request("/control", { epoch: 2, mode: "human" })
    assert.equal(
      (
        await action("desktop_element_action", {
          observationId: first.result.observationId,
          element_index: 0,
        })
      ).status,
      "rejected"
    )
    checks.push("human takeover invalidates native inputs")
  }
  if (phase === "tag") {
    await native("Report title", {
      operation: "set_value",
      value: "@a0.editor 翻译这段文字",
    })
    await native("Report title", { operation: "focus", dispatch: "foreground" })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "caret_end" }),
    })
    await delay(200)
    const context = await success("desktop_tag_context", { window_id: main.window_id })
    assert.equal(context.query, "翻译这段文字")
    assert.equal(context.profile_override, "editor")
    assert(context.replace_supported && context.targetToken && context.observationId)
    const replaced = await success("desktop_tag_replace", {
      observationId: context.observationId,
      targetToken: context.targetToken,
      replacement: "Translated result ✓",
    })
    assert.equal(replaced.replaced, true)
    assert.equal((await truth()).title, "Translated result ✓")
    assert.equal(
      (
        await action("desktop_tag_replace", {
          observationId: replaced.observationId,
          targetToken: context.targetToken,
          replacement: "repeat",
        })
      ).status,
      "rejected"
    )
    checks.push(
      "focused @a0.profile context parser, exact Unicode range replacement and one-use token"
    )
  }
  if (phase === "edges") {
    const ambiguous = await action("desktop_get_window_state", { pid: main.pid })
    assert.equal(ambiguous.status, "rejected")
    assert.match(ambiguous.error, /Several native windows/)
    const limited = await success("desktop_list_windows", { max_windows: 1 })
    assert.equal(limited.windows.length, 1)
    assert(limited.truncated)
    const hidden = await observe(main.window_id, { include_hidden: true })
    assert(hidden.elements.some((e: any) => e.name === "HIDDEN_CONTROL_MUST_NOT_LEAK"))
    let frame = await observe()
    const mismatch = await action("desktop_element_action", {
      observationId: frame.observationId,
      pid: main.pid + 10000,
      element_index: node(frame, "Save report").element_index,
    })
    assert.equal(mismatch.status, "rejected")
    frame = await observe()
    const missing = await action("desktop_ax_action", {
      observationId: frame.observationId,
      target: { name: "No such native control" },
    })
    assert.equal(missing.status, "rejected")
    assert.match(missing.error, /No native control matches/)
    frame = await observe()
    const unavailable = await success("desktop_element_action", {
      observationId: frame.observationId,
      element_index: node(frame, "Canvas region").element_index,
      dispatch: "auto",
    })
    assert.equal(unavailable.effect, "none")
    assert.equal(unavailable.background_unavailable, true)
    assert.equal(unavailable.actual_dispatch, "none")
    checks.push(
      "PID ambiguity/mismatch, bounded window list, hidden-node opt-in, missing targets and unsupported native actions are explicit"
    )
    frame = await success("desktop_ax_snapshot", { max_depth: 12, max_nodes: 500 })
    const pressed = await success("desktop_ax_action", {
      observationId: frame.observationId,
      window_id: main.window_id,
      path: node(frame, "Save report").path,
      action_name: "click",
    })
    assert.equal(pressed.effect, "dispatched")
    assert.equal((await truth()).hits.save, 1)
    frame = await observe()
    await success("desktop_element_action", {
      observationId: frame.observationId,
      target: {
        name: "Save report",
        role: "button",
        actions: ["click"],
        states: ["enabled"],
      },
    })
    assert.equal((await truth()).hits.save, 2)
    checks.push(
      "desktop-wide path targeting, explicit native action and semantic role/action/state matching trigger real callbacks"
    )
    await native(
      "Background fixture",
      { operation: "focus", dispatch: "foreground" },
      other.window_id
    )
    frame = await observe()
    const wrongFocus = await action("desktop_type", {
      observationId: frame.observationId,
      window_id: main.window_id,
      text: "must not type",
    })
    assert.equal(wrongFocus.status, "rejected")
    assert.equal((await truth()).title, "Quarterly report")
    const submitted = await native("Report title", {
      operation: "set_value",
      value: "Focused submit ✓",
      submit: true,
      dispatch: "auto",
    })
    assert.equal(submitted.focus_verified, true)
    assert.equal(submitted.foreground_fallback_used, true)
    assert.equal(submitted.submitted, true)
    const actual = await truth()
    assert.equal(actual.title, "Focused submit ✓")
    assert.equal(actual.hits.submit, 1)
    assert(
      submitted.elements.some(
        (e: any) => e.name === "Report title" && e.text === actual.title
      )
    )
    checks.push(
      "wrong-window keyboard refuses input; auto set_value+submit activates and focuses the actual field before one Enter"
    )
  }
  if (phase === "tag-guards") {
    await native("Report title", {
      operation: "set_value",
      value: "@a0.editor original request",
    })
    await native("Report title", { operation: "focus", dispatch: "foreground" })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "caret_end" }),
    })
    await delay(200)
    let context = await success("desktop_tag_context", { window_id: main.window_id })
    const released = await success("desktop_tag_release", {
      targetToken: context.targetToken,
    })
    assert.equal(released.released, true)
    assert.equal(
      (
        await action("desktop_tag_replace", {
          observationId: context.observationId,
          targetToken: context.targetToken,
          replacement: "must not replace",
        })
      ).status,
      "rejected"
    )
    context = await success("desktop_tag_context", { window_id: main.window_id })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "set_entry", value: "@a0.editor changed request" }),
    })
    await delay(200)
    const changed = await action("desktop_tag_replace", {
      observationId: context.observationId,
      targetToken: context.targetToken,
      replacement: "must not replace",
    })
    assert.equal(changed.status, "rejected")
    assert.match(changed.error, /original inline request range changed/)
    assert.equal((await truth()).title, "@a0.editor changed request")
    context = await success("desktop_tag_context", { window_id: main.window_id })
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "focus_secret" }),
    })
    await delay(200)
    const protectedContext = await action("desktop_tag_context", {
      window_id: main.window_id,
    })
    assert.equal(protectedContext.status, "rejected")
    assert.match(protectedContext.error, /protected fields/)
    assert(!JSON.stringify(protectedContext).includes("FIXTURE_PASSWORD_MUST_NOT_LEAK"))
    checks.push(
      "inline target release, human-modified range and protected focus all reject without replacing text or exposing the password"
    )
  }
  if (phase === "journal") {
    const frame = await observe()
    const id = randomUUID()
    const params = {
      observationId: frame.observationId,
      element_index: node(frame, "Save report").element_index,
    }
    // Isolated fault injection holds the helper's response AFTER a real native effect.
    const wrapper = `import json, subprocess, sys, time
from pathlib import Path
raw = sys.stdin.read()
request = json.loads(raw)
result = subprocess.run([sys.executable, "/opt/owndesk-controller/accessibility-real.py"], input=raw, text=True, capture_output=True, check=True)
if request.get("action") == "element_action":
    Path("/tmp/native-effect-dispatched").write_text(result.stdout)
    time.sleep(300)
print(result.stdout)
`
    await docker([
      "exec",
      "--user",
      "0",
      container,
      "mv",
      "/opt/owndesk-controller/accessibility.py",
      "/opt/owndesk-controller/accessibility-real.py",
    ])
    await docker(
      [
        "exec",
        "--user",
        "0",
        "-i",
        container,
        "tee",
        "/opt/owndesk-controller/accessibility.py",
      ],
      { input: wrapper }
    )
    await request("/actions", {
      id,
      kind: "desktop_element_action",
      params: { epoch: 1, ...params },
    })
    let dispatched = false
    for (let i = 0; i < 50; i++) {
      const probe = await dockerRaw([
        "exec",
        container,
        "test",
        "-f",
        "/tmp/native-effect-dispatched",
      ])
      if (probe.exitCode === 0) {
        dispatched = true
        break
      }
      await delay(60)
    }
    assert(dispatched, "Native helper did not reach the post-effect hold")
    assert.equal((await truth()).hits.save, 1)
    await request("/quiesce", { epoch: 2 })
    let interrupted: any
    for (let i = 0; i < 50; i++) {
      interrupted = await request("/action-status", { id })
      if (interrupted.status === "unknown") break
      await delay(60)
    }
    receipts.push({ kind: "desktop_element_action", ...interrupted })
    assert.equal(interrupted.status, "unknown")
    assert.equal((await truth()).hits.save, 1)
    const replay = await action("desktop_element_action", params, id)
    assert.equal(replay.status, "unknown")
    assert.equal((await truth()).hits.save, 1)
    checks.push(
      "quiesce stops an in-flight native helper after one real GTK effect; missing completion becomes durable unknown and replay never repeats it"
    )
    await docker([
      "exec",
      "--user",
      "0",
      container,
      "mv",
      "/opt/owndesk-controller/accessibility-real.py",
      "/opt/owndesk-controller/accessibility.py",
    ])
    await docker(["stop", container])
    await docker(["start", container])
    await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
    const recovered = await request("/action-status", { id })
    assert.equal(recovered.status, "unknown")
    assert.notEqual(recovered.currentBootId, interrupted.bootId)
    const coldReplay = await action("desktop_element_action", params, id)
    assert.equal(coldReplay.status, "unknown")
    assert.equal((await truth()).hits.save, 1)
    checks.push(
      "container/controller cold restart retains the original unknown receipt and external truth without reissuing native input"
    )
  }
  if (phase === "applications") {
    await success("shell", {
      command: "xfce4-appearance-settings >/tmp/atspi-appearance.log 2>&1 &",
      timeout: 5,
    })
    await delay(1000)
    const apps = await success("desktop_list_windows")
    const appearance = apps.windows.find((w: any) => w.name === "Appearance")
    assert(appearance, JSON.stringify(apps.windows))
    const frame = await observe(appearance.window_id)
    const fonts = frame.elements.find(
      (e: any) => e.role === "page tab" && e.name === "Fonts"
    )
    assert(fonts, JSON.stringify(frame.elements.map((e: any) => [e.role, e.name])))
    const changed = await success("desktop_element_action", {
      observationId: frame.observationId,
      element_index: fonts.element_index,
    })
    assert.equal(changed.effect, "none")
    assert.equal(changed.background_unavailable, true)
    const visibleFonts = node(changed, "Fonts")
    const selected = await success("pointer_click", {
      observationId: changed.observationId,
      coordinateMode: "pixels",
      x: Math.round(visibleFonts.bounds.x + visibleFonts.bounds.width / 2),
      y: Math.round(visibleFonts.bounds.y + visibleFonts.bounds.height / 2),
    })
    assert(
      selected.elements.some(
        (e: any) => e.name === "Fonts" && e.states.includes("selected")
      )
    )
    checks.push(
      "real XFCE Appearance tab has native name/geometry but no Action interface; explicit fresh-frame coordinate fallback selects Fonts and AT-SPI confirms selection"
    )
    await success("shell", {
      command:
        "xfce4-terminal --disable-server --title='AT-SPI Terminal App' --command='bash --noprofile --norc' >/tmp/atspi-terminal.log 2>&1 &",
      timeout: 5,
    })
    await delay(1000)
    const terminalApps = await success("desktop_list_windows")
    const terminal = terminalApps.windows.find(
      (w: any) => w.name === "AT-SPI Terminal App"
    )
    assert(terminal, JSON.stringify(terminalApps.windows))
    const terminalFrame = await observe(terminal.window_id)
    assert(terminalFrame.elements.some((e: any) => e.role === "terminal"))
    await success("desktop_type", {
      observationId: terminalFrame.observationId,
      window_id: terminal.window_id,
      text: "printf 'native-terminal-once\\n' >> /tmp/atspi-terminal-check",
      submit: true,
    })
    await delay(200)
    const actual = await docker(["exec", container, "cat", "/tmp/atspi-terminal-check"])
    assert.equal(actual.stdout.toString(), "native-terminal-once\n")
    checks.push(
      "real XFCE Terminal exposes terminal text and verified native-window typing+submit produces exactly one independent file result"
    )
  }
  if (phase === "offscreen") {
    const xid = (
      await docker([
        "exec",
        container,
        "xdotool",
        "search",
        "--name",
        "^Background fixture$",
      ])
    ).stdout
      .toString()
      .trim()
    assert(/^\d+$/.test(xid))
    await docker([
      "exec",
      container,
      "xdotool",
      "windowunmap",
      xid,
      "sleep",
      "0.2",
      "set_window",
      "--overrideredirect",
      "1",
      xid,
      "windowmap",
      xid,
      "sleep",
      "0.2",
      "windowmove",
      xid,
      "3000",
      "3000",
    ])
    await delay(200)
    const visible = await success("desktop_list_windows")
    assert(!visible.windows.some((w: any) => w.window_id === other.window_id))
    const all = await success("desktop_list_windows", { include_offscreen: true })
    assert(all.windows.some((w: any) => w.window_id === other.window_id))
    await docker([
      "exec",
      container,
      "xdotool",
      "windowunmap",
      xid,
      "sleep",
      "0.2",
      "set_window",
      "--overrideredirect",
      "0",
      xid,
      "windowmap",
      xid,
      "sleep",
      "0.2",
      "windowmove",
      xid,
      "100",
      "100",
    ])
    await docker(["exec", "-i", container, "tee", "/tmp/atspi-native-command.json"], {
      input: JSON.stringify({ action: "duplicate_title" }),
    })
    await delay(200)
    const frame = await observe()
    const ambiguity = await action("desktop_element_action", {
      observationId: frame.observationId,
      element_index: 0,
      operation: "focus",
      dispatch: "foreground",
    })
    assert.equal(ambiguity.status, "rejected")
    assert.match(ambiguity.error, /uniquely mapped to X11/)
    assert.equal((await truth()).hits.save, 0)
    checks.push(
      "offscreen windows require explicit opt-in; same-process same-title X11 activation ambiguity rejects before effects"
    )
  }
  passed = true
} finally {
  await writeFile(
    path.join(directory, "receipts.json"),
    JSON.stringify(receipts, null, 2)
  )
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { phase, passed, checks, image, container, cloudCalls: 0, taskRecords: 0 },
      null,
      2
    )
  )
  await docker(["stop", container])
}
console.log(JSON.stringify({ directory, phase, passed, checks }))
