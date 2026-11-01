import path from "node:path"
import { existsSync } from "node:fs"
import { z } from "zod"

if (existsSync(".env")) process.loadEnvFile(".env")

const schema = z.object({
  DATABASE_URL: z.url().startsWith("postgresql://"),
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  MASTER_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  INSTALL_ID: z.uuid(),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  WORKSTATION_IMAGE: z.string().default("owndesk-workstation:0.6.6"),
  WORKER_PORT: z.coerce.number().int().min(1024).max(65535).default(6798),
  WORKER_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  WORKSTATION_NETWORK: z.string().min(1).optional(),
  NETWORK_GUARD_IMAGE: z.string().min(1).optional(),
  PA_GUEST_DNS: z.ipv4().default("1.1.1.1"),
  WORKSTATION_CPUS: z.coerce.number().min(0.5).max(32).default(2),
  WORKSTATION_MEMORY_MB: z.coerce.number().int().min(1024).max(65536).default(4096),
  WORKSTATION_IDLE_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  DESKTOP_GATEWAY_URL: z.url().optional(),
  PA_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().min(16384).default(65536),
})

export const env = schema.parse(process.env)
export const artifactDir = path.resolve(env.ARTIFACT_DIR)
