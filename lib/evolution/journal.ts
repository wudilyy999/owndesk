import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { ModelMessage } from "ai"
import type { ContextCheckpoint } from "@/lib/agent/context"
import { redactSecrets } from "@/lib/redact-secrets"
import { evolutionDir } from "./repo"

export class UnknownLabTurn extends Error {}
export type JournalRole = "reformer" | "reviewer"
type Entry<T> = { messages: ModelMessage[]; state: T; checkpoint?: ContextCheckpoint }
// Receipt files and candidate refs belong to the trusted worker, outside the candidate tree.
// A started turn without its complete receipt is an unknown effect, even if the model reported success.
export async function openLabJournal<T>(
  taskId: string,
  role: JournalRole,
  scope: string,
  secrets: string[] = [],
  root = evolutionDir()
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid lab task ID")
  const dir = path.join(
    root,
    "context-v1",
    taskId,
    role,
    createHash("sha512").update(scope).digest("hex")
  )
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const messages: ModelMessage[] = []
  let last: Entry<T> | undefined
  let turn = 1
  async function read(name: string) {
    try {
      return await readFile(path.join(dir, name), "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  }
  for (; ; turn++) {
    const receipt = await read(`${turn}.json`)
    if (receipt === null) {
      if ((await read(`${turn}.started`)) !== null)
        throw new UnknownLabTurn(
          `实验室第 ${turn} 步没有完整回执，已暂停；请先核对候选和操作记录。`
        )
      if (
        (await readdir(dir)).some(
          (f) => /^\d+\.(started|json)$/.test(f) && Number(f.split(".")[0]) > turn
        )
      )
        throw new UnknownLabTurn("实验室历史缺少中间步骤，已暂停。")
      break
    }
    try {
      last = JSON.parse(receipt) as Entry<T>
      if (
        !Array.isArray(last.messages) ||
        !last.state ||
        (last.checkpoint &&
          (!Number.isSafeInteger(last.checkpoint.through) ||
            typeof last.checkpoint.summary !== "string"))
      )
        throw new Error("invalid")
    } catch {
      throw new UnknownLabTurn(`实验室第 ${turn} 步的回执无法读取，已暂停。`)
    }
    for (const m of last.messages) messages.push(m)
  }
  let started = false
  function clean(s: string) {
    for (const secret of secrets)
      if (secret) s = s.replaceAll(secret, "[removed credential]")
    return redactSecrets(s)
  }
  const persist = (key: string, v: unknown) => {
    if (
      key === "providerOptions" ||
      key === "providerMetadata" ||
      key === "experimental_providerMetadata"
    )
      return undefined
    if (v && typeof v === "object" && "type" in v) {
      if (
        v.type === "image-data" ||
        v.type === "file" ||
        v.type === "image" ||
        v.type === "reasoning" ||
        v.type === "reasoning-file"
      )
        return { type: "text", text: "[historical media or private reasoning omitted]" }
    }
    return typeof v === "string" ? clean(v) : v
  }
  return {
    messages,
    last,
    turn,
    interrupted(error: unknown) {
      if (started)
        return new UnknownLabTurn(
          `实验室第 ${turn} 步结果未确认，已暂停；请先检查候选和回执。`
        )
      return error
    },
    async begin() {
      if (started) throw new UnknownLabTurn("The previous lab turn is missing a receipt")
      const marker = await open(path.join(dir, `${turn}.started`), "wx", 0o600).catch(
        (e) => {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw new UnknownLabTurn("实验室轮次已被认领，不能重放")
          throw e
        }
      )
      started = true
      try {
        await marker.writeFile(String(turn))
        await marker.sync()
      } finally {
        await marker.close()
      }
    },
    async seal(record: Entry<T>) {
      if (!started) throw new Error("Unstarted lab turn")
      const tmp = path.join(dir, `.${randomUUID()}.tmp`),
        file = await open(tmp, "wx", 0o600)
      try {
        try {
          await file.writeFile(JSON.stringify(record, persist))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(tmp, path.join(dir, `${turn}.json`))
        started = false
        turn++
      } finally {
        await rm(tmp, { force: true })
      }
    },
  }
}
