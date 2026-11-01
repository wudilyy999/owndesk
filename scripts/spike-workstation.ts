export {}
// Spike S0: measure workstation cold/warm start and the read-only viewer path.
// Usage: tsx scripts/spike-workstation.ts <agentId>
process.loadEnvFile(".env")
const agentId = process.argv[2]
if (!agentId) throw new Error("agentId required")
const {
  ensureWorkstation,
  workstationHealth,
  stopWorkstationBoundary,
  openDesktopStream,
} = await import("@/lib/workstation")
const { pool } = await import("@/db")
const { docker } = await import("@/lib/docker")

async function timed<T>(label: string, fn: () => Promise<T>) {
  const t = performance.now()
  const value = await fn()
  console.log(`${label}: ${Math.round(performance.now() - t)} ms`)
  return value
}
try {
  await timed("cold ensureWorkstation (create+start)", () => ensureWorkstation(agentId))
  console.log(
    "health",
    JSON.stringify(await timed("health", () => workstationHealth(agentId)))
  )
  const mem = await docker([
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}",
  ])
  console.log(mem.stdout.toString().trim())
  const stream = await timed("open read-only (watch) stream", () =>
    openDesktopStream(agentId, "watch")
  )
  stream.on("error", () => {})
  console.log("watch stream opened")
  await timed("stop boundary", () => stopWorkstationBoundary(agentId))
  await timed("warm ensureWorkstation (restart, volume kept)", () =>
    ensureWorkstation(agentId)
  )
  console.log("health", JSON.stringify(await workstationHealth(agentId)))
} finally {
  await pool.end()
}
