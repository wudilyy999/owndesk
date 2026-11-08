import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pool } from "@/db"
import { artifactDir } from "@/lib/env"
import { HttpError } from "@/lib/errors"
import { processImage } from "@/lib/companion/images"

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export type UploadReference = {
  id: string
  name: string
  mediaType: string
  size: number
}
const mediaTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
}

// Read the ZIP directory only; uploaded office files are opened on the workstation.
function officeParts(bytes: Buffer) {
  let end = bytes.length - 22
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    bytes.readUInt32LE(end) !== 0x06054b50
  )
    end--
  if (end < Math.max(0, bytes.length - 65557)) return []
  let at = bytes.readUInt32LE(end + 16)
  const names: string[] = []
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return []
    const length = bytes.readUInt16LE(at + 28)
    if (at + 46 + length > bytes.length) return []
    names.push(bytes.toString("utf8", at + 46, at + 46 + length))
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  return names
}

export async function saveUpload(
  ownerId: string,
  agentId: string,
  name: string,
  bytes: Buffer
) {
  if (!bytes.length) throw new HttpError(400, "文件为空")
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "文件最大 20 MB")
  if (
    !name ||
    name.length > 180 ||
    /[<>:"|?*\\/\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new HttpError(400, "文件名无效")
  if (!(await pool.query("SELECT 1 FROM agents WHERE id=$1", [agentId])).rowCount)
    throw new HttpError(404, "Agent not found")
  const extension = path.extname(name).toLowerCase()
  let mediaType = mediaTypes[extension]
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)) {
    bytes = (await processImage(bytes)).data
    name = path.basename(name, extension) + ".jpg"
    mediaType = "image/jpeg"
  } else if (extension === ".pdf") {
    if (
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      throw new HttpError(415, "PDF 格式无效")
  } else if (extension === ".docx" || extension === ".xlsx") {
    const parts = officeParts(bytes)
    if (
      !parts.includes("[Content_Types].xml") ||
      !parts.includes(extension === ".docx" ? "word/document.xml" : "xl/workbook.xml")
    )
      throw new HttpError(415, "Office 文档格式无效")
  } else if (extension === ".doc" || extension === ".xls") {
    if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new HttpError(415, "Office 文档格式无效")
  } else if (extension === ".csv") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new HttpError(415, "请将 CSV 保存为 UTF-8")
    }
    if (bytes.includes(0)) throw new HttpError(415, "CSV 包含无效字符")
  } else throw new HttpError(415, "支持 PDF、Word、Excel、CSV 和图片")
  const id = randomUUID(),
    storagePath = `uploads/${id}/${name}`,
    file = path.join(artifactDir, storagePath)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 })
  try {
    await pool.query(
      "INSERT INTO task_uploads(id,owner_id,agent_id,name,media_type,size,storage_path,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())",
      [id, ownerId, agentId, name, mediaType, bytes.length, storagePath]
    )
  } catch (error) {
    await unlink(file)
    throw error
  }
  return { id, name, mediaType, size: bytes.length } satisfies UploadReference
}

export async function ownedUploads(
  ownerId: string,
  agentId: string,
  ids: string[]
): Promise<UploadReference[]> {
  const unique = [...new Set(ids)]
  if (!unique.length) return []
  const { rows } = await pool.query<UploadReference>(
    'SELECT id,name,media_type AS "mediaType",size FROM task_uploads WHERE owner_id=$1 AND agent_id=$2 AND id=ANY($3::text[])',
    [ownerId, agentId, unique]
  )
  if (rows.length !== unique.length)
    throw new HttpError(404, "附件不存在或属于其他 Agent")
  return unique.map((id) => rows.find((row) => row.id === id)!)
}

export async function readUpload(ownerId: string, id: string) {
  const {
    rows: [row],
  } = await pool.query<UploadReference & { storagePath: string; agentId: string }>(
    'SELECT id,name,media_type AS "mediaType",size,storage_path AS "storagePath",agent_id AS "agentId" FROM task_uploads WHERE id=$1 AND owner_id=$2',
    [id, ownerId]
  )
  if (!row) throw new HttpError(404, "附件不存在")
  const file = path.resolve(artifactDir, row.storagePath)
  if (!file.startsWith(artifactDir + path.sep))
    throw new Error("Upload path escapes storage")
  return { ...row, file, bytes: await readFile(file) }
}
