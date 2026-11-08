import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"

// Carry the owner's session to the worker; Docker remains available only there.
export async function workerRequest(request: Request, route: string, body: unknown) {
  const response = await fetch(
    new URL(route, env.WORKER_INTERNAL_URL ?? `http://127.0.0.1:${env.WORKER_PORT}`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("cookie") ?? "",
        Origin: request.headers.get("origin") ?? "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    }
  )
  const result = await response.json()
  if (!response.ok) throw new HttpError(response.status, result.error)
  return result
}
