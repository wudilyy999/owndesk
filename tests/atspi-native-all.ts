// `npm run test:atspi:native`: run every phase of tests/atspi-native.ts, one container each.
// A single phase: `tsx tests/atspi-native.ts <phase>` (or `-- <phase>` here).
import { spawn } from "node:child_process"
import { nativePhases } from "./atspi-native-phases"

const only = process.argv.slice(2).filter((arg) => arg !== "--")
const unknown = only.filter(
  (phase) => !(nativePhases as readonly string[]).includes(phase)
)
if (unknown.length) throw new Error(`unknown phase: ${unknown.join(", ")}`)
const phases = only.length ? only : [...nativePhases]

const run = (phase: string) =>
  new Promise<number>((resolve) => {
    const child = spawn("npx", ["tsx", "tests/atspi-native.ts", phase], {
      stdio: "inherit",
    })
    child.on("exit", (code) => resolve(code ?? 1))
  })

const results: { phase: string; code: number; seconds: number }[] = []
for (const phase of phases) {
  const started = Date.now()
  console.log(`\n=== atspi native: ${phase} ===`)
  const code = await run(phase)
  results.push({ phase, code, seconds: Math.round((Date.now() - started) / 1000) })
}
console.log("\n=== atspi native summary ===")
for (const r of results)
  console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.phase}  (${r.seconds}s)`)
const failed = results.filter((r) => r.code !== 0)
console.log(`${results.length - failed.length}/${results.length} phases passed`)
process.exit(failed.length ? 1 : 0)
