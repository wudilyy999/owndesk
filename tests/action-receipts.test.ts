import assert from "node:assert/strict"
import test from "node:test"
import { interruptedShell } from "@/lib/action-receipts"

test("signal/timeout Shell receipts require effect review, including cached outputs; normal exit and other tools retain their semantics", () => {
  assert(
    interruptedShell("shell", { exitCode: null, signal: "SIGTERM", timedOut: false })
  )
  assert(interruptedShell("shell", { exitCode: null, signal: "SIGKILL", timedOut: true }))
  assert(interruptedShell("shell", { exitCode: 0, signal: null, timedOut: true }))
  assert(!interruptedShell("shell", { exitCode: 0, signal: null, timedOut: false }))
  assert(!interruptedShell("shell", { exitCode: 1, signal: null, timedOut: false }))
  assert(!interruptedShell("browser_download", { signal: "SIGTERM", timedOut: true }))
})
