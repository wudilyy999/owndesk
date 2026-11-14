// The local version repository (evolution volume, created by B0): candidate branches
// cand/<objective>-<n> hold every candidate, rejected ones included, as an archive.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { env } from "@/lib/env"
import type { ChangedFile } from "@/lib/evolution/policy"

const exec = promisify(execFile)

export const evolutionDir = () => path.resolve(env.EVOLUTION_DIR)
export const repoDir = () => path.join(evolutionDir(), "versions.git")

const identity = {
  GIT_AUTHOR_NAME: "OwnDesk Lab",
  GIT_AUTHOR_EMAIL: "lab@owndesk.local",
  GIT_COMMITTER_NAME: "OwnDesk Lab",
  GIT_COMMITTER_EMAIL: "lab@owndesk.local",
}

export async function git(
  args: string[],
  extra: Record<string, string> = {},
  maxBuffer = 64 * 1024 * 1024
) {
  const result = await exec(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-c",
      "core.quotepath=off",
      "--git-dir",
      repoDir(),
      ...args,
    ],
    { env: { ...process.env, ...extra }, maxBuffer, encoding: "buffer" }
  )
  return result.stdout as Buffer
}
export const gitText = async (args: string[], extra: Record<string, string> = {}) =>
  (await git(args, extra)).toString("utf8").trim()

export async function resolveCommit(ref: string) {
  return gitText(["rev-parse", "--quiet", "--verify", `${ref}^{commit}`]).catch(() => "")
}

// The source tree of a commit, as a tar stream (no .git)
export async function archive(commit: string) {
  return git(["archive", "--format=tar", commit])
}

export async function extract(commit: string, target: string) {
  await mkdir(target, { recursive: true })
  const tar = await archive(commit)
  await new Promise<void>((resolve, reject) => {
    const child = execFile("tar", ["-xf", "-", "-C", target], (error) =>
      error ? reject(error) : resolve()
    )
    child.stdin!.end(tar)
  })
}

// Commit a directory tree on top of `parent` and point `branch` at it
export async function commitTree(
  tree: string,
  parent: string,
  branch: string,
  message: string
) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "owndesk-cand-"))
  try {
    const index = { GIT_INDEX_FILE: path.join(scratch, "index"), GIT_WORK_TREE: tree }
    await git(["add", "--all", "--force", "--", "."], index)
    const treeId = await gitText(["write-tree"], index)
    const commit = await gitText(
      ["commit-tree", treeId, "-p", parent, "-m", message],
      identity
    )
    await git(["update-ref", `refs/heads/${branch}`, commit])
    return commit
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function changedFiles(base: string, head: string): Promise<ChangedFile[]> {
  const numstat = (await gitText(["diff", "--numstat", "-M", "-z", base, head])).split(
    "\0"
  )
  const statuses = (
    await gitText(["diff", "--name-status", "-M", "-z", base, head])
  ).split("\0")
  const byPath = new Map<string, ChangedFile>()
  for (let i = 0; i < statuses.length;) {
    const code = statuses[i++]
    if (!code) continue
    if (code.startsWith("R")) {
      const from = statuses[i++]
      const to = statuses[i++]
      byPath.set(to, { path: to, from, status: "R", added: 0, removed: 0 })
    } else {
      const file = statuses[i++]
      const status = (code[0] === "A" || code[0] === "D" ? code[0] : "M") as
        "A" | "D" | "M"
      byPath.set(file, { path: file, status, added: 0, removed: 0 })
    }
  }
  for (let i = 0; i < numstat.length;) {
    const head = numstat[i++]
    if (!head) continue
    const [added, removed, name] = head.split("\t")
    const file = name === "" ? (i++, numstat[i++]) : name
    const entry = byPath.get(file)
    if (!entry) continue
    entry.binary = added === "-"
    entry.added = added === "-" ? 0 : Number(added)
    entry.removed = removed === "-" ? 0 : Number(removed)
  }
  return [...byPath.values()]
}

export async function patch(base: string, head: string, context = 3) {
  return (await git(["diff", `-U${context}`, "--no-color", "-M", base, head])).toString(
    "utf8"
  )
}

export function repoReady() {
  return existsSync(path.join(repoDir(), "HEAD"))
}
