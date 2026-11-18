import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { improvementOverview } from "@/lib/evolution/improvements"
import { Improvements } from "@/components/improvements"

export default async function ImprovementsPage() {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return (
    <Improvements
      initial={JSON.parse(JSON.stringify(await improvementOverview(owner.userId)))}
    />
  )
}
