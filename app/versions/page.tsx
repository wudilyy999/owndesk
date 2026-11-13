import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { listVersions } from "@/lib/versions"
import { Versions } from "@/components/versions"

export default async function VersionsPage() {
  try {
    await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  return <Versions initial={JSON.parse(JSON.stringify(await listVersions()))} />
}
