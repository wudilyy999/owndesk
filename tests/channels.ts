// Companion channels against a throwaway database and fake QQ / WeChat / WeChat-OA servers.
// Nothing here talks to a real platform: the protocol shapes come from the official docs, so
// this proves our side (signatures, routing rules, ordering, dedup, folding) and not the
// platforms' acceptance of real credentials.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"
// @ts-expect-error plain JS module that ships to the VPS
import { createRelay } from "../deploy/channel-relay/relay.mjs"

process.loadEnvFile(".env")
const database = `agent_channels_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "channels@fixture.test",
  OWNER_PASSWORD: randomUUID(),
})

type Call = { method: string; path: string; headers: IncomingMessage["headers"]; body: any }
function fake(handler: (call: Call) => unknown) {
  const calls: Call[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      let body: any = raw
      try {
        body = JSON.parse(raw)
      } catch {}
      const call = { method: req.method!, path: req.url!, headers: req.headers, body }
      calls.push(call)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(handler(call) ?? {}))
    })
  })
  return new Promise<{ calls: Call[]; server: Server; origin: string }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    )
  )
}

const servers: Server[] = []
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)

  const { db, pool } = await import("@/db")
  const { setSetting } = await import("@/lib/config")
  const schema = await import("@/db/schema")
  const { eq, and, desc, asc } = await import("drizzle-orm")
  const hub = await import("@/lib/channels/hub")
  const { createPairCode, bindChannel } = await import("@/lib/channels/pairing")
  const hooks = await import("@/lib/channels/webhooks")
  const qq = await import("@/lib/channels/qq")
  const oa = await import("@/lib/channels/wechat-oa")
  const wechat = await import("@/lib/channels/wechat")
  const { channelStatus, channelAction } = await import("@/lib/channels/manage")
  const { ensureCompanion, updateCompanion } = await import("@/lib/companion/store")
  const { closeDurableClient } = await import("@/lib/durable")

  const ownerId = "channels-owner"
  const agentId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [ownerId]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
    [agentId]
  )
  await ensureCompanion(ownerId, agentId)
  // Awake and online all day so the rhythm never changes what these tests look at
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "03:00", end: "03:01" }, nap: null, away: [] },
  } as never)

  const price = { kind: "priced", source: "custom", price: { input: 1, output: 4 } } as const
  const prompts: string[] = []
  const model = (replies: string[]) => {
    let call = 0
    const mock = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(String(options.prompt[0].content))
        const value = replies[Math.min(call++, replies.length - 1)]
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({ type: "text-start", id: "t" })
              controller.enqueue({ type: "text-delta", id: "t", delta: value })
              controller.enqueue({ type: "text-end", id: "t" })
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 20, text: 20, reasoning: 0 },
                },
              })
              controller.close()
            },
          }),
        }
      },
    })
    return { model: mock, price }
  }
  const run = async (replies: string[]) => {
    await hub.processPendingInbound(model(replies))
  }
  const linkOf = async (channel: "qq" | "wechat" | "wechat_oa" | "telegram") => {
    const [row] = await db
      .select()
      .from(schema.channelLinks)
      .where(and(eq(schema.channelLinks.channel, channel), eq(schema.channelLinks.agentId, agentId)))
    return row
  }
  const outbox = async (linkId: string) =>
    db
      .select()
      .from(schema.channelOutbox)
      .where(eq(schema.channelOutbox.linkId, linkId))
      .orderBy(asc(schema.channelOutbox.createdAt))

  // ───────────────────────── QQ, through the fixed-IP relay ─────────────────────────
  const secret = "DG5g3B4j9X2KOErG"
  const qqApi = await fake((call) =>
    call.path.startsWith("/app/getAppAccessToken")
      ? { access_token: "QQTOKEN", expires_in: "7200" }
      : { id: randomUUID() }
  )
  servers.push(qqApi.server)
  const relayKey = "relay-key-" + randomUUID()
  const relay = createRelay({
    key: relayKey,
    upstreamInsecure: true,
    upstreamResolve: () => ({ host: "127.0.0.1", port: Number(new URL(qqApi.origin).port) }),
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  servers.push(relay)
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`
  await setSetting("qq.appId", "1020304050")
  await setSetting("qq.appSecret", secret)
  await setSetting("channel.relayUrl", relayOrigin)
  await setSetting("channel.relayKey", relayKey)
  // apiBase stays the real host so the call is rewritten to the relay, which forwards to the fake

  // 1. Address validation is answered with the documented signature; other posts need one
  const validation = await hooks.handleQqWebhook(
    JSON.stringify({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" } }),
    { timestamp: null, signature: null }
  )
  assert.equal(validation.status, 200)
  assert.equal(
    (validation.body as { signature: string }).signature,
    "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706"
  )
  const qqEvent = (id: string, text: string, openid = "OPENID-A", type = "C2C_MESSAGE_CREATE") => ({
    id: `evt-${id}`,
    op: 0,
    t: type,
    d: { id: `msg-${id}`, content: text, author: { user_openid: openid }, openid },
  })
  const send = (payload: object, signed = true) => {
    const raw = JSON.stringify(payload)
    const ts = String(Date.now())
    return hooks.handleQqWebhook(raw, {
      timestamp: ts,
      signature: signed ? qq.qqSignValidation(secret, ts, raw) : "0".repeat(128),
    })
  }
  assert.equal((await send(qqEvent("x", "hi"), false)).status, 401)
  assert.equal((await hooks.handleQqWebhook("{}", { timestamp: null, signature: null })).status, 401)
  assert.equal((await db.select().from(schema.channelInbound)).length, 0)

  // 2. A stranger is told how to bind and nothing reaches the companion
  assert.equal((await send(qqEvent("1", "你好呀"))).status, 200)
  await run(["不该被调用"])
  assert.equal(prompts.length, 0)
  assert.equal((await db.select().from(schema.companionMessages)).length, 0)
  let sent = qqApi.calls.filter((c) => c.path.startsWith("/v2/users/OPENID-A/messages"))
  assert.equal(sent.length, 1)
  assert.match(sent[0].body.content, /绑定码/)
  assert.equal(sent[0].body.msg_id, "msg-1")
  assert.equal(sent[0].headers.authorization, "QQBot QQTOKEN")
  assert.equal(sent[0].headers["x-relay-key"], undefined, "relay key must not reach QQ")

  // 3. A wrong code is refused; the right one binds once and replaces nothing else
  await send(qqEvent("2", "绑定 ABCD2345"))
  await run(["x"])
  assert.match(qqApi.calls.at(-1)!.body.content, /不对或已过期/)
  const pair = await createPairCode(ownerId, agentId)
  assert.match(pair.code, /^[A-Z2-9]{8}$/)
  const stored = await pool.query("SELECT code_hash FROM channel_pair_codes")
  assert.ok(!JSON.stringify(stored.rows).includes(pair.code), "code stored hashed")
  await send(qqEvent("3", `绑定 ${pair.code}`))
  await run(["x"])
  let link = (await linkOf("qq"))!
  assert.equal(link.externalId, "OPENID-A")
  assert.equal(link.ownerId, ownerId)
  assert.match(qqApi.calls.at(-1)!.body.content, /绑定好了/)
  assert.equal(qqApi.calls.at(-1)!.body.msg_seq, 1)
  await send(qqEvent("4", `绑定 ${pair.code}`, "OPENID-B"))
  await run(["x"])
  assert.equal((await linkOf("qq"))!.externalId, "OPENID-A", "a used code cannot rebind")
  assert.equal(prompts.length, 0)

  // 4. Chat: two bubbles go out as passive replies with rising msg_seq; redelivery is ignored
  const before = qqApi.calls.length
  await send(qqEvent("5", "今天好累"))
  await send(qqEvent("5", "今天好累"))
  assert.equal((await db.select().from(schema.channelInbound).where(eq(schema.channelInbound.eventKey, "evt-5"))).length, 1)
  await run(["抱抱你\n\n怎么啦"])
  const replies = qqApi.calls.slice(before).filter((c) => c.path.includes("/messages"))
  assert.deepEqual(replies.map((c) => [c.body.content, c.body.msg_id, c.body.msg_seq]), [
    ["抱抱你", "msg-5", 1],
    ["怎么啦", "msg-5", 2],
  ])
  const history = await db.select().from(schema.companionMessages).orderBy(asc(schema.companionMessages.createdAt))
  assert.deepEqual(history.map((m) => [m.role, m.channel, m.content]), [
    ["user", "qq", "今天好累"],
    ["assistant", "qq", "抱抱你"],
    ["assistant", "qq", "怎么啦"],
  ])

  // 5. Passive window over: a share uses the one wake-up allowed today, the next one is held
  await db
    .update(schema.channelLinks)
    .set({ state: { ...(link.state as object), msgIdAt: new Date(Date.now() - 10 * 60_000).toISOString() } })
    .where(eq(schema.channelLinks.id, link.id))
  const share = async (content: string) => {
    await new Promise((r) => setTimeout(r, 5))
    await db.insert(schema.companionMessages).values({
      agentId, role: "assistant", kind: "share", content, channel: "web", metadata: null,
    })
  }
  await share("刚刷到一只会骑自行车的猫")
  assert.equal(await hub.routeBackgroundMessages(), 1)
  assert.equal(await hub.routeBackgroundMessages(), 0, "fan-out is idempotent")
  const mark = qqApi.calls.length
  await hub.deliverOutbox()
  const wake = qqApi.calls.slice(mark).filter((c) => c.path.includes("/messages"))
  assert.equal(wake.length, 1)
  assert.equal(wake[0].body.is_wakeup, true)
  assert.equal(wake[0].body.msg_id, undefined)
  await share("还有一家新开的面包店")
  await hub.routeBackgroundMessages()
  await hub.deliverOutbox()
  assert.equal(qqApi.calls.slice(mark).filter((c) => c.path.includes("/messages")).length, 1, "second wake-up in the same period is not sent")
  link = (await linkOf("qq"))!
  let rows = await outbox(link.id)
  assert.equal(rows.filter((r) => r.status === "held").length, 1)
  assert.match(rows.find((r) => r.status === "held")!.text, /面包店/)

  // 6. The person writes again: the held share is worked into the reply, then marked bundled
  prompts.length = 0
  await send(qqEvent("6", "我回来啦"))
  await run(["欢迎回来\n\n对了，刚看到新开了家面包店"])
  assert.match(prompts[0], /面包店/)
  assert.match(prompts[0], /想告诉对方、但还没说的事/)
  rows = await outbox(link.id)
  assert.equal(rows.filter((r) => r.status === "held").length, 0)
  assert.equal(rows.filter((r) => r.status === "bundled").length, 1)
  // New day for the platform: wake-up allowance is per period, so a fresh message resets it
  const lastReply = qqApi.calls.filter((c) => c.path.includes("/messages")).at(-1)!
  assert.equal(lastReply.body.msg_id, "msg-6")

  // 7. Unit rules
  const t0 = new Date("2026-11-01T02:00:00Z") // 10:00 UTC+8
  assert.equal(qq.wakeupPeriod(new Date("2026-11-01T01:00:00Z"), t0), 0)
  assert.equal(qq.wakeupPeriod(new Date("2026-10-30T01:00:00Z"), t0), 1)
  assert.equal(qq.wakeupPeriod(new Date("2026-10-27T01:00:00Z"), t0), 2)
  assert.equal(qq.wakeupPeriod(new Date("2026-10-20T01:00:00Z"), t0), 3)
  assert.equal(qq.wakeupPeriod(new Date("2026-09-20T01:00:00Z"), t0), null)
  assert.equal(
    qq.sanitizeQqText("看这个 https://a.example.com/x 和 https://b.test/y", ["a.example.com"]),
    "看这个 https://a.example.com/x 和 （链接在网页里）"
  )
  await send(qqEvent("7", "", "OPENID-A", "C2C_MSG_REJECT"))
  assert.equal(((await linkOf("qq"))!.state as { rejected?: boolean }).rejected, true)
  await send(qqEvent("8", "", "OPENID-A", "C2C_MSG_RECEIVE"))
  assert.equal(((await linkOf("qq"))!.state as { rejected?: boolean }).rejected, false)

  // ───────────────────────── WeChat ClawBot (iLink) ─────────────────────────
  const ilink = await fake((call) => {
    if (call.path.startsWith("/ilink/bot/get_bot_qrcode"))
      return { qrcode: "QR1", qrcode_img_content: "https://weixin.example/qr" }
    if (call.path.startsWith("/ilink/bot/get_qrcode_status"))
      return { status: "confirmed", bot_token: "BOT-TOKEN", ilink_user_id: "wx-user@im.wechat", baseurl: "" }
    if (call.path === "/ilink/bot/getupdates")
      return call.body.get_updates_buf
        ? { ret: 0, msgs: [], get_updates_buf: call.body.get_updates_buf }
        : {
            ret: 0,
            get_updates_buf: "CURSOR-1",
            msgs: [
              {
                message_id: 1001,
                from_user_id: "wx-user@im.wechat",
                message_type: 1,
                context_token: "CTX-1",
                item_list: [{ type: 1, text_item: { text: "在吗" } }],
              },
              { message_id: 1002, from_user_id: "stranger@im.wechat", message_type: 1, context_token: "CTX-X", item_list: [{ type: 1, text_item: { text: "hi" } }] },
            ],
          }
    return { ret: 0 }
  })
  servers.push(ilink.server)
  await setSetting("wechat.baseUrl", ilink.origin)
  const qr = await wechat.startWechatLogin()
  assert.equal(qr.qrcode, "QR1")
  const login = await channelAction(ownerId, agentId, { action: "wechat-login-poll", qrcode: "QR1" })
  assert.equal((login as { status: string }).status, "confirmed")
  assert.equal((await linkOf("wechat"))!.externalId, "wx-user@im.wechat")
  const abort = new AbortController()
  const poller = wechat.runWechat(abort.signal)
  for (let i = 0; i < 50 && !(await db.select().from(schema.channelInbound).where(eq(schema.channelInbound.channel, "wechat"))).length; i++)
    await new Promise((r) => setTimeout(r, 100))
  abort.abort()
  await poller
  const wxInbound = await db.select().from(schema.channelInbound).where(eq(schema.channelInbound.channel, "wechat"))
  assert.equal(wxInbound.length, 1, "only the person who scanned the QR is accepted")
  assert.equal(
    ilink.calls.find((c) => c.path === "/ilink/bot/getupdates")!.headers.authorization,
    "Bearer BOT-TOKEN"
  )
  await run(["在的呀"])
  const wxSend = ilink.calls.filter((c) => c.path === "/ilink/bot/sendmessage")
  assert.equal(wxSend.length, 1)
  assert.equal(wxSend[0].body.msg.context_token, "CTX-1")
  assert.equal(wxSend[0].body.msg.to_user_id, "wx-user@im.wechat")
  assert.equal(wxSend[0].body.msg.item_list[0].text_item.text, "在的呀")
  // WeChat never lets her start a conversation: shares wait and are bundled into the next reply
  await share("今天路过一棵开花的树")
  await hub.routeBackgroundMessages()
  await hub.deliverOutbox()
  assert.equal(ilink.calls.filter((c) => c.path === "/ilink/bot/sendmessage").length, 1)
  const wxLink = (await linkOf("wechat"))!
  assert.equal((await outbox(wxLink.id)).filter((r) => r.status === "held").length, 1)
  prompts.length = 0
  await hub.channelTick() // nothing pending: must not send anything
  await db.insert(schema.channelInbound).values({
    channel: "wechat", eventKey: "1003", externalId: "wx-user@im.wechat", text: "晚上好",
    context: { contextToken: "CTX-2" },
  })
  await run(["晚上好呀\n\n路过一棵开花的树，想起你了"])
  assert.match(prompts[0], /开花的树/)
  assert.equal(ilink.calls.filter((c) => c.path === "/ilink/bot/sendmessage").at(-1)!.body.msg.context_token, "CTX-2")

  // ───────────────────────── WeChat official account ─────────────────────────
  const oaApi = await fake((call) =>
    call.path.startsWith("/cgi-bin/token") ? { access_token: "OATOKEN", expires_in: 7200 } : { errcode: 0, errmsg: "ok" }
  )
  servers.push(oaApi.server)
  const oaToken = "oa-token-" + randomUUID().slice(0, 8)
  const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
  await setSetting("wechatOa.apiBase", oaApi.origin)
  await setSetting("wechatOa.appId", "wxappid123")
  await setSetting("wechatOa.appSecret", "oa-secret")
  await setSetting("wechatOa.token", oaToken)
  await setSetting("wechatOa.aesKey", aesKey)
  await setSetting("channel.relayUrl", null) // direct for this part
  const sign = (parts: string[]) =>
    createHash("sha1").update([...parts].sort().join("")).digest("hex")
  const ts = "1700000000", nonce = "n0nce"
  assert.equal((await hooks.handleOaVerify({ signature: sign([oaToken, ts, nonce]), timestamp: ts, nonce, echostr: "ECHO" })).body, "ECHO")
  assert.equal((await hooks.handleOaVerify({ signature: "bad", timestamp: ts, nonce, echostr: "ECHO" })).status, 403)
  const xml = (id: number, from: string, content: string) =>
    `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${id}</MsgId></xml>`
  const plainQuery = { signature: sign([oaToken, ts, nonce]), timestamp: ts, nonce }
  assert.equal((await hooks.handleOaMessage(xml(1, "oa-user", "绑定 ZZZZ2222"), { ...plainQuery, signature: "bad" })).status, 403)
  const pair2 = await createPairCode(ownerId, agentId)
  // security mode (AES)
  const cipher = oa.oaEncrypt(aesKey, xml(2, "oa-user", `绑定 ${pair2.code}`), "wxappid123")
  assert.equal(oa.oaDecrypt(aesKey, cipher, "wxappid123").includes("oa-user"), true)
  assert.throws(() => oa.oaDecrypt(aesKey, cipher, "other-app"))
  const encryptedBody = `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>`
  const ok = await hooks.handleOaMessage(encryptedBody, {
    signature: null, timestamp: ts, nonce, msg_signature: sign([oaToken, ts, nonce, cipher]),
  })
  assert.equal(ok.body, "success")
  await run(["x"])
  assert.equal((await linkOf("wechat_oa"))!.externalId, "oa-user")
  assert.match(oaApi.calls.at(-1)!.body.text.content, /绑定好了/)
  assert.equal(oaApi.calls.at(-1)!.path.includes("access_token=OATOKEN"), true)
  await hooks.handleOaMessage(xml(3, "oa-user", "你好"), plainQuery)
  await run(["你好呀"])
  assert.equal(oaApi.calls.at(-1)!.body.text.content, "你好呀")
  assert.equal(oaApi.calls.at(-1)!.body.touser, "oa-user")
  // customer-service limit: five messages per inbound, the rest wait
  const oaLink = (await linkOf("wechat_oa"))!
  await db.update(schema.channelLinks).set({ state: { ...(oaLink.state as object), sent: 5 } }).where(eq(schema.channelLinks.id, oaLink.id))
  const oaBefore = oaApi.calls.length
  await share("给你看看今天的云")
  await hub.routeBackgroundMessages()
  await hub.deliverOutbox()
  assert.equal(oaApi.calls.length, oaBefore)

  // ───────────────────────── Telegram (existing bridge) ─────────────────────────
  await pool.query(
    "INSERT INTO telegram_connection(id,owner_id,generation,user_id,chat_id,owner_name,paired_at,agent_id) VALUES(1,$1,'g1','555','555','Me',now(),$2) ON CONFLICT(id) DO UPDATE SET user_id='555',chat_id='555',agent_id=$2",
    [ownerId, agentId]
  )
  await channelAction(ownerId, agentId, { action: "telegram-link" })
  await share("给你发张今天的晚霞")
  await hub.routeBackgroundMessages()
  await hub.deliverOutbox()
  const tg = await pool.query("SELECT chat_id,payload FROM telegram_outbox ORDER BY created_at")
  assert.equal(tg.rows.length, 1)
  assert.equal(tg.rows[0].chat_id, "555")
  assert.match(tg.rows[0].payload.text, /晚霞/)
  await db.insert(schema.channelInbound).values({
    channel: "telegram", eventKey: "g1:1", externalId: "555", text: "在吗",
    context: { trusted: true, agentId, ownerId },
  })
  await run(["在呀"])
  assert.equal((await pool.query("SELECT 1 FROM telegram_outbox")).rowCount, 2)

  // ───────────────────────── management API ─────────────────────────
  await channelAction(ownerId, agentId, { action: "configure", channel: "qq", values: { appId: "1020304050", appSecret: "never-shown-secret-value" } })
  const status = await channelStatus(ownerId, agentId)
  const dump = JSON.stringify(status)
  for (const hidden of ["never-shown-secret-value", secret, relayKey, "BOT-TOKEN", "oa-secret", oaToken, aesKey])
    assert.ok(!dump.includes(hidden), "status must not expose secrets")
  assert.equal(status.channels.qq.linked, true)
  assert.equal(status.channels.qq.configured, true)
  assert.equal(status.channels.wechat_oa.encrypted, true)
  assert.equal(status.channels.wechat.connected, true)
  await assert.rejects(
    channelAction(ownerId, agentId, { action: "configure", channel: "relay", values: { url: "ftp://x" } })
  )
  await assert.rejects(
    channelAction(ownerId, agentId, { action: "configure", channel: "qq", values: { nope: "x" } })
  )
  assert.equal((await channelAction(ownerId, agentId, { action: "unbind", channel: "qq" }) as { unbound: boolean }).unbound, true)
  assert.equal(await linkOf("qq"), undefined)
  await channelAction(ownerId, agentId, { action: "wechat-disconnect" })
  assert.equal(await linkOf("wechat"), undefined)

  // One person, one memory: every channel wrote into the same history
  const channelsSeen = new Set((await db.select().from(schema.companionMessages)).map((m) => m.channel))
  assert.deepEqual([...channelsSeen].sort(), ["qq", "telegram", "web", "wechat", "wechat_oa"].filter((c) => channelsSeen.has(c)))
  assert.ok(channelsSeen.has("qq") && channelsSeen.has("wechat") && channelsSeen.has("telegram"))

  await closeDurableClient()
  await pool.end()
  passed = true
  console.log("channels integration passed")
} finally {
  for (const server of servers) server.close()
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  if (!passed) process.exitCode = 1
}
