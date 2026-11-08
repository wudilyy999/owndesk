import { eq } from "drizzle-orm"
import { db } from "@/db"
import { owners, type Agent, type Task } from "@/db/schema"
import {
  isProviderConfigured,
  resolveModelSpec,
  modelContextWindow,
} from "@/lib/providers/registry"
import { parseModelSpec } from "@/lib/providers/catalog"
import { HttpError } from "@/lib/errors"
import { agentZeroPluginSnapshot } from "@/lib/agent-zero-plugins"
import { manualSnapshot } from "@/lib/manuals"
import { taskMemoryContext } from "@/lib/task-memory"

// Task acceptance and delegation freeze exactly the same model and memory policy.
export async function agentSnapshot(
  agent: Agent,
  ownerId: string,
  timeZone?: string,
  requireModel = true
) {
  const runtime = agent.model === "fixture/durable-report" ? "fixture" : "agent"
  const model = !requireModel
    ? "workflow/deterministic"
    : runtime === "fixture"
      ? agent.model!
      : await resolveModelSpec(agent.model)
  if (!model)
    throw new HttpError(
      409,
      "Configure a provider and choose a model in Settings before submitting a task"
    )
  if (runtime === "agent" && requireModel) {
    const parsed = parseModelSpec(model)
    if (!parsed || !(await isProviderConfigured(parsed.provider)))
      throw new HttpError(409, "The selected model provider is not configured")
  }
  const memory =
    runtime === "agent" ? await taskMemoryContext(agent.id) : { memories: [] }
  const [owner] =
    runtime === "agent"
      ? await db.select().from(owners).where(eq(owners.userId, ownerId))
      : []
  const plugins =
    runtime === "agent" && requireModel ? await agentZeroPluginSnapshot() : []
  const manuals = runtime === "agent" && requireModel ? await manualSnapshot(ownerId) : []
  return {
    model,
    contextWindowTokens: modelContextWindow(model),
    name: agent.name,
    role: agent.role,
    timeZone: timeZone ?? owner?.timeZone ?? "UTC",
    instructions: agent.instructions ?? "",
    ...memory,
    ...(plugins.length ? { agentZeroPlugins: plugins } : {}),
    ...(manuals.length ? { manuals } : {}),
    runtime,
  } satisfies Task["configSnapshot"]
}
