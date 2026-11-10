import path from "node:path"
import { existsSync } from "node:fs"
import { z } from "zod"

if (existsSync(".env")) process.loadEnvFile(".env")

// A blank value (compose passes `VAR: ${VAR:-}`) counts as not set
const blank = <T extends z.ZodType>(type: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), type.optional())

const schema = z.object({
  DATABASE_URL: z.url().startsWith("postgresql://"),
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  MASTER_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  INSTALL_ID: z.uuid(),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  WORKSTATION_IMAGE: z.string().default("owndesk-workstation:0.7.0"),
  // Optional overrides of the image's Chinese defaults (zh_CN.UTF-8 / Asia/Shanghai)
  WORKSTATION_LOCALE: z
    .string()
    .regex(/^[A-Za-z]{2,3}(_[A-Za-z]{2})?(\.[A-Za-z0-9-]+)?$/)
    .optional(),
  WORKSTATION_TZ: z
    .string()
    .regex(/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+){0,2}$/)
    .optional(),
  WORKER_PORT: z.coerce.number().int().min(1024).max(65535).default(6798),
  WORKER_INTERNAL_URL: z.url().optional(),
  WORKER_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  WORKSTATION_NETWORK: z.string().min(1).optional(),
  NETWORK_GUARD_IMAGE: z.string().min(1).optional(),
  MCP_ALLOW_FAKE_IP: z.enum(["true", "false"]).default("false"),
  PA_GUEST_DNS: z.ipv4().default("1.1.1.1"),
  WORKSTATION_CPUS: z.coerce.number().min(0.5).max(32).default(2),
  WORKSTATION_MEMORY_MB: z.coerce.number().int().min(1024).max(65536).default(4096),
  WORKSTATION_IDLE_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  DESKTOP_GATEWAY_URL: z.url().optional(),
  // Web notifications: `npm run push:keys` writes the pair into .env; without it the setting is hidden
  VAPID_PUBLIC_KEY: blank(z.string().regex(/^[A-Za-z0-9_-]{80,100}$/)),
  VAPID_PRIVATE_KEY: blank(z.string().regex(/^[A-Za-z0-9_-]{40,50}$/)),
  // mailto: or https: contact the push service can use; defaults to APP_URL when that is https
  VAPID_SUBJECT: blank(z.string()),
  PA_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().min(16384).default(65536),
})

export const env = schema.parse(process.env)
export const artifactDir = path.resolve(env.ARTIFACT_DIR)
