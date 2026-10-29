import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { z } from "zod"
import { buildInstructions } from "@/lib/agent/instructions"
import { browserTools, desktopToolNames, toolsForTask } from "@/lib/agent/tools"

test("normal and desktop tasks use screenshots and coordinates without annotation tools", () => {
  for (const workstationChannel of [undefined, "desktop"] as const) {
    const tools = toolsForTask({ workstationChannel })
    for (const name of ["screen_capture", "pointer_click", "key_type", "key_press"])
      assert(name in tools)
    for (const name of ["desktop_observe", "desktop_act"]) {
      assert(!(name in tools))
      assert(!desktopToolNames.has(name))
    }
    const instructions = buildInstructions(
      { instructions: "", memories: [], workstationChannel },
      "2026-10-27T00:00:00Z"
    )
    assert.doesNotMatch(instructions, /desktop_observe|desktop_act|includeImage/)
    assert.match(
      instructions,
      /Every pointer\/key tool requires the latest observationId/
    )
    assert.match(instructions, /At most two recent images/)
  }
  const schema = browserTools.browser_observe.inputSchema as z.ZodObject
  assert.deepEqual(Object.keys(schema.shape), ["pageId"])
  assert("browser_observe" in toolsForTask({}))
  assert(!("browser_observe" in toolsForTask({ workstationChannel: "desktop" })))
})

test("guest and worker expose the original screenshot and plain DOM paths", async () => {
  for (const file of [
    "workstation/controller/server.mjs",
    "workstation/controller/desktop.mjs",
    "workstation/Dockerfile",
    "workstation/rootfs/usr/local/bin/owndesk-desktop",
    "worker/actions.ts",
  ]) {
    const source = await readFile(file, "utf8")
    assert.doesNotMatch(
      source,
      /desktop_observe|desktop_act|ui-elements|uiHelper|dom\.mjs|includeImage|tesseract/,
      file
    )
  }
  const dockerfile = await readFile("workstation/Dockerfile", "utf8")
  assert.match(dockerfile, /python3-pyatspi/)
  assert.match(dockerfile, /at-spi2-core/)
  const server = await readFile("workstation/controller/server.mjs", "utf8")
  assert.match(server, /route === "\/observe"/)
  assert.match(server, /route === "\/click"/)
  assert.match(server, /route === "\/screen_capture"/)
})
