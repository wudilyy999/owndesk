import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { listAgents } from "@/lib/agents"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { getTask, listTasks } from "@/lib/tasks"
import { listThreads } from "@/lib/threads"
import { getMaxSteps } from "@/lib/config"
import { Workspace } from "@/components/workspace"

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ task?: string | string[] }>
}) {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  const requestedTask = (await searchParams).task
  if (Array.isArray(requestedTask) || (requestedTask && requestedTask.length > 100))
    notFound()
  const [agentRows, taskRows, threadRows] = await Promise.all([
    listAgents(),
    listTasks(owner.userId),
    listThreads(owner.userId),
  ])
  let selectedTask
  if (requestedTask && !taskRows.some((task) => task.id === requestedTask)) {
    try {
      selectedTask = await getTask(owner.userId, requestedTask)
      if (selectedTask.configSnapshot.runtime === "fixture") notFound()
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) notFound()
      throw error
    }
  }
  const displayTasks = selectedTask ? [selectedTask, ...taskRows] : taskRows
  return (
    <Workspace
      ownerName={owner.user.name}
      maxSteps={await getMaxSteps()}
      initialSelected={requestedTask}
      initialThreads={threadRows.map((thread) => ({
        ...thread,
        activeAt: new Date(thread.activeAt).toISOString(),
      }))}
      agents={agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        model: a.model,
      }))}
      initialTasks={displayTasks.map((t) => ({
        id: t.id,
        agentId: t.agentId,
        conversationAgentId: t.conversationAgentId,
        threadId: t.threadId,
        threadTurn: t.threadTurn,
        goal: t.goal,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      }))}
    />
  )
}
