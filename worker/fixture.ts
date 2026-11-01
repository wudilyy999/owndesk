import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { DBOS } from "@dbos-inc/dbos-sdk"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { artifacts, tasks, type Task } from "@/db/schema"
import { artifactDir } from "@/lib/env"
import { appendEvent, appendEventInTransaction } from "@/lib/task-events"
import { TaskCancelled } from "@/lib/workstation"
import { trackActivity } from "./activity"

// A controlled experiment, never a substitute for a model-driven task.
const csv =
  "date,site,amount\n2026-10-12,A,100\n2026-10-13,B,200\n2026-10-14,A,110\n2026-10-15,B,210\n"

export async function runFixture(taskId: string, segmentNo: number) {
  const task = await DBOS.runStep(
    () =>
      trackActivity(taskId, async () => {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
        if (task.configSnapshot.runtime !== "fixture")
          throw new Error("Fixture runtime is restricted to fixture tasks")
        await journal(taskId, "prepare")
        await db
          .update(tasks)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(tasks.id, taskId))
        await appendEvent(taskId, "fixture-prepared", "progress", {
          step: "prepare",
          message: "Controlled input prepared; no model was called",
        })
        return task
      }),
    { name: "fixture-prepare" }
  )

  await DBOS.sleep(5000)
  const file = await DBOS.runStep(
    () =>
      trackActivity(taskId, async () => {
        await journal(taskId, "materialize")
        const relative = `${taskId}/report.csv`
        const target = path.join(artifactDir, relative)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(`${target}.partial`, csv, { flag: "w" })
        await rename(`${target}.partial`, target)
        await appendEvent(taskId, "fixture-materialized", "progress", {
          step: "materialize",
          message: "Report file written atomically",
        })
        return relative
      }),
    { name: "fixture-materialize" }
  )

  await DBOS.sleep(5000)
  return DBOS.runStep(
    () =>
      trackActivity(taskId, async () => {
        await journal(taskId, "verify")
        return verifyAndComplete(task, segmentNo, file)
      }),
    { name: "fixture-verify" }
  )
}

async function journal(taskId: string, step: string) {
  const directory = path.join(artifactDir, ".experiments", taskId)
  await mkdir(directory, { recursive: true })
  await appendFile(
    path.join(directory, "invocations.ndjson"),
    `${JSON.stringify({ step, at: new Date().toISOString() })}\n`
  )
}

async function verifyAndComplete(task: Task, segmentNo: number, relative: string) {
  const target = path.join(artifactDir, relative)
  const content = await readFile(target, "utf8")
  // Known-answer check lives in trusted worker code, outside the agent's workstation.
  if (content !== csv)
    throw new Error("Fixture output differs from the trusted expected report")
  const size = (await stat(target)).size
  const verification = {
    grade: "program_checked",
    method: "known-answer-fixture-v1",
    rows: 4,
    totalAmount: 620,
    fixtureOnly: true,
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const completed = await client.query(
      "UPDATE tasks SET status='completed',updated_at=now() WHERE id=$1 AND cancel_requested_at IS NULL RETURNING id",
      [task.id]
    )
    if (!completed.rowCount) throw new TaskCancelled()
    await client.query(
      `INSERT INTO artifacts(id,task_id,name,storage_path,media_type,size,verification,created_at)
      VALUES($1,$2,'report.csv',$3,'text/csv',$4,$5,now()) ON CONFLICT(task_id,storage_path) DO NOTHING`,
      [randomUUID(), task.id, relative, size, JSON.stringify(verification)]
    )
    await client.query(
      "UPDATE tasks SET status='completed', result=$2, updated_at=now() WHERE id=$1",
      [
        task.id,
        JSON.stringify({
          summary: "Three-step recovery experiment completed",
          verification,
          segmentNo,
        }),
      ]
    )
    await appendEventInTransaction(client, task.id, "completed", "completed", {
      verification,
      summary: "Controlled report verified. This run used no real model or website.",
    })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return { verified: true, fixtureOnly: true }
}
