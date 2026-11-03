// Pictures the person sends her. Checked, shrunk and re-encoded on the server (so metadata such as
// GPS and the original bytes are gone), stored privately under the artifact directory, shown to
// the model once, and deleted after RETENTION_DAYS. Afterwards only a one-line description stays.
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { generateText, type LanguageModel } from "ai"
import { and, eq, isNotNull, lt } from "drizzle-orm"
import sharp from "sharp"
import { z } from "zod"
import { db } from "@/db"
import { companionImages, type CompanionImage } from "@/db/schema"
import { artifactDir } from "@/lib/env"
import { HttpError } from "@/lib/errors"

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_SIDE = 1280
export const MAX_PIXELS = 40_000_000
export const RETENTION_DAYS = 30
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const FORMATS = new Set(["jpeg", "png", "webp", "gif"])

export type ProcessedImage = { data: Buffer; width: number; height: number }

// Validates by the file's real content (not its name or declared type), then rotates by EXIF,
// scales the longest side down to MAX_SIDE and writes a plain JPEG
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (!input.length) throw new HttpError(400, "图片是空的")
  if (input.length > MAX_UPLOAD_BYTES)
    throw new HttpError(413, `图片太大了，最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  try {
    const source = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    const meta = await source.metadata()
    if (!meta.format || !FORMATS.has(meta.format))
      throw new HttpError(415, "只支持 JPEG、PNG、WebP、GIF 图片")
    const { data, info } = await source
      .rotate()
      .resize({
        width: MAX_SIDE,
        height: MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(415, "这张图片打不开，可能已损坏或太大")
  }
}

const imageFile = (row: Pick<CompanionImage, "path">) => {
  if (!row.path) return null
  const file = path.resolve(artifactDir, row.path)
  return file.startsWith(`${artifactDir}${path.sep}`) ? file : null
}

export async function saveImage(
  agentId: string,
  input: Buffer,
  source = "web",
  now = new Date()
) {
  const processed = await processImage(input)
  const id = randomUUID()
  const relative = path.join("companion-images", agentId, `${id}.jpg`)
  const file = path.resolve(artifactDir, relative)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, processed.data, { mode: 0o600 })
  try {
    const [row] = await db
      .insert(companionImages)
      .values({
        id,
        agentId,
        path: relative,
        bytes: processed.data.length,
        width: processed.width,
        height: processed.height,
        source,
        createdAt: now,
        expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
      })
      .returning()
    return row
  } catch (error) {
    await unlink(file).catch(() => {})
    throw error
  }
}

export async function getImage(agentId: string, id: string) {
  const [row] = await db
    .select()
    .from(companionImages)
    .where(and(eq(companionImages.id, id), eq(companionImages.agentId, agentId)))
  return row ?? null
}

// The stored JPEG, or null once it has expired or was deleted
export async function readImage(row: CompanionImage, now = new Date()) {
  const file = imageFile(row)
  if (!file || row.expiresAt <= now) return null
  return readFile(file).catch(() => null)
}

export async function deleteImageFile(row: CompanionImage) {
  const file = imageFile(row)
  if (file) await unlink(file).catch(() => {})
  await db
    .update(companionImages)
    .set({ path: null })
    .where(eq(companionImages.id, row.id))
}

// Called by the worker: files past their time are removed, descriptions stay
export async function purgeImages(now = new Date()) {
  const rows = await db
    .select()
    .from(companionImages)
    .where(and(isNotNull(companionImages.path), lt(companionImages.expiresAt, now)))
  for (const row of rows) await deleteImageFile(row)
  return rows.length
}

export const SEE_PROMPT = `你是图片审看助手。看这张图，只输出一个 JSON，不要多余文字：
{"description":"……","sensitive":true或false}
description：用一两句中文客观描述画面（不超过 120 字）。不要识别或猜测任何人的身份和名字；不要抄录证件号、银行卡号、手机号、详细地址等文字。
sensitive：画面里有清晰可辨的人脸（自拍、合影、人像，包括照片或屏幕里的人脸），或有身份证、护照、驾照、银行卡、工牌、车牌等证件和凭证，或你拿不准，一律填 true；只有明确是风景、食物、物品、动物、不含人脸和证件的截图或文档等，才填 false。`

const seen = z.object({
  description: z.string().trim().min(1).max(400),
  sensitive: z.boolean(),
})

export function parseSeen(text: string) {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try {
    const parsed = seen.safeParse(JSON.parse(match[0]))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// One short vision call before she answers: what is in the picture, and whether it shows a face or
// an ID. An answer we cannot read counts as sensitive. A failed call throws (she cannot see it).
export async function seeImage(
  model: LanguageModel,
  data: Buffer,
  options: { providerOptions?: Record<string, Record<string, string>> } = {}
) {
  const result = await generateText({
    model,
    system: SEE_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "请按要求输出 JSON。" },
          { type: "image", image: new Uint8Array(data), mediaType: "image/jpeg" },
        ],
      },
    ],
    providerOptions: options.providerOptions,
    maxOutputTokens: 600,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(60_000),
  })
  const parsed = parseSeen(result.text)
  return {
    description: parsed?.description ?? null,
    sensitive: parsed ? parsed.sensitive : true,
    usage: result.usage,
  }
}
