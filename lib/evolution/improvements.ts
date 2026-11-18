// What the owner does with improvements: confirm a proposal card, adopt a passing candidate,
// ask for another round, or abandon it; and what happens after adoption (B0's updater
// switches versions; an automatic rollback opens a debug round in the copy).
import { randomUUID } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
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
import { git, repoReady, resolveCommit } from "@/lib/evolution/repo"
import {
  evolutionEnabled,
  IMPROVEMENT_PREFIX,
  readImprovement,
  updateImprovement,
  writeImprovement,
  type Improvement,
} from "@/lib/evolution/store"
import { createObjective } from "@/lib/objectives"
import { importSource, requestSwitch, switchPending } from "@/lib/versions"

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
  const {
    rows: [active],
  } = await pool.query<{
    id: string
    kind: string
    git_commit: string | null
    source_revision: string
  }>(
    "SELECT id,kind,git_commit,source_revision FROM agent_versions WHERE status='active'"
  )
  if (!active || !candidate.commit)
    throw new HttpError(409, "无法核对当前版本的源码，暂时不能采用")
  // An adopted local image also records its original candidate commit. B0 may import
  // the same source as a separate upstream commit when the worker restarts.
  const refs = [
    active.git_commit,
    active.kind === "local" ? active.source_revision : null,
  ]
  const currentIsBase = (
    await Promise.all(
      refs
        .filter((ref): ref is string => !!ref && /^[a-f0-9]{40}$/.test(ref))
        .map((ref) =>
          git(["merge-base", "--is-ancestor", ref, candidate.commit!]).then(
            () => true,
            () => false
          )
        )
    )
  ).some(Boolean)
  if (!currentIsBase)
    throw new HttpError(409, "当前版本已更新，请基于当前版本重新发起改进后再采用")
  const versionId = candidate.versionId
  await updateImprovement(objectiveId, async (value) => {
    const current = latest(value)
    if (
      value.status !== "ready" ||
      current?.versionId !== versionId ||
      current.roundNo !== candidate.roundNo
    )
      throw new HttpError(409, "改进状态已变化，请刷新后再试")
    const at = new Date().toISOString()
    const { deploymentId } = await requestSwitch(versionId, "promote", active.id)
    value.status = "adopting"
    value.adoption = { versionId, roundNo: candidate.roundNo, at, deploymentId }
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
    const lookup = async () =>
      (
        await pool.query<{
          status: string
          reason: string | null
          health_log: unknown[]
          rollback_status: string | null
          rollback_reason: string | null
        }>(
          `SELECT d.status,d.reason,d.health_log,r.status AS rollback_status,r.reason AS rollback_reason
       FROM deployments d LEFT JOIN deployments r ON r.id=d.related_id
        AND r.action='auto_rollback' AND r.related_id=d.id
        AND r.from_version_id=d.to_version_id AND r.to_version_id=d.from_version_id
       WHERE d.to_version_id=$1 AND d.action='promote'
       AND CASE WHEN $3::text IS NOT NULL THEN d.id=$3
           ELSE d.started_at >= $2::timestamptz - interval '1 minute' END
       ORDER BY d.started_at DESC LIMIT 1`,
          [adoption.versionId, adoption.at, adoption.deploymentId ?? null]
        )
      ).rows[0]
    let deployment = await lookup()
    if (!deployment && improvement.status === "adopting" && adoption.deploymentId) {
      if (await switchPending(adoption.deploymentId)) continue
      // The switch may have recorded a deployment and exited since the first lookup.
      deployment = await lookup()
      if (!deployment) {
        await updateImprovement(improvement.objectiveId, (item) => {
          if (
            item.status !== "adopting" ||
            item.adoption?.deploymentId !== adoption.deploymentId
          )
            return
          item.status = "ready"
          item.adoption = { ...adoption, outcome: "not_started" }
        })
      }
    }
    if (!deployment) continue
    // B0 marks the promotion rolled_back before it starts restoring the old images.
    // Only the related rollback's healthy result proves recovery finished.
    if (
      deployment.status === "failed" ||
      (deployment.status === "rolled_back" && deployment.rollback_status !== "healthy")
    ) {
      if (
        (deployment.status === "failed" || deployment.rollback_status === "failed") &&
        adoption.outcome !== "failed"
      ) {
        const reason = deployment.rollback_reason ?? deployment.reason ?? "健康检测没通过"
        await updateImprovement(improvement.objectiveId, (item) => {
          item.adoption = { ...item.adoption!, outcome: "failed", reason }
        })
        await db
          .update(objectives)
          .set({
            status: "paused",
            statusReason: `旧版本恢复尚未完成：${reason}`,
            updatedAt: new Date(),
          })
          .where(eq(objectives.id, improvement.objectiveId))
        await tell(
          improvement.agentId,
          improvement.objectiveId,
          `「${improvement.title}」采用后健康检测失败，旧版本恢复尚未完成（${reason}）。改进已暂停，恢复正常后再在副本里 debug。`
        )
      }
      continue
    }
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
    } else if (deployment.status === "rolled_back") {
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
    ? await db.select().from(objectives).where(inArray(objectives.id, ids))
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
