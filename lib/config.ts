// Adapted from the pinned MIT upstream lib/config.ts at the pinned MIT baseline.
import { eq, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { settings, modelSpecSchema, monthlyBudgetSchema } from "@/db/schema"
import { providers, parseModelSpec, type ProviderId } from "@/lib/providers/catalog"
import { decryptSecret, encryptSecret } from "@/lib/secrets"

type SettingDef = {
  env: string | null
  secret?: boolean
  fallback?: string
  internal?: boolean
}
const integrationSettings = {
  "model.default": { env: "OWNDESK_DEFAULT_MODEL" },
  "agent.maxSteps": { env: "OWNDESK_MAX_STEPS", fallback: "40" },
  "usage.monthlyBudget": { env: "OWNDESK_MONTHLY_BUDGET" },
  "pricing.custom": { env: null, internal: true },
  "telegram.botToken": { env: "TELEGRAM_BOT_TOKEN", secret: true, internal: true },
  "telegram.apiUrl": {
    env: "TELEGRAM_API_URL",
    fallback: "https://api.telegram.org",
    internal: true,
  },
} satisfies Record<string, SettingDef>
const providerSettings = Object.fromEntries(
  providers.flatMap((provider) => [
    [`provider.${provider.id}.apiKey`, { env: provider.keyEnv, secret: true }],
    [
      `provider.${provider.id}.baseUrl`,
      { env: provider.baseUrlEnv, fallback: provider.defaultBaseUrl || undefined },
    ],
  ])
) as Record<`provider.${ProviderId}.${"apiKey" | "baseUrl"}`, SettingDef>
const definitions: Record<string, SettingDef> = {
  ...integrationSettings,
  ...providerSettings,
}
export type SettingKey = keyof typeof integrationSettings | keyof typeof providerSettings
export type SettingSource = "local" | "env" | "default" | null
export const settingKeys = Object.keys(definitions) as SettingKey[]
export const isSettingKey = (key: string): key is SettingKey =>
  Object.hasOwn(definitions, key)
export const isWritableSetting = (key: string): key is SettingKey =>
  isSettingKey(key) && !definitions[key].internal
export const isSecretSetting = (key: SettingKey) => !!definitions[key].secret

function envValue(key: SettingKey) {
  const name = definitions[key].env
  return name ? process.env[name]?.trim() || undefined : undefined
}
async function storedValue(key: SettingKey) {
  const [row] = await db.select().from(settings).where(eq(settings.key, key))
  return row ? (isSecretSetting(key) ? decryptSecret(row.value) : row.value) : undefined
}
export async function getSetting(key: SettingKey) {
  return (await storedValue(key)) ?? envValue(key) ?? definitions[key].fallback
}
export async function getSettingSource(key: SettingKey): Promise<SettingSource> {
  if (await storedValue(key)) return "local"
  if (envValue(key)) return "env"
  return definitions[key].fallback ? "default" : null
}
export async function setSetting(key: SettingKey, value: string | null) {
  await setSettings([{ key, value }])
}
export async function setSettings(values: { key: SettingKey; value: string | null }[]) {
  await db.transaction(async (tx) => {
    if (
      values.some(({ key }) => key === "usage.monthlyBudget" || key === "pricing.custom")
    )
      await tx.execute(sql`SELECT pg_advisory_xact_lock(71261206)`)
    for (const { key, value } of values) {
      const trimmed = value?.trim()
      if (!trimmed) {
        await tx.delete(settings).where(eq(settings.key, key))
        continue
      }
      const stored = isSecretSetting(key) ? encryptSecret(trimmed) : trimmed
      await tx
        .insert(settings)
        .values({ key, value: stored })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: stored, updatedAt: new Date() },
        })
    }
  })
}
export function maskSecret(value: string | undefined) {
  if (!value) return null
  return value.length <= 8 ? "••••" : `${value.slice(0, 3)}…${value.slice(-4)}`
}
export async function describeSetting(key: SettingKey) {
  const stored = await storedValue(key)
  const fromEnv = envValue(key)
  const value = stored ?? fromEnv ?? definitions[key].fallback
  const source: SettingSource = stored
    ? "local"
    : fromEnv
      ? "env"
      : definitions[key].fallback
        ? "default"
        : null
  return {
    key,
    env: definitions[key].env,
    source,
    set: source === "local" || source === "env",
    value: isSecretSetting(key) ? maskSecret(value) : (value ?? null),
  }
}
export type SettingView = Awaited<ReturnType<typeof describeSetting>>
export async function getMaxSteps() {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(await getSetting("agent.maxSteps"))
}
export const settingUpdatesSchema = z
  .array(
    z.object({
      key: z.string().refine(isWritableSetting),
      value: z.string().max(8192).nullable(),
    })
  )
  .min(1)
  .max(30)
  .superRefine((updates, context) => {
    if (new Set(updates.map((update) => update.key)).size !== updates.length)
      context.addIssue({ code: "custom", message: "Duplicate setting keys" })
    for (const update of updates) {
      const value = update.value?.trim()
      if (!value) continue
      const valid =
        update.key === "model.default"
          ? modelSpecSchema.safeParse(value).success && !!parseModelSpec(value)
          : update.key === "agent.maxSteps"
            ? /^\d+$/.test(value) && +value >= 1 && +value <= 200
            : update.key === "usage.monthlyBudget"
              ? monthlyBudgetSchema.safeParse(value).success
              : update.key.endsWith(".baseUrl")
                ? z
                    .url()
                    .refine((value) => {
                      const url = new URL(value)
                      return (
                        ["http:", "https:"].includes(url.protocol) &&
                        !url.username &&
                        !url.password &&
                        !url.search &&
                        !url.hash
                      )
                    })
                    .safeParse(value).success
                : true
      if (!valid)
        context.addIssue({
          code: "custom",
          message: `Invalid value for ${update.key}`,
          path: [updates.indexOf(update), "value"],
        })
    }
  })
