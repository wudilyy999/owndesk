import { eq } from "drizzle-orm"
import { db } from "@/db"
import { agents, companions, type Companion } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { defaultPersona, type CompanionSettingsInput } from "./persona"

// Partner (romantic) mode is only allowed after an explicit 18+ confirmation
export function resolveModeChange(
  current: Pick<Companion, "mode" | "adultConfirmedAt">,
  input: Pick<CompanionSettingsInput, "mode" | "adultConfirmed">,
  now = new Date()
) {
  const adultConfirmedAt = current.adultConfirmedAt ?? (input.adultConfirmed ? now : null)
  const mode = input.mode ?? current.mode
  if (mode === "partner" && !adultConfirmedAt)
    throw new HttpError(400, "恋人模式需要先确认你已年满 18 岁")
  return { mode, adultConfirmedAt }
}

export async function ensureCompanion(
  ownerId: string,
  agentId: string,
  timeZone = "UTC"
) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
  if (!agent) throw new HttpError(404, "Agent not found")
  await db
    .insert(companions)
    .values({ agentId, ownerId, persona: defaultPersona, timeZone })
    .onConflictDoNothing()
  const [row] = await db.select().from(companions).where(eq(companions.agentId, agentId))
  return row
}

export async function updateCompanion(
  ownerId: string,
  agentId: string,
  input: CompanionSettingsInput
) {
  const current = await ensureCompanion(ownerId, agentId, input.timeZone)
  const { mode, adultConfirmedAt } = resolveModeChange(current, input)
  const { adultConfirmed: _confirmed, ...fields } = input
  const [row] = await db
    .update(companions)
    .set({ ...fields, mode, adultConfirmedAt, updatedAt: new Date() })
    .where(eq(companions.agentId, agentId))
    .returning()
  return row
}
