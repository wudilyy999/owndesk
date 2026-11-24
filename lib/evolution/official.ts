// Fetch only the canonical project's main. Model input, branch names and remote URLs are
// never accepted here. The owner reviews the exact official revision before opening a goal.
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { git, gitText, resolveCommit } from "./repo"
import { listImprovements, type Improvement } from "./store"
export type OfficialOffer = {
  discard?: true
  fromId: string
  local: string
  base: string
  previousRevision: string
  official: string
  revision: string
  agentId: string
  requests: { objectiveId: string; request: string; checklist: string[] }[]
}
const key = "evolution.official-offer"
export async function readOffer() {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key=$1",
    [key]
  )
  return rows[0] ? (JSON.parse(rows[0].value) as OfficialOffer) : null
}
export async function discoverOfficial(ownerId: string) {
  const { rows: versions } = await pool.query<{
    id: string
    kind: string
    status: string
    parent_id: string | null
    git_commit: string | null
    source_revision: string
  }>("SELECT id,kind,status,parent_id,git_commit,source_revision FROM agent_versions")
  const active = versions.find((v) => v.status === "active")
  if (active?.kind !== "local") throw new HttpError(409, "当前没有正在使用的本地改进")
  const improvements = await listImprovements(ownerId),
    requests: Improvement[] = []
  let current: typeof active | undefined = active
  const seen = new Set<string>()
  let base = "",
    previousRevision = ""
  while (current) {
    if (seen.has(current.id)) throw new Error("Version lineage contains a cycle")
    seen.add(current.id)
    if (current.kind === "upstream") {
      base = current.git_commit ?? ""
      previousRevision = current.source_revision
      break
    }
    const id = current.id
    const source = improvements.find((i) => i.candidates.some((c) => c.versionId === id))
    if (!source) throw new HttpError(409, "找不到本地版本的来源和验收要求")
    requests.unshift(source)
    if (source.merge) {
      base = source.merge.official
      previousRevision = source.merge.revision
      break
    }
    current = versions.find((v) => v.id === current?.parent_id)
  }
  if (
    ![base, previousRevision, active.source_revision].every((s) =>
      /^[a-f0-9]{40}$/.test(s)
    ) ||
    !requests.length
  )
    throw new HttpError(409, "官方基线或本地改进记录不完整")
  await git(
    [
      "-c",
      "http.lowSpeedLimit=1024",
      "-c",
      "http.lowSpeedTime=30",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "https://github.com/wudilyy999/owndesk.git",
      "refs/heads/main:refs/owndesk/official-main",
    ],
    { GIT_TERMINAL_PROMPT: "0" }
  )
  const revision = await resolveCommit("refs/owndesk/official-main")
  if (revision === previousRevision) throw new HttpError(409, "已基于当前官方版本")
  await git(["merge-base", "--is-ancestor", previousRevision, revision])
  await git(["merge-base", "--is-ancestor", base, active.source_revision])
  if (
    (await gitText(["rev-parse", `${base}^{tree}`])) !==
    (await gitText(["rev-parse", `${previousRevision}^{tree}`]))
  )
    throw new HttpError(409, "安装的源码与官方基线树不同，无法自动合并")
  const ref = `refs/owndesk/official/${base}/${revision}`
  let official = await resolveCommit(ref)
  if (!official) {
    const tree = await gitText(["rev-parse", `${revision}^{tree}`])
    const made = await gitText([
      "-c",
      "user.name=OwnDesk",
      "-c",
      "user.email=versions@owndesk.local",
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      revision,
      "-m",
      `Official source ${revision}`,
    ])
    await git(["update-ref", ref, made, "0".repeat(40)]).catch(() => {})
    official = await resolveCommit(ref)
    if (!official) throw new Error("Could not retain official source")
  }
  const requirements = requests.flatMap(
    (i) =>
      i.merge?.requests ?? [
        { objectiveId: i.objectiveId, request: i.request, checklist: i.checklist },
      ]
  )
  const offer: OfficialOffer = {
    fromId: active.id,
    base,
    local: active.source_revision,
    previousRevision,
    official,
    revision,
    agentId: requests.at(-1)!.agentId,
    requests: requirements,
  }
  await pool.query(
    "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [key, JSON.stringify(offer)]
  )
  return offer
}
