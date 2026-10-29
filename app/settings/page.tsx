import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { listAgents } from "@/lib/agents"
import { requireOwner } from "@/lib/auth"
import { settingKeys, describeSetting } from "@/lib/config"
import { HttpError } from "@/lib/errors"
import { Settings } from "@/components/settings"
export default async function SettingsPage() {
  try {
    await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  const [views, rows] = await Promise.all([
    Promise.all(
      settingKeys.filter((key) => key !== "pricing.custom").map(describeSetting)
    ),
    listAgents(),
  ])
  return (
    <Settings
      initialSettings={views}
      agents={rows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        model: agent.model ?? "",
        instructions: agent.instructions ?? "",
      }))}
    />
  )
}
