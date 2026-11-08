import path from "node:path"
import type { Task } from "@/db/schema"
import { pool } from "@/db"
import { docker } from "@/lib/docker"
import { readUpload, type UploadReference } from "@/lib/uploads"
import { appendEvent } from "@/lib/task-events"
import {
  assertAgentControl,
  workstationName,
  withWorkspaceOperation,
} from "@/lib/workstation"
import { trackActivity } from "./activity"

export async function importTaskUploads(
  task: Task,
  segmentNo: number,
  files: UploadReference[]
) {
  return withWorkspaceOperation(task.agentId, () =>
    trackActivity(task.id, async () => {
      const imported: { id: string; name: string; path: string; mediaType: string }[] = []
      for (const file of files) {
        const key = `upload:${segmentNo}:${file.id}`
        const {
          rows: [previous],
        } = await pool.query<{ payload: { file: (typeof imported)[number] } }>(
          "SELECT payload FROM task_events WHERE task_id=$1 AND key=$2",
          [task.id, key]
        )
        if (previous) {
          imported.push(previous.payload.file)
          continue
        }
        await assertAgentControl(task.id, task.agentId, segmentNo)
        const source = await readUpload(task.ownerId, file.id)
        const target = `/home/agent/Inbox/${task.id}/${file.id}/${file.name}`
        await docker(
          [
            "exec",
            workstationName(task.agentId),
            "mkdir",
            "-p",
            path.posix.dirname(target),
          ],
          { timeoutMs: 15000 }
        )
        await docker(["cp", source.file, `${workstationName(task.agentId)}:${target}`], {
          timeoutMs: 60000,
        })
        await docker(
          [
            "exec",
            "--user",
            "root",
            workstationName(task.agentId),
            "chown",
            "1000:1000",
            target,
          ],
          { timeoutMs: 15000 }
        )
        const actual = await docker(
          ["exec", workstationName(task.agentId), "cat", target],
          { timeoutMs: 15000, maxOutputBytes: source.size + 1024 }
        )
        if (!actual.stdout.equals(source.bytes))
          throw new Error("Uploaded file differs from workstation copy")
        await assertAgentControl(task.id, task.agentId, segmentNo)
        const entry = {
          id: file.id,
          name: file.name,
          path: target,
          mediaType: file.mediaType,
        }
        await appendEvent(task.id, key, "upload_imported", { file: entry })
        imported.push(entry)
      }
      return imported
    })
  )
}
