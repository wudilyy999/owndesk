import { developmentPreview } from "./dev-preview"
import { UnknownLabTurn } from "./journal"
// Improvement rounds (B1). An improvement is an A1 objective whose rounds are run by the lab
// instead of the ordinary task runtime: each round is still a task row (so cost, limits,
// pause/stop and the round history all work as for any objective), driven here in the worker.
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import {
  agents,
  agentVersions,
  companionMessages,
  objectives,
  type Objective,
  type ObjectiveRoundInput,
} from "@/db/schema"
import { docker } from "@/lib/docker"
import { replayPatches } from "./rebase"
import { resolveInLab } from "./resolve-conflict"
import { repoDir } from "./repo"
import { evaluate } from "@/lib/evolution/evaluator"
import {
  ensureLabImage,
  captureLabCommit,
  exportTree,
  loadCommit,
  startLab,
  stopLab,
} from "@/lib/evolution/lab"
import { LabBudgetError } from "@/lib/evolution/meter"
import { reformerJournal, runReformer } from "@/lib/evolution/reformer"
import {
  changedFiles,
  commitTree,
  evolutionDir,
  git,
  gitText,
} from "@/lib/evolution/repo"
import {
  IMPROVEMENT_PREFIX,
  readImprovement,
  updateImprovement,
  type Candidate,
  type Evaluation,
  type Improvement,
} from "@/lib/evolution/store"
import { resolveModelSpec } from "@/lib/providers/registry"

export const IMPROVEMENT_SOURCE = "improvement"
const running = new Map<string, Promise<void>>()

export const isImprovement = (objective: Pick<Objective, "proposalId">) =>
  !!objective.proposalId?.startsWith(IMPROVEMENT_PREFIX)

const shortId = (id: string) =>
  id
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 10)
    .toLowerCase()
const roundKey = (objectiveId: string, roundNo: number) =>
  `${shortId(objectiveId)}-${roundNo}`

async function logLine(objectiveId: string, roundNo: number, line: string) {
  const dir = path.join(evolutionDir(), "logs")
  const { appendFile, mkdir } = await import("node:fs/promises")
  await mkdir(dir, { recursive: true })
  await appendFile(
    path.join(dir, `${roundKey(objectiveId, roundNo)}.log`),
    `[${new Date().toISOString()}] ${line}\n`
  )
}

export async function roundLog(objectiveId: string, roundNo: number) {
  const file = path.join(evolutionDir(), "logs", `${roundKey(objectiveId, roundNo)}.log`)
  return existsSync(file) ? (await readFile(file, "utf8")).slice(-20000) : ""
}

// Called by the objective dispatcher instead of submitTask for improvement objectives
export async function startImprovementRound(
  objective: Objective,
  round: { id: string; input: ObjectiveRoundInput }
) {
  const roundNo = round.input.objectiveRound!.roundNo
  const [agent] = await db.select().from(agents).where(eq(agents.id, objective.agentId))
  const spec = await resolveModelSpec(agent?.model)
  const {
    rows: [task],
  } = await pool.query<{ id: string }>(
    `INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,objective_id,created_at,updated_at)
     VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,now(),now())
     ON CONFLICT(owner_id,source,request_key) DO UPDATE SET updated_at=tasks.updated_at RETURNING id`,
    [
      objective.ownerId,
      objective.agentId,
      IMPROVEMENT_SOURCE,
      round.input.clientRequestId,
      JSON.stringify({ ...round.input, clientRequestId: undefined }),
      round.input.goal,
      JSON.stringify({ requireHumanReview: false }),
      JSON.stringify({
        model: spec ?? "unknown",
        instructions: "",
        memories: [],
        name: agent?.name,
        objectiveRound: { objectiveId: objective.id, roundNo },
        runtime: "agent",
      }),
      JSON.stringify(round.input.budget),
      objective.id,
    ]
  )
  await pool.query("UPDATE objective_rounds SET task_id=$2 WHERE id=$1", [
    round.id,
    task.id,
  ])
  kick(objective.id, roundNo, task.id)
  return task.id
}

function kick(objectiveId: string, roundNo: number, taskId: string) {
  if (running.has(objectiveId)) return
  const job = runRound(objectiveId, roundNo, taskId)
    .catch((error) => console.error("Improvement round failed", error))
    .finally(() => running.delete(objectiveId))
  running.set(objectiveId, job)
}

// After a worker restart: pick up rounds whose task is still open
export async function resumeImprovementRounds() {
  const { rows } = await pool.query<{
    objective_id: string
    round_no: number
    task_id: string
  }>(
    `SELECT r.objective_id,r.round_no,r.task_id FROM objective_rounds r
     JOIN tasks t ON t.id=r.task_id JOIN objectives o ON o.id=r.objective_id
     WHERE r.verdict IS NULL AND t.source=$1 AND t.status='running' AND o.proposal_id LIKE 'improvement:%'`,
    [IMPROVEMENT_SOURCE]
  )
  for (const row of rows) {
    if (running.has(row.objective_id)) continue
    const pending = await pool.query(
      `UPDATE task_model_attempts SET status='unknown',finished_at=now(),error='Worker restarted before a model receipt was recorded'
       WHERE task_id=$1 AND status='pending' AND COALESCE(price_snapshot->>'kind','priced')<>'local' RETURNING id`,
      [row.task_id]
    )
    // Worker startup may already have marked these receipts unknown before this hook.
    const unresolved = await pool.query(
      `SELECT id FROM task_model_attempts WHERE task_id=$1 AND status='unknown'
       AND cost_micros IS NULL AND reconciled_cost_micros IS NULL LIMIT 1`,
      [row.task_id]
    )
    if (pending.rowCount || unresolved.rowCount) {
      await pool.query(
        "UPDATE objectives SET status='paused',status_reason=$2,updated_at=now() WHERE id=$1 AND status='active'",
        [row.objective_id, "重启前有模型请求缺少回执，需先核对。"]
      )
      await finishTask(row.task_id, {
        status: "completed",
        achieved: false,
        end: "cost",
        summary: "重启前有模型请求尚未收到回执；请在用量页核对后再继续改进。",
      })
      continue
    }
    kick(row.objective_id, row.round_no, row.task_id)
  }
}

export function idleForTests() {
  return Promise.all(running.values())
}

async function trustedCommit(improvement: Improvement) {
  // The evaluator's code and frozen tests: the version running now
  const {
    rows: [active],
  } = await pool.query<{ git_commit: string | null }>(
    "SELECT git_commit FROM agent_versions WHERE status='active' AND git_commit IS NOT NULL LIMIT 1"
  )
  return active?.git_commit ?? improvement.baseCommit
}

async function finishTask(
  taskId: string,
  outcome:
    | { status: "completed"; summary: string; achieved: boolean; end?: "steps" | "cost" }
    | { status: "failed"; error: string }
    | { status: "cancelled" }
) {
  let ended: { rows: { objective_id: string }[] }
  if (outcome.status === "completed")
    ended = await pool.query(
      "UPDATE tasks SET status='completed',result=$2,updated_at=now() WHERE id=$1 AND status='running' RETURNING objective_id",
      [
        taskId,
        JSON.stringify({
          summary: outcome.summary,
          objective: outcome.end
            ? { status: "progress", end: outcome.end }
            : { status: outcome.achieved ? "achieved" : "progress" },
        }),
      ]
    )
  else if (outcome.status === "failed")
    ended = await pool.query(
      "UPDATE tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='running' RETURNING objective_id",
      [taskId, outcome.error.slice(0, 4000)]
    )
  else
    ended = await pool.query(
      "UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND status='running' RETURNING objective_id",
      [taskId]
    )
  const terminal =
    ended.rows[0] ??
    (
      await pool.query<{ objective_id: string }>(
        "SELECT objective_id FROM tasks WHERE id=$1 AND status IN ('completed','failed','cancelled')",
        [taskId]
      )
    ).rows[0]
  if (terminal)
    await updateImprovement(terminal.objective_id, (item) => {
      const candidate = item.candidates.find((entry) => entry.taskId === taskId)
      if (!candidate || candidate.phase === "done") return
      candidate.phase = "done"
      candidate.claim ??=
        outcome.status === "completed"
          ? outcome.summary
          : outcome.status === "cancelled"
            ? "本轮已停止。"
            : "本轮因运行错误中断，可在任务记录查看原因。"
    })
}

async function cancelled(objectiveId: string, taskId: string) {
  const {
    rows: [row],
  } = await pool.query<{ status: string; cancel: Date | null }>(
    `SELECT o.status,t.cancel_requested_at AS cancel FROM objectives o, tasks t WHERE o.id=$1 AND t.id=$2`,
    [objectiveId, taskId]
  )
  return !row || row.status === "stopped" || !!row.cancel
}

function failureBrief(evaluation: Evaluation) {
  return [
    ...evaluation.stages
      .filter((stage) => stage.status === "fail")
      .map((stage) => `【${stage.name} 没通过】\n${stage.detail.slice(0, 3000)}`),
    ...evaluation.acceptance
      .filter((item) => item.status === "fail")
      .map((item) => `【验收没通过】${item.item}：${item.note}`),
  ].join("\n\n")
}

export function reformerBrief(
  improvement: Improvement,
  candidate: Candidate,
  previous?: Candidate
) {
  return [
    `The owner asked for this improvement (in their words):\n${improvement.request}`,
    improvement.checklist.length
      ? `Acceptance checklist (an independent reviewer will check each item on the running app):\n${improvement.checklist.map((item, i) => `${i + 1}. ${item}`).join("\n")}`
      : "",
    previous?.evaluation && !previous.evaluation.passed
      ? `The previous candidate (round ${previous.roundNo}) is already applied in your copy, but it failed evaluation. Fix these problems:\n${failureBrief(previous.evaluation)}`
      : previous
        ? `The previous candidate (round ${previous.roundNo}) is already applied in your copy.`
        : "",
    previous?.claim
      ? `Previous round's working notes (verify these against the code; they are not evaluation results):\n${previous.claim}`
      : "",
    candidate.feedback ? `New information for this round:\n${candidate.feedback}` : "",
    "Work in the project at the current directory. Find the feature's entry points, implement the smallest complete change, add a focused test, format changed files, run typecheck, and call finish. Continue from the previous working notes instead of repeating its exploration.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

async function rulesExcerpt(commit: string) {
  const text = await git(["show", `${commit}:AGENTS.md`])
    .then((value) => value.toString("utf8"))
    .catch(() => "")
  const start = text.indexOf("# 行为规则")
  return start >= 0
    ? text
        .slice(start)
        .split(/\n## 20\d{2}-/)[0]
        .slice(0, 3000)
    : ""
}

async function runRound(objectiveId: string, roundNo: number, taskId: string) {
  const log = (line: string) => void logLine(objectiveId, roundNo, line).catch(() => {})
  const objective = async () => {
    const [row] = await db.select().from(objectives).where(eq(objectives.id, objectiveId))
    return row
  }
  try {
    let improvement = (await readImprovement(objectiveId))!
    const current = await objective()
    const [agent] = await db.select().from(agents).where(eq(agents.id, current.agentId))
    const spec = await resolveModelSpec(agent?.model)
    if (!spec) throw new Error("没有可用的模型")
    const trusted = improvement.merge?.official ?? (await trustedCommit(improvement))
    let candidate = improvement.candidates.find((item) => item.roundNo === roundNo)
    if (!candidate) {
      improvement = await updateImprovement(objectiveId, (value) => {
        const previous = value.candidates.filter((item) => item.commit).at(-1)
        const resumeEvaluation = previous?.evaluationBlocked && !value.feedback
        value.candidates.push({
          roundNo,
          branch: `cand/${shortId(objectiveId)}-${roundNo}`,
          parent:
            previous?.files?.length === 0
              ? value.baseCommit
              : (previous?.commit ?? value.fork?.commit ?? value.baseCommit),
          taskId,
          phase: resumeEvaluation ? "evaluating" : "reforming",
          ...(resumeEvaluation
            ? {
                commit: previous.commit,
                claim: previous.claim,
                files: previous.files,
                development: previous.development,
              }
            : {}),
          feedback: value.feedback,
        })
        value.feedback = undefined
        value.status = "working"
      })
      candidate = improvement.candidates.at(-1)!
    }
    const previous = improvement.candidates
      .filter((item) => item.roundNo < roundNo && item.commit)
      .at(-1)
    log(`round ${roundNo} phase ${candidate.phase} (trusted ${trusted.slice(0, 12)})`)
    const labImage = await ensureLabImage(trusted, (line) => log(`lab image: ${line}`))
    const key = roundKey(objectiveId, roundNo)
    if (candidate.phase === "reforming" && improvement.merge && !previous) {
      const offer = improvement.merge,
        receipts: import("./rebase").ReplayReceipt[] = []
      const result = offer.discard
        ? offer.official
        : await replayPatches({
            repo: repoDir(),
            base: offer.base,
            local: offer.local,
            official: offer.official,
            resolve: async (patch, conflicts, onto) =>
              resolveInLab({
                patch,
                onto,
                conflicts,
                taskId,
                objective: {
                  ...current,
                  objective: offer.requests.map((r) => r.request).join("\n"),
                },
                key,
                labImage,
                spec,
                rules: await rulesExcerpt(trusted),
                cancelled: () => cancelled(objectiveId, taskId),
                log,
              }),
            save: async (receipt) => {
              receipts.push(receipt)
              log(`rebase ${receipt.patch.slice(0, 12)}: ${receipt.outcome}`)
            },
          })
      if (await cancelled(objectiveId, taskId))
        return finishTask(taskId, { status: "cancelled" })
      await git(["update-ref", `refs/heads/${candidate.branch}`, result])
      const files = await changedFiles(offer.official, result)
      improvement = await updateImprovement(objectiveId, (value) => {
        value.replay = receipts
        const c = value.candidates.find((c) => c.roundNo === roundNo)!
        c.commit = result
        c.parent = offer.official
        c.claim = offer.discard
          ? "按主人选择试用原版官方源码，本地需求和版本均已保留。"
          : `已合并官方 ${offer.revision.slice(0, 12)}，${receipts.filter((r) => r.outcome === "upstream").length} 个补丁已由官方取代。`
        c.files = files
        c.phase = "evaluating"
      })
      candidate = improvement.candidates.find((c) => c.roundNo === roundNo)!
    }
    if (candidate.phase === "reforming") {
      const journal = await reformerJournal(taskId, candidate.parent)
      const lab = await startLab(labImage, key)
      const preview = developmentPreview(labImage)
      let preserve = false
      try {
        const result = await runReformer({
          objective: current,
          taskId,
          spec,
          lab,
          preview,
          cancelled: () => cancelled(objectiveId, taskId),
          brief: reformerBrief(improvement, candidate, previous),
          rules: await rulesExcerpt(trusted),
          parent: candidate.parent,
          journal,
          restore: (commit) => loadCommit(lab, commit),
          capture: (previous) => captureLabCommit(lab, previous, taskId),
          log,
        })
        if (await cancelled(objectiveId, taskId))
          return finishTask(taskId, { status: "cancelled" })
        const tree = await mkdtemp(path.join(os.tmpdir(), "owndesk-cand-tree-"))
        try {
          await exportTree(lab, tree)
          const commit = await commitTree(
            tree,
            candidate.parent,
            candidate.branch,
            `Improvement ${objectiveId} round ${roundNo}\n\n${result.summary}`
          )
          const treeId = await gitText(["rev-parse", `${commit}^{tree}`])
          const files = await changedFiles(improvement.baseCommit, commit)
          improvement = await updateImprovement(objectiveId, (value) => {
            const item = value.candidates.find((entry) => entry.roundNo === roundNo)!
            item.commit = commit
            item.development = { tree: treeId, checks: result.checks ?? [] }
            item.claim = result.summary
            item.files = files.map((file) => ({
              path: file.path,
              added: file.added,
              removed: file.removed,
              status: file.status,
            }))
            item.phase = result.finished ? "evaluating" : "done"
          })
          candidate = improvement.candidates.find((item) => item.roundNo === roundNo)!
          log(`candidate committed ${commit.slice(0, 12)} (${files.length} files)`)
          if (!result.finished)
            return finishTask(taskId, {
              status: "completed",
              achieved: false,
              end: result.end ?? "steps",
              summary: `${result.summary}；修改已保存在候选副本，后续轮次会继续。`,
            })
        } finally {
          await rm(tree, { recursive: true, force: true })
        }
      } catch (error) {
        const reason = journal.interrupted(error)
        preserve = reason instanceof UnknownLabTurn
        throw reason
      } finally {
        try {
          await preview.close()
        } finally {
          if (preserve) await docker(["stop", lab.name]).catch(() => undefined)
          else await stopLab(lab)
        }
      }
    }
    if (candidate.phase === "evaluating") {
      await git(["update-ref", `refs/heads/${candidate.branch}`, candidate.commit!])
      let blockedReason: LabBudgetError | undefined
      const { evaluation, images } = await evaluate({
        key,
        baseCommit: improvement.baseCommit,
        trustedCommit: trusted,
        commit: candidate.commit!,
        labImage,
        checklist:
          improvement.merge && !improvement.merge.discard
            ? [...new Set(improvement.merge.requests.flatMap((r) => r.checklist))]
            : improvement.checklist,
        request:
          improvement.merge && !improvement.merge.discard
            ? improvement.merge.requests.map((r) => r.request).join("\n")
            : improvement.request,
        officialRevision:
          improvement.merge?.official === candidate.commit
            ? improvement.merge?.revision
            : undefined,
        officialOnly:
          !!improvement.merge && candidate.commit === improvement.merge.official,
        objective,
        taskId,
        spec,
        onBlocked: async (reason, end) => {
          blockedReason = new LabBudgetError(reason, end)
          log(`gateway refused: ${reason}`)
        },
        log,
      })
      let versionId: string | undefined
      if (evaluation.passed && images)
        versionId = await registerCandidate(improvement, candidate, images)
      improvement = await updateImprovement(objectiveId, (value) => {
        const item = value.candidates.find((entry) => entry.roundNo === roundNo)!
        item.evaluation = evaluation
        item.evaluationBlocked = blockedReason?.end
        item.images = images
        item.versionId = versionId
        item.phase = "done"
        value.status = evaluation.passed ? "ready" : "working"
      })
      candidate = improvement.candidates.find((item) => item.roundNo === roundNo)!
      log(`evaluation ${evaluation.passed ? "PASSED" : "failed"}`)
      if (blockedReason) {
        await postReport(improvement, candidate)
        throw blockedReason
      }
    }
    if (await cancelled(objectiveId, taskId))
      return finishTask(taskId, { status: "cancelled" })
    const evaluation = candidate.evaluation!
    await postReport(improvement, candidate)
    await finishTask(taskId, {
      status: "completed",
      achieved: evaluation.passed,
      summary: evaluation.passed
        ? `实验室：第 ${roundNo} 版全部通过，报告已经准备好。`
        : `实验室：第 ${roundNo} 版没通过（${evaluation.stages
            .filter((stage) => stage.status === "fail")
            .map((stage): string => stage.name)
            .concat(
              evaluation.acceptance.some((item) => item.status === "fail")
                ? ["验收清单"]
                : []
            )
            .join("、")}），接着改下一版。`,
    })
  } catch (error) {
    if (error instanceof UnknownLabTurn)
      await pool.query(
        "UPDATE objectives SET status='paused',status_reason=$2,updated_at=now() WHERE id=$1 AND status='active'",
        [objectiveId, error.message]
      )
    log(`round error: ${error instanceof Error ? error.stack : String(error)}`)
    if (error instanceof LabBudgetError)
      return finishTask(taskId, {
        status: "completed",
        achieved: false,
        end: error.end,
        summary: `实验室停在上限：${error.message}`,
      })
    if (await cancelled(objectiveId, taskId).catch(() => false))
      return finishTask(taskId, { status: "cancelled" })
    await finishTask(taskId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function registerCandidate(
  improvement: Improvement,
  candidate: Candidate,
  images: { web: string; worker: string }
) {
  const id = async (ref: string) =>
    (await docker(["image", "inspect", "--format", "{{.Id}}", ref])).stdout
      .toString()
      .trim()
  const {
    rows: [{ n }],
  } = await pool.query<{ n: number }>(
    "SELECT count(*)::int + 1 AS n FROM agent_versions WHERE kind='local'"
  )
  const official =
    improvement.merge?.official === candidate.commit ? improvement.merge : null
  const [row] = await db
    .insert(agentVersions)
    .values({
      label: official ? `官方 ${official.revision.slice(0, 7)}` : `local-${n}`,
      kind: official ? "upstream" : "local",
      parentId: improvement.baseVersionId,
      sourceRevision: official?.revision ?? candidate.commit!,
      gitCommit: candidate.commit!,
      webImageId: await id(images.web),
      workerImageId: await id(images.worker),
      images,
      status: "ready",
      summary: `${improvement.title}：${candidate.claim ?? ""}`.slice(0, 2000),
    })
    .onConflictDoUpdate({
      target: [agentVersions.webImageId, agentVersions.workerImageId],
      set: { status: "ready", images },
    })
    .returning({ id: agentVersions.id })
  await git([
    "tag",
    "-f",
    `local-candidate-${shortId(improvement.objectiveId)}-${candidate.roundNo}`,
    candidate.commit!,
  ])
  return row.id
}

async function postReport(improvement: Improvement, candidate: Candidate) {
  const { rowCount } = await pool.query("SELECT 1 FROM companions WHERE agent_id=$1", [
    improvement.agentId,
  ])
  if (!rowCount) return
  const evaluation = candidate.evaluation!
  await db.insert(companionMessages).values({
    agentId: improvement.agentId,
    role: "assistant",
    kind: "improvement_report",
    content: improvement.title,
    channel: "web",
    metadata: {
      objectiveId: improvement.objectiveId,
      roundNo: candidate.roundNo,
      versionId: candidate.versionId,
      summary: candidate.claim,
      passed: evaluation.passed,
      stages: evaluation.stages.map((stage) => ({
        name: stage.name,
        status: stage.status,
        counts: stage.counts,
      })),
      acceptance: evaluation.acceptance,
      files: candidate.files,
    },
  })
}
