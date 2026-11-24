// B0 version base: which web+worker image pair is running, which are kept for
// one-click rollback, and the switch history. Switching itself is done by
// scripts/updater.mjs in a container started from the current (trusted) image.
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { desc, eq, sql } from "drizzle-orm"
import { db, pool } from "@/db"
import { listImprovements } from "@/lib/evolution/store"
import { agentVersions, deployments } from "@/db/schema"
import { docker } from "@/lib/docker"
import { APPLICATION_VERSION } from "@/lib/durable"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"

const exec = promisify(execFile)
const SOURCE_TAR = process.env.OWNDESK_SOURCE_TAR ?? "/app/source.tar"

export const sourceRevision = () => {
  const value = process.env.OWNDESK_REVISION ?? ""
  return /^[a-f0-9]{7,64}(-dirty)?$/.test(value) ? value : "unknown"
}
export const versionsEnabled = () => !!env.PA_DEPLOY_DIR
const pinTag = (service: "web" | "worker", id: string) =>
  `owndesk-${service}:keep-${id.replace(/^sha256:/, "").slice(0, 12)}`
const versionLabel = (revision: string) =>
  revision === "unknown"
    ? APPLICATION_VERSION
    : `${APPLICATION_VERSION} · ${revision.slice(0, 7)}`

async function inspect(target: string) {
  const [container] = JSON.parse(
    (await docker(["inspect", target], { maxOutputBytes: 400000 })).stdout.toString()
  )
  return container as {
    Image: string
    Config: { Labels: Record<string, string> }
    NetworkSettings: { Networks: Record<string, unknown> }
  }
}

// Commit /app/source.tar onto the `upstream` branch of the local version repository
// (evolution volume), tagged by revision. Idempotent; returns the commit.
export async function importSource(revision = sourceRevision()) {
  if (revision === "unknown" || !existsSync(SOURCE_TAR)) return null
  const repo = path.join(path.resolve(env.EVOLUTION_DIR), "versions.git")
  const git = (args: string[], extra: Record<string, string> = {}) =>
    exec("git", ["-c", "safe.directory=*", "--git-dir", repo, ...args], {
      env: { ...process.env, ...extra },
      maxBuffer: 16 * 1024 * 1024,
    }).then((result) => result.stdout.trim())
  if (!existsSync(path.join(repo, "HEAD"))) {
    await mkdir(repo, { recursive: true })
    await git(["init", "--bare", "--initial-branch", "upstream"])
  }
  const tag = `refs/tags/upstream-${revision.slice(0, 12)}`
  const existing = await git([
    "rev-parse",
    "--quiet",
    "--verify",
    `${tag}^{commit}`,
  ]).catch(() => "")
  if (existing) return existing
  const scratch = await mkdtemp(path.join(os.tmpdir(), "owndesk-source-"))
  const work = path.join(scratch, "tree")
  try {
    await mkdir(work)
    await exec("tar", ["-xf", SOURCE_TAR, "-C", work])
    // The index lives outside the tree so nothing but the source is committed
    const index = { GIT_INDEX_FILE: path.join(scratch, "index"), GIT_WORK_TREE: work }
    await git(["add", "--all", "--force", "--", "."], index)
    const tree = await git(["write-tree"], index)
    const parent = await git([
      "rev-parse",
      "--quiet",
      "--verify",
      "refs/heads/upstream",
    ]).catch(() => "")
    const identity = {
      GIT_AUTHOR_NAME: "OwnDesk",
      GIT_AUTHOR_EMAIL: "versions@owndesk.local",
      GIT_COMMITTER_NAME: "OwnDesk",
      GIT_COMMITTER_EMAIL: "versions@owndesk.local",
    }
    const commit = await git(
      [
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        `OwnDesk ${APPLICATION_VERSION} (${revision.slice(0, 12)})\n\nSource-Revision: ${revision}`,
      ],
      identity
    )
    await git(["update-ref", "refs/heads/upstream", commit])
    await git(["update-ref", tag, commit])
    return commit
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// At worker start inside a compose deployment: pin the running image pair, record it,
// and import its source. Never blocks the worker; failures are logged.
export async function registerRunningVersion() {
  if (!versionsEnabled()) return null
  const self = await inspect(os.hostname())
  const project = self.Config.Labels["com.docker.compose.project"]
  const web = (
    await docker([
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=web",
    ])
  ).stdout
    .toString()
    .trim()
    .split("\n")[0]
  if (!project || !web) return null
  const webId = (await inspect(web)).Image
  const workerId = self.Image
  const images = { web: pinTag("web", webId), worker: pinTag("worker", workerId) }
  await docker(["tag", webId, images.web])
  await docker(["tag", workerId, images.worker])
  const revision = sourceRevision()
  const [known] = await db
    .select({ kind: agentVersions.kind, revision: agentVersions.sourceRevision })
    .from(agentVersions)
    .where(
      sql`${agentVersions.webImageId}=${webId} AND ${agentVersions.workerImageId}=${workerId}`
    )
  // A local candidate is already archived on cand/*. Starting it must never advance upstream.
  const gitCommit =
    known?.kind === "local"
      ? known.revision
      : await importSource(revision).catch((error) => {
          console.error("Version source import failed", error)
          return null
        })
  const [row] = await db
    .insert(agentVersions)
    .values({
      label: versionLabel(revision),
      sourceRevision: revision,
      gitCommit,
      webImageId: webId,
      workerImageId: workerId,
      images,
      status: "retained",
    })
    .onConflictDoUpdate({
      target: [agentVersions.webImageId, agentVersions.workerImageId],
      set: {
        label: sql`CASE WHEN ${agentVersions.kind}='local' THEN ${agentVersions.label} ELSE EXCLUDED.label END`,
        sourceRevision: sql`CASE WHEN ${agentVersions.kind}='local' THEN ${agentVersions.sourceRevision} ELSE EXCLUDED.source_revision END`,
        gitCommit: sql`COALESCE(${gitCommit}, ${agentVersions.gitCommit})`,
        images,
      },
    })
    .returning()
  // A fresh install (no updater run yet): the running pair is the active version
  await db.execute(
    sql`UPDATE agent_versions SET status='active', promoted_at=COALESCE(promoted_at, now())
        WHERE id=${row.id} AND NOT EXISTS (SELECT 1 FROM agent_versions WHERE status='active')
        AND NOT EXISTS (SELECT 1 FROM deployments WHERE status='running')`
  )
  return row
}

export async function listVersions(ownerId: string) {
  const improvements = await listImprovements(ownerId)
  const ids = improvements.flatMap((x) => x.candidates.map((c) => c.taskId))
  const { rows: costs } = await pool.query<{
    task_id: string
    known: string
    unknown: number
  }>(
    `SELECT a.task_id, COALESCE(sum(COALESCE(a.cost_micros,a.reconciled_cost_micros)),0)::text AS known, count(*) FILTER(WHERE a.cost_micros IS NULL AND a.reconciled_cost_micros IS NULL)::int AS unknown FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=$1 AND a.task_id=ANY($2) GROUP BY a.task_id`,
    [ownerId, ids]
  )
  const spend = new Map(costs.map((c) => [c.task_id, c]))
  const versions = await db
    .select()
    .from(agentVersions)
    .orderBy(desc(sql`COALESCE(${agentVersions.promotedAt}, ${agentVersions.createdAt})`))
  const history = await db
    .select()
    .from(deployments)
    .orderBy(desc(deployments.startedAt))
    .limit(30)
  return {
    enabled: versionsEnabled(),
    officialOffer: await (await import("@/lib/evolution/official")).readOffer(),
    lineage: improvements.flatMap((item) =>
      item.candidates.map((c) => ({
        objectiveId: item.objectiveId,
        title: item.title,
        request: item.request,
        roundNo: c.roundNo,
        parent: c.parent,
        commit: c.commit,
        versionId: c.versionId,
        phase: c.phase,
        abandoned: item.status === "abandoned",
        passed: c.evaluation?.passed,
        checks: c.evaluation?.stages.map((s) => ({ name: s.name, status: s.status })),
        costMicros: spend.get(c.taskId)?.known ?? "0",
        unknownCosts: spend.get(c.taskId)?.unknown ?? 0,
      }))
    ),
    versions: versions.map((version) => ({
      id: version.id,
      label: version.label,
      kind: version.kind,
      parentId: version.parentId,
      sourceRevision: version.sourceRevision,
      gitCommit: version.gitCommit,
      status: version.status,
      summary: version.summary,
      createdAt: version.createdAt,
      promotedAt: version.promotedAt,
    })),
    deployments: history.map((item) => ({
      id: item.id,
      fromVersionId: item.fromVersionId,
      toVersionId: item.toVersionId,
      action: item.action,
      status: item.status,
      phase: item.phase,
      reason: item.reason,
      lastCheck: item.healthLog.at(-1) ?? null,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
  }
}
export type VersionsOverview = Awaited<ReturnType<typeof listVersions>>

// One-click rollback (or forward again) to a kept version, or adoption of an improvement
// candidate that passed every test (B1). Runs in the worker, which starts the updater from
// its own image; returns as soon as the updater is started.
const switchContainer = (id: string) => `pa-${env.INSTALL_ID.slice(0, 8)}-updater-${id}`

export async function switchPending(id: string) {
  const { stdout } = await docker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `name=^/${switchContainer(id)}$`,
  ])
  return !!stdout.toString().trim()
}

export async function requestSwitch(
  versionId: string,
  action: "rollback" | "promote" = "rollback",
  expectedFrom?: string
) {
  if (!versionsEnabled())
    throw new HttpError(409, "版本切换只在 Docker 部署（scripts/install.sh）里可用")
  const [target] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, versionId))
  if (!target || target.status !== (action === "promote" ? "ready" : "retained"))
    throw new HttpError(
      409,
      action === "promote" ? "只能采用全部测试都通过的版本" : "只能切换到保留着的版本"
    )
  const [running] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.status, "running"))
  if (running) throw new HttpError(409, "已经有一次切换在进行")
  const self = await inspect(os.hostname())
  const network = Object.keys(self.NetworkSettings.Networks).find((name) =>
    name.endsWith("_control")
  )
  if (!network) throw new HttpError(500, "找不到内部网络")
  const deploy = env.PA_DEPLOY_DIR!
  const deploymentId = randomBytes(9).toString("base64url")
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    switchContainer(deploymentId),
    "--label",
    `owndesk.updater=${env.INSTALL_ID}`,
    "--label",
    "owndesk.updater.role=switch",
    "--network",
    network,
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--volume",
    `${deploy}:${deploy}`,
    self.Image,
    "node",
    "scripts/updater.mjs",
    "start",
    "--deploy",
    deploy,
    "--action",
    action,
    ...(expectedFrom
      ? ["--expected-from", expectedFrom, "--request-id", deploymentId]
      : []),
    "--web",
    target.webImageId,
    "--worker",
    target.workerImageId,
  ])
  return { started: true as const, deploymentId }
}
