// Improvement state (B1 adds no tables): one JSON document per improvement objective in the
// settings key-value table, like manuals ("manual.*"). The objective row (A1) carries the
// status, limits and rounds; this document carries what the lab did with each candidate.
import { pool } from "@/db"

export const IMPROVEMENT_PREFIX = "improvement:"

export type StageResult = {
  name: "policy" | "build" | "checks" | "stack" | "e2e" | "acceptance"
  status: "pass" | "fail" | "skip"
  counts?: { passed: number; total: number }
  durationMs: number
  detail: string
  log?: string
}
export type AcceptanceResult = {
  item: string
  status: "pass" | "fail"
  note: string
  screenshot?: string
}
export type Evaluation = {
  suiteRevision: string
  stages: StageResult[]
  acceptance: AcceptanceResult[]
  passed: boolean
  startedAt: string
  finishedAt?: string
}
export type Candidate = {
  roundNo: number
  branch: string
  parent: string
  taskId: string
  phase: "reforming" | "evaluating" | "done"
  commit?: string
  // What the reformer says it did; never counts as a test result
  claim?: string
  files?: { path: string; added: number; removed: number; status: string }[]
  evaluation?: Evaluation
  versionId?: string
  images?: { web: string; worker: string }
  // Why this round was opened: owner feedback, an auto rollback, or a failed evaluation
  feedback?: string
}
export type Improvement = {
  objectiveId: string
  ownerId: string
  agentId: string
  title: string
  request: string
  checklist: string[]
  baseVersionId: string | null
  baseCommit: string
  status: "working" | "ready" | "adopting" | "adopted" | "abandoned"
  candidates: Candidate[]
  // Next round's extra context (再改改 or a rollback); cleared when consumed
  feedback?: string
  adoption?: {
    versionId: string
    roundNo: number
    at: string
    outcome?: "healthy" | "auto_rolled_back" | "failed"
    reason?: string
  }
  createdAt: string
  updatedAt: string
}

const KEY = "evolution.improvement."
const key = (objectiveId: string) => `${KEY}${objectiveId}`

export async function readImprovement(objectiveId: string): Promise<Improvement | null> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key=$1",
    [key(objectiveId)]
  )
  return rows[0] ? (JSON.parse(rows[0].value) as Improvement) : null
}

export async function writeImprovement(value: Improvement) {
  value.updatedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
    [key(value.objectiveId), JSON.stringify(value)]
  )
  return value
}

export async function updateImprovement(
  objectiveId: string,
  change: (value: Improvement) => void | Promise<void>
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [key(objectiveId)]
    )
    if (!rows[0]) throw new Error(`Improvement ${objectiveId} not found`)
    const value = JSON.parse(rows[0].value) as Improvement
    await change(value)
    value.updatedAt = new Date().toISOString()
    await client.query("UPDATE settings SET value=$2,updated_at=now() WHERE key=$1", [
      key(objectiveId),
      JSON.stringify(value),
    ])
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function listImprovements(ownerId?: string) {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key LIKE 'evolution.improvement.%'"
  )
  return rows
    .map((row) => JSON.parse(row.value) as Improvement)
    .filter((item) => !ownerId || item.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function evolutionEnabled() {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key='evolution.enabled'"
  )
  return rows[0]?.value === "true"
}

export async function setEvolutionEnabled(enabled: boolean) {
  await pool.query(
    `INSERT INTO settings(key,value,updated_at) VALUES('evolution.enabled',$1,now())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
    [String(enabled)]
  )
}
