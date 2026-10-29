import { z } from "zod"
import { pool } from "@/db"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { respondToRequest } from "@/lib/task-control"

const approvalInput = z.strictObject({ payloadVersion: z.number().int().positive() })
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = approvalInput.parse(await request.json())
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await respondToRequest(
        owner.userId,
        (await context.params).id,
        "approve",
        input.payloadVersion,
        {},
        "owner",
        { client, purpose: "payment_submit" }
      )
      await client.query("COMMIT")
      return Response.json(result, {
        status: 202,
        headers: { "Cache-Control": "private, no-store" },
      })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
