import { z } from "zod"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import {
  deviceLabel,
  listSubscriptions,
  pushConfig,
  recordSeen,
  removeSubscription,
  saveSubscription,
  sendTestPush,
} from "@/lib/companion/push"

const subscriptionSchema = z.object({
  endpoint: z.string().min(10).max(1000),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{60,120}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/),
  }),
})
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscribe"), subscription: subscriptionSchema }),
  z.object({ action: z.literal("unsubscribe"), endpoint: z.string().min(10).max(1000) }),
  z.object({ action: z.literal("test") }),
  // Sent every ~20 s by a visible chat page, so she does not buzz the phone you are holding
  z.object({ action: z.literal("seen") }),
])

const noStore = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  try {
    const { agent, companion } = await companionContext(request)
    const config = pushConfig()
    const devices = await listSubscriptions(agent.id)
    return Response.json(
      {
        // The public key is meant to be public; the private key never leaves the server
        configured: config !== null,
        publicKey: config?.publicKey ?? null,
        preview: companion.pushPreview,
        devices: devices.map((device) => ({
          id: device.id,
          endpoint: device.endpoint,
          label: deviceLabel(device.userAgent),
          createdAt: device.createdAt,
          lastSentAt: device.lastSentAt,
        })),
      },
      { headers: noStore }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { agent, companion } = await companionContext(request)
    const input = actionSchema.parse(await request.json())
    if (input.action === "seen") {
      await recordSeen(agent.id)
      return Response.json({ ok: true }, { headers: noStore })
    }
    if (input.action === "unsubscribe")
      return Response.json(
        { removed: await removeSubscription(agent.id, input.endpoint) },
        { headers: noStore }
      )
    if (!pushConfig())
      return Response.json(
        { error: "Notifications are not set up on this server (npm run push:keys)" },
        { status: 409, headers: noStore }
      )
    if (input.action === "subscribe") {
      const row = await saveSubscription(
        agent.id,
        input.subscription,
        request.headers.get("user-agent")
      )
      return Response.json({ id: row.id }, { headers: noStore })
    }
    return Response.json(
      await sendTestPush(agent.id, agent.name, companion.pushPreview),
      {
        headers: noStore,
      }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
