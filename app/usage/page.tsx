import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { usageOverview } from "@/lib/spend"
import { Usage } from "@/components/usage"

export default async function UsagePage() {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return <Usage initial={await usageOverview(owner.userId)} />
}
