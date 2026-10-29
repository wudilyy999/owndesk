// A process stopped by a signal/timeout may have committed effects before stopping.
// Ordinary command exit codes remain observable results, e.g. grep's no-match status.
export function interruptedShell(kind: string, output: Record<string, unknown>) {
  return (
    kind === "shell" && (typeof output.signal === "string" || output.timedOut === true)
  )
}
