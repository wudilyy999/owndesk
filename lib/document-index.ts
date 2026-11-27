import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pool } from "@/db"
import { artifactDir } from "@/lib/env"

const supported = /\.(pdf|docx|xlsx|csv|txt|md|srt|vtt)$/i
export function documentText(name: string, bytes: Buffer): Promise<string> {
  const ext = supported.exec(name)?.[1].toLowerCase()
  if (!ext) return Promise.resolve("")
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "scripts/document-text.py", ext],
      {
        timeout: 12000,
        maxBuffer: 1100000,
        windowsHide: true,
        env: {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
      (err, stdout) =>
        err ? reject(new Error("Document extraction failed")) : resolve(stdout.trim())
    )
    child.stdin!.on("error", () => {
      /* execFile reports an early exit. */
    })
    child.stdin!.end(bytes)
  })
}
// Background backfill also indexes pre-upgrade files. Empty text means unsupported or unreadable.
export async function indexDocuments() {
  for (const table of ["artifacts", "task_uploads"] as const) {
    const index = table === "artifacts" ? "library_artifact_text" : "library_upload_text"
    const files = await pool.query<{
      id: string
      name: string
      storage_path: string
      size: number
    }>(
      `SELECT f.id,name,storage_path,size FROM ${table} f LEFT JOIN ${index} x ON x.id=f.id WHERE x.id IS NULL ORDER BY created_at,f.id LIMIT 4`
    )
    for (const row of files.rows) {
      let text = ""
      if (supported.test(row.name) && row.size <= 20 * 1024 * 1024) {
        try {
          const file = await realpath(path.resolve(artifactDir, row.storage_path))
          if (!file.startsWith((await realpath(artifactDir)) + path.sep))
            throw Error("Invalid path")
          const info = await stat(file)
          if (info.isFile() && info.size <= 20 * 1024 * 1024)
            text = await documentText(row.name, await readFile(file))
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error
          console.warn("Library could not index document", { id: row.id })
        }
      }
      await pool.query(
        `WITH indexed AS (INSERT INTO ${index}(id,body) SELECT id,$2 FROM ${table} WHERE id=$1 ON CONFLICT DO NOTHING RETURNING id,body) UPDATE library_project_events e SET body=coalesce(nullif(indexed.body,''),'此文件没有可检索的正文，请查看原件') FROM indexed WHERE e.origin=$3||indexed.id`,
        [
          row.id,
          text,
          table === "artifacts"
            ? "/library?source=artifact&id="
            : "/library?source=upload&id=",
        ]
      )
    }
  }
}
