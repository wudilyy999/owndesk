// Replay local patch commits one at a time to keep a receipt even when upstream already
// contains a patch. Only Git sees this working directory; the conflict resolver gets text.
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { checkChanges } from "./policy"

const exec = promisify(execFile)
export type Conflict = { path: string; text: string }
export type ReplayReceipt = {
  patch: string
  onto: string
  result: string
  outcome: "upstream" | "replayed" | "resolved" | "rerere"
}
export async function replayPatches(input: {
  repo: string
  base: string
  local: string
  official: string
  resolve: (patch: string, files: Conflict[], onto: string) => Promise<Conflict[]>
  save: (receipt: ReplayReceipt) => Promise<void>
}) {
  for (const sha of [input.base, input.local, input.official])
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected an exact Git commit")
  const tmp = await mkdtemp(path.join(os.tmpdir(), "owndesk-rebase-"))
  const wt = path.join(tmp, "work")
  const git = async (work: boolean, args: string[]) =>
    (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "--literal-pathspecs",
          "-c",
          "rerere.enabled=true",
          "-c",
          "rerere.autoupdate=true",
          "-c",
          "user.name=OwnDesk",
          "-c",
          "user.email=versions@owndesk.local",
          "-c",
          "commit.gpgSign=false",
          ...(work ? ["-C", wt] : ["--git-dir", input.repo]),
          ...args,
        ],
        {
          env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 16 * 1024 * 1024,
        }
      )
    ).stdout
  let onto = input.official
  let attached = false
  try {
    await git(false, ["merge-base", "--is-ancestor", input.base, input.local])
    await git(false, ["merge-base", "--is-ancestor", input.base, input.official])
    const list = (
      await git(false, [
        "rev-list",
        "--reverse",
        "--first-parent",
        `${input.base}..${input.local}`,
      ])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    await git(false, ["worktree", "add", "--detach", wt, onto])
    attached = true
    let previous = input.base
    for (const patch of list) {
      if ((await git(false, ["show", "-s", "--format=%P", patch])).trim() !== previous)
        throw new Error("Local improvement history must be linear")
      let outcome: ReplayReceipt["outcome"] = "replayed"
      try {
        await git(true, [
          "rebase",
          "--merge",
          "--no-autosquash",
          "--reapply-cherry-picks",
          "--empty=drop",
          "--onto",
          onto,
          previous,
          patch,
        ])
      } catch (error) {
        const interrupted = (
          await git(true, ["rev-parse", "--verify", "REBASE_HEAD"]).catch(() => "")
        ).trim()
        if (interrupted !== patch) throw error
        const names = (await git(true, ["diff", "--name-only", "--diff-filter=U", "-z"]))
          .split("\0")
          .filter(Boolean)
        if (names.length) {
          const files: Conflict[] = []
          for (const name of names) {
            if (
              /[\\\x00-\x1f]/.test(name) ||
              name.split("/").some((c) => !c || c === ".." || c === ".")
            )
              throw new Error("Unsupported conflict path")
            const modes = (await git(true, ["ls-files", "-u", "--", name]))
              .trim()
              .split("\n")
            if (
              modes.length !== 3 ||
              modes.some((line) => !line.startsWith("100644 ")) ||
              checkChanges([{ path: name, status: "M", added: 1, removed: 1 }]).length
            )
              throw new Error(`Conflict requires manual review: ${name}`)
            const bytes = await readFile(path.join(wt, name))
            if (bytes.length > 512 * 1024 || bytes.includes(0))
              throw new Error(`Not a supported text conflict: ${name}`)
            files.push({
              path: name,
              text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            })
          }
          const answers = await input.resolve(patch, files, onto)
          if (
            answers.length !== names.length ||
            new Set(answers.map((f) => f.path)).size !== names.length
          )
            throw new Error("Incomplete conflict resolution")
          for (const answer of answers) {
            if (
              !names.includes(answer.path) ||
              Buffer.byteLength(answer.text) > 512 * 1024 ||
              /^(?:<{7}|={7}|>{7})(?: |$)/m.test(answer.text)
            )
              throw new Error("Invalid conflict resolution")
            await writeFile(path.join(wt, answer.path), answer.text)
          }
          await git(true, ["rerere"])
          await git(true, ["add", "--", ...names])
          outcome = "resolved"
        } else outcome = "rerere"
        const identical =
          (await git(true, ["write-tree"])).trim() ===
          (await git(true, ["rev-parse", `${onto}^{tree}`])).trim()
        await git(true, ["rebase", identical ? "--skip" : "--continue"])
      }
      const result = (await git(true, ["rev-parse", "HEAD"])).trim()
      if (result === onto) outcome = "upstream"
      else if ((await git(true, ["show", "-s", "--format=%P", result])).trim() !== onto)
        throw new Error("Unexpected rebased parent")
      await input.save({ patch, onto, result, outcome })
      previous = patch
      onto = result
    }
    return onto
  } finally {
    if (attached) await git(false, ["worktree", "remove", "--force", wt])
    await rm(tmp, { force: true, recursive: true })
  }
}
