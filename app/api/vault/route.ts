import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listVault, saveVaultItem, deleteVaultItem } from "@/lib/vault"
import { vaultMutationSchema } from "@/lib/vault-schema"
const headers = { "Cache-Control": "private, no-store" }
export async function GET(request: Request) {
  try {
    await requireOwner(request.headers)
    return Response.json(await listVault(), { headers })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    return Response.json(
      await saveVaultItem(vaultMutationSchema.parse(await request.json())),
      { headers, status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { revision, ...input } = vaultMutationSchema
      .extend({ revision: z.number().int().min(1) })
      .parse(await request.json())
    return Response.json(await saveVaultItem(input, { revision }), { headers })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { id, revision } = z
      .strictObject({ id: z.string().min(1).max(200), revision: z.number().int().min(1) })
      .parse(await request.json())
    await deleteVaultItem(id, revision)
    return Response.json({ deleted: true }, { headers })
  } catch (error) {
    return errorResponse(error)
  }
}
