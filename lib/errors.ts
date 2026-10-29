import { ZodError } from "zod"

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof ZodError)
    return Response.json(
      { error: error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    )
  console.error("Request failed", error)
  return Response.json(
    { error: "Request failed; see server log for the cause" },
    { status: 500 }
  )
}
