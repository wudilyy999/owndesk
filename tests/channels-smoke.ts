// Manual smoke test against a RUNNING app and worker (npm run dev + npm run worker) with the real
// model but a FAKE QQ platform: signed webhook -> bind -> chat -> reply reaches the fake QQ API.
// It changes the QQ settings and the QQ link of the first agent and restores them at the end.
//   npx tsx tests/channels-smoke.ts
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

process.loadEnvFile(".env")
const { setSetting, getSetting } = await import("@/lib/config")
const { db, pool } = await import("@/db")
const { channelLinks, channelInbound } = await import("@/db/schema")
const { eq, and } = await import("drizzle-orm")
const { listAgents } = await import("@/lib/agents")
const { createPairCode } = await import("@/lib/channels/pairing")
const { qqSignValidation } = await import("@/lib/channels/qq")
const { FAILED_TEXT } = await import("@/lib/channels/hub")

const app = process.env.APP_URL ?? "http://127.0.0.1:6797"
const secret = "smoke-secret-0123456789abcdef"
const received: { path: string; body: any }[] = []
const fakeQq = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    received.push({ path: req.url!, body: raw ? JSON.parse(raw) : null })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify(
        req.url!.startsWith("/app/getAppAccessToken")
          ? { access_token: "T", expires_in: "7200" }
          : { id: "ok" }
      )
    )
  })
})
await new Promise<void>((resolve) => fakeQq.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${(fakeQq.address() as AddressInfo).port}`

const previous = {
  appId: await getSetting("qq.appId"),
  appSecret: await getSetting("qq.appSecret"),
  apiBase: await getSetting("qq.apiBase"),
  relay: await getSetting("channel.relayUrl"),
}
const [agent] = await listAgents()
const [{ user_id: ownerId }] = (await pool.query("SELECT user_id FROM owners LIMIT 1"))
  .rows
const post = async (id: string, text: string) => {
  const raw = JSON.stringify({
    id: `smoke-${id}`,
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    d: { id: `smoke-msg-${id}`, content: text, author: { user_openid: "SMOKE-OPENID" } },
  })
  const ts = String(Date.now())
  const response = await fetch(`${app}/api/channels/qq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": ts,
      "x-signature-ed25519": qqSignValidation(secret, ts, raw),
    },
    body: raw,
  })
  assert.equal(response.status, 200)
}
const waitFor = async (count: number) => {
  // Slow BYOK relays often need 2+ minutes for a companion reply.
  for (let i = 0; i < 600; i++) {
    if (received.filter((r) => r.path.includes("/messages")).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `timed out waiting for ${count} QQ messages; got ${JSON.stringify(received)}`
  )
}
try {
  await setSetting("qq.appId", "999")
  await setSetting("qq.appSecret", secret)
  await setSetting("qq.apiBase", origin)
  await setSetting("channel.relayUrl", null)
  const { code } = await createPairCode(ownerId, agent.id)
  await post("1", `绑定 ${code}`)
  await waitFor(1)
  console.log("bound ->", received.at(-1)!.body.content)
  await post("2", "在吗？今天过得怎么样")
  await waitFor(2)
  const answers = received.filter((r) => r.path.includes("/messages")).slice(1)
  console.log(
    "reply ->",
    answers.map((a) => `${a.body.msg_seq}:${a.body.content}`).join(" | ")
  )
  assert.ok(answers.every((a) => a.body.msg_id === "smoke-msg-2" && a.body.content))
  // The channel replies with FAILED_TEXT when the model call fails; that must not count as a pass.
  assert.ok(
    answers.every((a) => !String(a.body.content).includes(FAILED_TEXT)),
    "the model call failed (fallback text was sent); check the relay key and model"
  )
  console.log("channels smoke passed")
} finally {
  await db
    .delete(channelLinks)
    .where(and(eq(channelLinks.channel, "qq"), eq(channelLinks.agentId, agent.id)))
  await db.delete(channelInbound).where(eq(channelInbound.channel, "qq"))
  await setSetting("qq.appId", previous.appId ?? null)
  await setSetting("qq.appSecret", previous.appSecret ?? null)
  await setSetting(
    "qq.apiBase",
    previous.apiBase === "https://api.bot.qq.com" ? null : (previous.apiBase ?? null)
  )
  await setSetting("channel.relayUrl", previous.relay ?? null)
  fakeQq.close()
  await pool.end()
}
