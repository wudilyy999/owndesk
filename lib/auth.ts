import { betterAuth } from "better-auth"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { owners } from "@/db/schema"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"

function computeAllowedOrigins(): string[] {
  const url = new URL(env.APP_URL)
  const origins = [url.origin]
  if (url.hostname === "localhost") {
    const ipv4 = new URL(url.origin)
    ipv4.hostname = "127.0.0.1"
    origins.push(ipv4.origin)
  } else if (url.hostname === "127.0.0.1") {
    const local = new URL(url.origin)
    local.hostname = "localhost"
    origins.push(local.origin)
  }
  return origins
}

export const allowedOrigins = computeAllowedOrigins()

export function isSameOrigin(origin: string | null | undefined): boolean {
  return !!origin && allowedOrigins.includes(origin)
}

export const auth = betterAuth({
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL,
  trustedOrigins: allowedOrigins,
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
  session: { expiresIn: 7 * 24 * 3600 },
})

export async function requireOwner(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session) throw new HttpError(401, "Sign in required")
  const [owner] = await db.select().from(owners).where(eq(owners.userId, session.user.id))
  if (!owner) throw new HttpError(403, "Owner access required")
  return { ...owner, user: session.user, sessionId: session.session.id }
}

export function requireSameOrigin(request: Request) {
  if (!isSameOrigin(request.headers.get("origin"))) {
    throw new HttpError(403, "Request origin does not match this installation")
  }
}
