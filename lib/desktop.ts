import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { desktopTickets, workstationControl } from "@/db/schema"
import { isSameOrigin } from "@/lib/auth"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"
import { decryptSecret } from "@/lib/secrets"

export async function issueDesktopTicket(
  owner: { userId: string; sessionId: string },
  agentId: string,
  mode: "watch" | "control",
  requestOrigin?: string | null
) {
  const [workspace] = await db
    .select()
    .from(workstationControl)
    .where(eq(workstationControl.agentId, agentId))
  if (!workspace) throw new HttpError(409, "Workstation has not been prepared")
  if (workspace.mode === "quarantined")
    throw new HttpError(409, "Workstation is quarantined for review")
  const canControl =
    !workspace.desiredMode &&
    (workspace.mode === "human" || (workspace.mode === "idle" && !workspace.activeTaskId))
  if (mode === "control" && !canControl)
    throw new HttpError(409, "Human control is not ready")
  const token = randomBytes(32).toString("base64url")
  await db.insert(desktopTickets).values({
    token,
    ownerId: owner.userId,
    sessionId: owner.sessionId,
    agentId,
    mode,
    epoch: workspace.epoch,
    expiresAt: new Date(Date.now() + 30000),
  })
  let base = env.DESKTOP_GATEWAY_URL
  if (!base) {
    const url = new URL(
      isSameOrigin(requestOrigin) && requestOrigin ? requestOrigin : env.APP_URL
    )
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    if (!env.WORKSTATION_NETWORK) url.port = String(env.WORKER_PORT)
    url.pathname = "/desktop"
    base = url.toString().replace(/\/$/, "")
  }
  const { password } = JSON.parse(decryptSecret(workspace.connectionSecret)) as {
    password: string
  }
  return {
    url: `${base.replace(/\/$/, "")}/${agentId}`,
    token,
    password,
    mode,
    epoch: workspace.epoch,
  }
}
