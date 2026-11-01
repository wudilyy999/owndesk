import { requireOwner } from "@/lib/auth"
import { listAgents } from "@/lib/agents"
import { HttpError } from "@/lib/errors"
import { ensureCompanion } from "./store"

// The workspace has one owner; the companion lives on the agent named by ?agentId, else the first agent
export async function companionContext(request: Request) {
  const owner = await requireOwner(request.headers)
  const requested = new URL(request.url).searchParams.get("agentId")
  const agents = await listAgents()
  const agent = requested ? agents.find((a) => a.id === requested) : agents[0]
  if (!agent) throw new HttpError(404, "Create an agent first")
  const companion = await ensureCompanion(owner.userId, agent.id)
  return { ownerId: owner.userId, agent, companion }
}
