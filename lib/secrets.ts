import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { env } from "@/lib/env"

// Same AES-256-GCM format principle as OwnDesk's vault. Key identity is deployment-owned.
export function encryptSecret(value: string, context?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(env.MASTER_KEY, "hex"), iv)
  if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"))
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return `${context === undefined ? "v1" : "v2"}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`
}

export function decryptSecret(value: string, context?: string): string {
  if (!value.startsWith(context === undefined ? "v1:" : "v2:"))
    throw new Error("Unsupported encrypted-secret version or binding context")
  const data = Buffer.from(value.slice(3), "base64url")
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.MASTER_KEY, "hex"),
    data.subarray(0, 12)
  )
  if (context !== undefined) decipher.setAAD(Buffer.from(context, "utf8"))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
    "utf8"
  )
}
