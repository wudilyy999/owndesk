import { DBOSClient } from "@dbos-inc/dbos-sdk"
import { env } from "@/lib/env"

export const APPLICATION_NAME = "personal-agent"
export const APPLICATION_VERSION = "0.17.0-dev"
export const TASK_QUEUE = "workspace-tasks"
export const TASK_WORKFLOW = "task-segment-v1"

let client: Promise<DBOSClient> | undefined
export function durableClient() {
  client ??= DBOSClient.create({
    systemDatabaseUrl: env.DATABASE_URL,
    applicationName: APPLICATION_NAME,
  })
  return client
}

export async function closeDurableClient() {
  if (client) {
    await (await client).destroy()
    client = undefined
  }
}
