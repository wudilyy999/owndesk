import { requireOwner } from "@/lib/auth"
import { HttpError, errorResponse } from "@/lib/errors"
import { finishConnectionAuthorization } from "@/lib/connections"
import { env } from "@/lib/env"
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers),
      url = new URL(request.url),
      code = url.searchParams.get("code"),
      state = url.searchParams.get("state")
    if (!code || !state)
      throw new HttpError(400, "Authorization cancelled or missing code")
    await finishConnectionAuthorization(
      owner.userId,
      (await context.params).id,
      state,
      code
    )
    return Response.redirect(`${env.APP_URL}/settings#connections`, 303)
  } catch (error) {
    return errorResponse(error)
  }
}
