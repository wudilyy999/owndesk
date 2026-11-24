import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Objective } from "@/db/schema"
import { developmentPreview } from "./dev-preview"
import { captureLabCommit, loadCommit, startLab, stopLab, readLabFile } from "./lab"
import { LabBudgetError } from "./meter"
import type { Conflict } from "./rebase"
import { reformerJournal, runReformer } from "./reformer"
import { commitTree, extract, resolveCommit } from "./repo"

// Git metadata stays on the trusted side. Only the frozen source and the listed text
// conflicts enter the normal offline lab. Only those files may leave it as resolutions.
export async function resolveInLab(input: {
  patch: string
  onto: string
  conflicts: Conflict[]
  taskId: string
  objective: Objective
  key: string
  labImage: string
  spec: string
  rules: string
  cancelled: () => Promise<boolean>
  log: (s: string) => void
}) {
  const ref = `merge-input/${input.taskId}/${input.onto}/${input.patch}`
  let seed = await resolveCommit(`refs/heads/${ref}`)
  if (!seed) {
    const work = await mkdtemp(path.join(os.tmpdir(), "owndesk-conflict-"))
    try {
      await extract(input.onto, work)
      for (const file of input.conflicts)
        await writeFile(path.join(work, file.path), file.text)
      seed = await commitTree(
        work,
        input.onto,
        ref,
        "Conflict input for isolated reformer"
      )
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
  const journal = await reformerJournal(input.taskId, seed)
  const lab = await startLab(input.labImage, input.key + "-conflict"),
    preview = developmentPreview(input.labImage)
  try {
    const result = await runReformer({
      objective: input.objective,
      taskId: input.taskId,
      spec: input.spec,
      lab,
      preview,
      rules: input.rules,
      parent: seed,
      journal,
      cancelled: input.cancelled,
      log: input.log,
      restore: (commit) => loadCommit(lab, commit),
      capture: (parent) => captureLabCommit(lab, parent, input.taskId),
      brief: `Resolve these Git conflicts in the offline source copy: ${input.conflicts.map((f) => f.path).join(", ")}. HEAD contains the new official version; the other side is the owner's local improvement. Preserve both intended behaviors. Owner's request: ${input.objective.objective}. Remove markers, check the result, then finish. Only the named files will be accepted.`,
    })
    if (!result.finished) throw new LabBudgetError(result.summary, result.end ?? "steps")
    if (await input.cancelled()) throw new Error("Merge cancelled")
    return await Promise.all(
      input.conflicts.map(async (file) => {
        const text = await readLabFile(lab, file.path)
        if (text === null) throw new Error(`Missing resolved file: ${file.path}`)
        return { path: file.path, text }
      })
    )
  } catch (error) {
    throw journal.interrupted(error)
  } finally {
    try {
      await preview.close()
    } finally {
      await stopLab(lab)
    }
  }
}
