import { isDeepStrictEqual } from "node:util"
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto"
import { and, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { db, pool } from "@/db"
import { routines, routineRuns } from "@/db/schema"
import { freezeRoutine, type RoutineTransaction } from "@/lib/routines"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import { env } from "@/lib/env"
import { routineEventGoal, ROUTINE_EVENT_LABEL } from "./routine-event-goal"
import { HttpError } from "@/lib/errors"

const eventSchema = z
  .object({ id: z.string().min(1).max(200), data: z.unknown() })
  .refine(
    (value) => value.data !== undefined && JSON.stringify(value.data).length <= 12000,
    "Event data exceeds 12000 characters"
  )
const binding = (id: string) => `routine-webhook:${env.INSTALL_ID}:${id}`
export async function rotateRoutineWebhook(id: string) {
  const token = randomBytes(32).toString("base64url")
  const rows = await pool.query(
    "UPDATE routines SET webhook_cipher=$2 WHERE id=$1 AND deleted_at IS NULL AND event_trigger->>'kind'='webhook' RETURNING id",
    [id, encryptSecret(token, binding(id))]
  )
  if (!rows.rowCount) throw new HttpError(404, "Webhook routine not found")
  return { url: `${env.APP_URL}/api/routine-events/${encodeURIComponent(id)}`, token }
}
async function stageEvent(
  tx: RoutineTransaction,
  id: string,
  ownerId: string,
  eventId: string,
  data: unknown,
  at: Date
) {
  const [routine] = await tx
    .select()
    .from(routines)
    .where(eq(routines.id, id))
    .for("update")
  if (!routine || routine.deletedAt || !routine.enabled || !routine.eventTrigger)
    throw new HttpError(409, "Event routine is paused or removed")
  const key = `routine:${id}:event:${eventId}`
  const [previous] = await tx
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.requestKey, key))
  if (previous) {
    const snapshot = previous.snapshot!
    const original = Object.hasOwn(snapshot, "eventData")
      ? snapshot.eventData
      : JSON.parse(snapshot.input.goal.split(ROUTINE_EVENT_LABEL).at(-1)!)
    if (!isDeepStrictEqual(original, data))
      throw new HttpError(409, "Event ID already used with different data")
    return { runId: previous.id, reused: true }
  }
  const snapshot = await freezeRoutine(routine, ownerId, at, key)
  snapshot.eventData = data
  snapshot.input.goal = routineEventGoal(snapshot.input.goal, data)
  const runId = randomUUID()
  await tx.insert(routineRuns).values({
    id: runId,
    routineId: id,
    trigger: "event",
    status: "queued",
    requestKey: key,
    planVersion: routine.planVersion,
    snapshot,
    dueAt: at,
    startedAt: at,
  })
  return { runId, reused: false }
}
export async function acceptRoutineEvent(id: string, token: string, raw: unknown) {
  const event = eventSchema.parse(raw)
  return db.transaction(async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .for("update")
    if (!routine?.webhookCipher || routine.eventTrigger?.kind !== "webhook")
      throw new HttpError(404, "Webhook not found")
    const expected = Buffer.from(decryptSecret(routine.webhookCipher, binding(id))),
      given = Buffer.from(token)
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new HttpError(401, "Invalid webhook token")
    const owner = await tx.execute<{ user_id: string }>(
      sql`SELECT user_id FROM owners ORDER BY id LIMIT 1`
    )
    return stageEvent(tx, id, owner.rows[0].user_id, event.id, event.data, new Date())
  })
}
async function readWatch(url: string) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/html,text/plain,application/json" },
  })
  if (!response.ok) throw new Error(`Watch source returned ${response.status}`)
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 100000) {
      await reader.cancel()
      throw new Error("Watch source exceeds 100000 bytes")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
export async function stageChangedRoutines(now = new Date()) {
  const due = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.enabled, true),
        isNull(routines.deletedAt),
        sql`${routines.eventTrigger}->>'kind'='url_change' AND ${routines.nextWatchAt}<=${now}`
      )
    )
    .limit(20)
  let triggered = 0
  for (const candidate of due) {
    if (candidate.eventTrigger?.kind !== "url_change") continue
    let content: string | undefined, error: string | undefined
    try {
      content = await readWatch(candidate.eventTrigger.url)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(routines)
        .where(eq(routines.id, candidate.id))
        .for("update")
      if (
        !current.enabled ||
        current.deletedAt ||
        current.planVersion !== candidate.planVersion ||
        !current.nextWatchAt ||
        current.nextWatchAt > now ||
        current.eventTrigger?.kind !== "url_change"
      )
        return
      if (
        content !== undefined &&
        current.watchState &&
        current.watchState.content !== content
      ) {
        const owner = await tx.execute<{ user_id: string }>(
          sql`SELECT user_id FROM owners ORDER BY id LIMIT 1`
        )
        await stageEvent(
          tx,
          current.id,
          owner.rows[0].user_id,
          `change:${current.planVersion}:${current.watchState.revision + 1}`,
          {
            url: current.eventTrigger.url,
            changedAt: now.toISOString(),
            previous: current.watchState.content.slice(0, 5000),
            current: content.slice(0, 5000),
          },
          now
        )
        triggered++
      }
      await tx
        .update(routines)
        .set({
          nextWatchAt: new Date(
            now.getTime() + current.eventTrigger.everyMinutes * 60000
          ),
          lastError: error ?? null,
          ...(content !== undefined
            ? {
                watchState: {
                  content,
                  revision:
                    (current.watchState?.revision ?? 0) +
                    (current.watchState?.content === content ? 0 : 1),
                },
              }
            : {}),
        })
        .where(eq(routines.id, current.id))
    })
  }
  return triggered
}
