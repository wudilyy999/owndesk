import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { listObjectives, objectiveAgents } from "@/lib/objectives"
import { Objectives } from "@/components/objectives"

export default async function ObjectivesPage() {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return (
    <Objectives
      initial={JSON.parse(
        JSON.stringify({
          objectives: await listObjectives(owner.userId),
          agents: await objectiveAgents(),
        })
      )}
    />
  )
}
