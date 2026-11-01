import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { Companion } from "@/components/companion"

export default async function CompanionPage() {
  try {
    await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return <Companion />
}
