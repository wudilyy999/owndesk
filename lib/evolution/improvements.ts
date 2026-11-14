// What the owner does with improvements: confirm a proposal card, adopt a passing candidate,
// ask for another round, or abandon it; and what happens after adoption (B0's updater
// switches versions; an automatic rollback opens a debug round in the copy).
import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { db, pool } from "@/db"
import {
  agentVersions,
  companionMessages,
  companions,
  objectives,
  objectiveBudgetSchema,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { repoReady, resolveCommit } from "@/lib/evolution/repo"
import {
  evolutionEnabled,
  IMPROVEMENT_PREFIX,
  readImprovement,
  updateImprovement,
  writeImprovement,
  type Improvement,
} from "@/lib/evolution/store"
import { createObjective } from "@/lib/objectives"
import { importSource, requestSwitch } from "@/lib/versions"

export const improvementProposalSchema = z.object({
  title: z.string().trim().min(1).max(60),
  request: z.string().trim().min(1).max(4000),
  checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  budget: objectiveBudgetSchema.default({ roundMaxSteps: 40 }),
})
export type ImprovementProposal = z.infer<typeof improvementProposalSchema>

// The version the candidate starts from: the active version's source, else the newest
// imported official source
async function baseVersion() {
  const {
    rows: [active],
  } = await pool.query<{ id: string; git_commit: string | null }>(
    "SELECT id,git_commit FROM agent_versions WHERE status='active' LIMIT 1"
  )
  if (active?.git_commit) return { versionId: active.id, commit: active.git_commit }
  if (!repoReady()) await importSource()
  const upstream = repoReady() ? await resolveCommit("refs/heads/upstream") : ""
  if (!upstream)
    throw new HttpError(409, "版本库里还没有当前版本的源码，暂时不能开始改进")
  return { versionId: active?.id ?? null, commit: upstream }
}

export async function createImprovement(
  ownerId: string,
  agentId: string,
  raw: unknown,
  proposalKey: string = randomUUID()
) {
  if (!(await evolutionEnabled()))
    throw new HttpError(409, "自我改进还没打开：到“设置 → 自我改进”里打开后再试")
  const proposal = improvementProposalSchema.parse(raw)
  const base = await baseVersion()
  const objective = await createObjective(
    ownerId,
    {
      agentId,
      title: proposal.title,
      objective: proposal.request,
      doneCriteria: proposal.checklist.map((item) => `- ${item}`).join("\n"),
      budget: proposal.budget,
    },
    `${IMPROVEMENT_PREFIX}${proposalKey}`
  )
  if (!(await readImprovement(objective.id)))
    await writeImprovement({
      objectiveId: objective.id,
      ownerId,
      agentId,
      title: proposal.title,
      request: proposal.request,
      checklist: proposal.checklist,
      baseVersionId: base.versionId,
      baseCommit: base.commit,
      status: "working",
      candidates: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  return objective
}

async function ownedProposal(ownerId: string, messageId: string) {
  const [row] = await db
    .select({ message: companionMessages })
    .from(companionMessages)
    .innerJoin(companions, eq(companions.agentId, companionMessages.agentId))
    .where(
      and(
        eq(companionMessages.id, messageId),
        eq(companionMessages.kind, "improvement_proposal"),
        eq(companions.ownerId, ownerId)
      )
    )
  if (!row) throw new HttpError(404, "Improvement proposal not found")
  return row.message
}

// Confirming the card starts the improvement; the owner may edit the checklist first
export async function confirmImprovementProposal(
  ownerId: string,
  messageId: string,
  checklist?: string[]
) {
  const message = await ownedProposal(ownerId, messageId)
  const meta = message.metadata as { proposal: ImprovementProposal; status: string }
  if (meta.status === "confirmed") {
    const [existing] = await db
      .select()
      .from(objectives)
      .where(eq(objectives.proposalId, `${IMPROVEMENT_PREFIX}${messageId}`))
    if (existing) return existing
  }
  if (meta.status !== "pending" || message.supersededAt)
    throw new HttpError(409, "This proposal was already answered")
  const objective = await createImprovement(
    ownerId,
    message.agentId,
    { ...meta.proposal, ...(checklist ? { checklist } : {}) },
    messageId
  )
  await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "confirmed", objectiveId: objective.id, ...(checklist ? { checklist } : {}) })}::jsonb`,
    })
    .where(eq(companionMessages.id, messageId))
  return objective
}

export async function cancelImprovementProposal(ownerId: string, messageId: string) {
  await ownedProposal(ownerId, messageId)
  const rows = await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "cancelled" })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.id, messageId),
        sql`${companionMessages.metadata}->>'status' = 'pending' AND ${companionMessages.supersededAt} IS NULL`
      )
    )
    .returning({ id: companionMessages.id })
  if (!rows.length) throw new HttpError(409, "This proposal was already answered")
}

async function owned(ownerId: string, objectiveId: string) {
  const improvement = await readImprovement(objectiveId)
  if (!improvement || improvement.ownerId !== ownerId)
    throw new HttpError(404, "Improvement not found")
  return improvement
}

const latest = (improvement: Improvement) => improvement.candidates.at(-1)

async function reopen(objectiveId: string, reason: string | null) {
  await db
    .update(objectives)
    .set({
      status: "active",
      statusReason: reason,
      failures: 0,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(objectives.id, objectiveId))
}

// 采用: only a candidate whose evaluation passed, and only by the owner's click
export async function adoptImprovement(ownerId: string, objectiveId: string) {
  const improvement = await owned(ownerId, objectiveId)
  const candidate = latest(improvement)
  if (
    improvement.status !== "ready" ||
    !candidate?.evaluation?.passed ||
    !candidate.versionId
  )
    throw new HttpError(409, "只有全部测试都通过的版本才能采用")
  await requestSwitch(candidate.versionId, "promote")
  await updateImprovement(objectiveId, (value) => {
    value.status = "adopting"
    value.adoption = {
      versionId: candidate.versionId!,
      roundNo: candidate.roundNo,
      at: new Date().toISOString(),
    }
  })
  return { started: true }
}

// 再改改: the owner's note goes to the reformer; the next round reruns every test
export async function reviseImprovement(
  ownerId: string,
  objectiveId: string,
  note: string
) {
  const improvement = await owned(ownerId, objectiveId)
  if (improvement.status === "abandoned" || improvement.status === "adopting")
    throw new HttpError(409, "这个改进现在不能再改")
  await updateImprovement(objectiveId, (value) => {
    value.feedback = `The owner reviewed the last candidate and wants changes:\n${note}`
    value.status = "working"
  })
  await reopen(objectiveId, null)
}

// 放弃: the candidates stay in the archive (cand/* branches)
export async function abandonImprovement(ownerId: string, objectiveId: string) {
  const improvement = await owned(ownerId, objectiveId)
  if (improvement.status === "adopting")
    throw new HttpError(409, "正在切换版本，稍后再试")
  await updateImprovement(objectiveId, (value) => {
    value.status = "abandoned"
  })
  const versionIds = improvement.candidates.flatMap((item) =>
    item.versionId ? [item.versionId] : []
  )
  if (versionIds.length)
    await pool.query(
      "UPDATE agent_versions SET status='rejected' WHERE id = ANY($1) AND status='ready'",
      [versionIds]
    )
  await db
    .update(objectives)
    .set({
      status: "stopped",
      statusReason: "你放弃了这个改进",
      updatedAt: new Date(),
      finishedAt: new Date(),
    })
    .where(eq(objectives.id, objectiveId))
}

async function tell(agentId: string, objectiveId: string, content: string) {
  const { rowCount } = await pool.query("SELECT 1 FROM companions WHERE agent_id=$1", [
    agentId,
  ])
  if (!rowCount) return
  await db.insert(companionMessages).values({
    agentId,
    role: "assistant",
    kind: "objective_update",
    content,
    metadata: { objectiveId },
    channel: "web",
  })
}

// Dispatcher tick: follow adopted versions. Healthy -> adopted. Rolled back (at the switch or
// any time later) -> tell the owner and open a debug round in the copy.
export async function watchAdoptions() {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key LIKE 'evolution.improvement.%' AND value::jsonb->>'status' IN ('adopting','adopted')"
  )
  for (const { value } of rows) {
    const improvement = JSON.parse(value) as Improvement
    const adoption = improvement.adoption
    if (!adoption) continue
    const {
      rows: [deployment],
    } = await pool.query<{
      status: string
      reason: string | null
      health_log: unknown[]
    }>(
      `SELECT status,reason,health_log FROM deployments WHERE to_version_id=$1 AND action='promote'
       AND started_at >= $2::timestamptz - interval '1 minute' ORDER BY started_at DESC LIMIT 1`,
      [adoption.versionId, adoption.at]
    )
    if (!deployment) continue
    if (deployment.status === "healthy" && improvement.status === "adopting") {
      await updateImprovement(improvement.objectiveId, (item) => {
        item.status = "adopted"
        item.adoption = { ...item.adoption!, outcome: "healthy" }
      })
      await tell(
        improvement.agentId,
        improvement.objectiveId,
        `「${improvement.title}」已经换成新版本，运行正常。旧版本保留着，可以在版本页一键回退。`
      )
    } else if (deployment.status === "rolled_back" || deployment.status === "failed") {
      const reason = deployment.reason ?? "健康检测没通过"
      await updateImprovement(improvement.objectiveId, (item) => {
        item.status = "working"
        item.adoption = { ...item.adoption!, outcome: "auto_rolled_back", reason }
        item.feedback = [
          "The adopted version was automatically rolled back to the previous version because it became unhealthy after the switch.",
          `Updater reason: ${reason}`,
          `Last health checks: ${JSON.stringify(deployment.health_log.slice(-5))}`,
          "Reproduce and fix the cause in this copy (for example a crash or failing health endpoint after start), keep the requested behavior, and add a test.",
        ].join("\n")
      })
      await reopen(
        improvement.objectiveId,
        "新版本出了问题，已自动退回旧版本；正在副本里 debug"
      )
      await tell(
        improvement.agentId,
        improvement.objectiveId,
        `「${improvement.title}」的新版本出了问题（${reason}），我已经先自动换回旧版本，你可以照常用。接下来在副本里找原因、修好，全部测试重新通过后再请你采用。`
      )
    }
  }
}

// Everything the improvements page shows
export async function improvementOverview(ownerId: string) {
  const { listImprovements } = await import("@/lib/evolution/store")
  const items = await listImprovements(ownerId)
  const ids = items.map((item) => item.objectiveId)
  const rows = ids.length
    ? await db
        .select()
        .from(objectives)
        .where(sql`${objectives.id} = ANY(${ids})`)
    : []
  const versions = await db
    .select({
      id: agentVersions.id,
      label: agentVersions.label,
      status: agentVersions.status,
    })
    .from(agentVersions)
  return {
    enabled: await evolutionEnabled(),
    improvements: items.map((item) => ({
      ...item,
      objective: rows.find((row) => row.id === item.objectiveId) ?? null,
      candidates: item.candidates.map((candidate) => ({
        ...candidate,
        version: versions.find((version) => version.id === candidate.versionId) ?? null,
      })),
    })),
  }
}
export type ImprovementOverview = Awaited<ReturnType<typeof improvementOverview>>
