// B0 version base: which web+worker image pair is running, which are kept for
// one-click rollback, and the switch history. Switching itself is done by
// scripts/updater.mjs in a container started from the current (trusted) image.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { desc, eq, sql } from "drizzle-orm"
import { db } from "@/db"
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
  const work = await mkdtemp(path.join(os.tmpdir(), "owndesk-source-"))
  try {
    await exec("tar", ["-xf", SOURCE_TAR, "-C", work])
    const index = { GIT_INDEX_FILE: path.join(work, ".git-index"), GIT_WORK_TREE: work }
    await git(["add", "--all", "--force", "--", ".", ":!.git-index"], index)
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
    await rm(work, { recursive: true, force: true })
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
  const gitCommit = await importSource(revision).catch((error) => {
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
        label: versionLabel(revision),
        sourceRevision: revision,
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

export async function listVersions() {
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
    versions: versions.map((version) => ({
      id: version.id,
      label: version.label,
      kind: version.kind,
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

// One-click rollback (or forward again) to a kept version. Runs in the worker, which
// starts the updater from its own image; returns as soon as the updater is started.
export async function requestSwitch(versionId: string) {
  if (!versionsEnabled())
    throw new HttpError(409, "版本切换只在 Docker 部署（scripts/install.sh）里可用")
  const [target] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, versionId))
  if (!target || target.status !== "retained")
    throw new HttpError(409, "只能切换到保留着的版本")
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
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    `pa-${env.INSTALL_ID.slice(0, 8)}-updater-${Date.now()}`,
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
    "rollback",
    "--web",
    target.images.web,
    "--worker",
    target.images.worker,
  ])
  return { started: true }
}
