import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { routineOverview } from "@/lib/routines"
import { Routines } from "@/components/routines"

export default async function RoutinesPage() {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return <Routines initial={await routineOverview(owner.userId)} />
}
