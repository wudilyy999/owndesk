// Web Push against a throwaway database with a fake push sender: subscriptions, which messages
// notify, quiet hours, "page is open", batching, preview off, gone devices, retries.
// The real push service round trip is tests/push-e2e.ts.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { generateVapidKeys } from "../scripts/vapid-keys.mjs"

process.loadEnvFile(".env")
const database = `agent_push_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
const keys = generateVapidKeys()
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "push@fixture.test",
  OWNER_PASSWORD: randomUUID(),
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
})
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)

  const { pool } = await import("@/db")
  const push = await import("@/lib/companion/push")
  const { ensureCompanion, updateCompanion } = await import("@/lib/companion/store")

  const ownerId = "push-owner"
  const agentId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [ownerId]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
    [agentId]
  )
  await ensureCompanion(ownerId, agentId, "Asia/Taipei")
  // Quiet hours and her sleep far away from "now" unless a case moves them
  await updateCompanion(ownerId, agentId, {
    quietStart: "03:00",
    quietEnd: "03:01",
    rhythm: { sleep: { start: "03:00", end: "03:01" }, nap: null, away: [] },
  } as never)

  const A = "https://push.example.test/send/AAAA"
  const B = "https://push.example.test/send/BBBB"
  const key = (n: string) => ({
    p256dh: `B${n.repeat(86)}`.slice(0, 87),
    auth: n.repeat(22),
  })
  const sent: { endpoint: string; payload: Record<string, string> }[] = []
  let failWith: Record<string, number | "network"> = {}
  const sender: import("@/lib/companion/push").PushSender = async (sub, payload) => {
    const failure = failWith[sub.endpoint]
    if (failure === "network") throw new Error("socket hang up")
    if (failure)
      throw Object.assign(new Error("push service says no"), { statusCode: failure })
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) })
    return { statusCode: 201 }
  }
  const message = async (
    id: string,
    kind: string,
    content: string,
    createdAt: Date,
    extra = ""
  ) =>
    pool.query(
      `INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at${extra ? ",superseded_at" : ""}) VALUES($1,$2,'assistant',$3,$4,'web',$5${extra ? ",now()" : ""})`,
      [id, agentId, kind, content, createdAt]
    )
  const delivery = async (id: string) =>
    (
      await pool.query(
        "SELECT status,reason,devices FROM push_deliveries WHERE message_id=$1",
        [id]
      )
    ).rows[0]
  const minutes = (n: number, from = new Date()) => new Date(from.getTime() - n * 60_000)

  // no subscriptions: nothing happens, and the module reports itself configured
  assert.ok(push.pushConfig())
  assert.deepEqual(await push.pushTick(new Date(), sender), [])
  await assert.rejects(push.sendTestPush(agentId, "小满", true, sender), /No device/)

  // subscriptions: stored once per endpoint, re-subscribing updates the keys, bad addresses refused
  const first = await push.saveSubscription(
    agentId,
    { endpoint: A, keys: key("a") },
    "Mozilla/5.0 (X11; Linux) Chrome/156 Safari/537"
  )
  await push.saveSubscription(agentId, { endpoint: A, keys: key("c") }, null)
  assert.equal((await push.listSubscriptions(agentId)).length, 1)
  assert.equal((await push.listSubscriptions(agentId))[0].p256dh, key("c").p256dh)
  assert.equal(first.id, (await push.listSubscriptions(agentId))[0].id)
  await assert.rejects(
    push.saveSubscription(
      agentId,
      { endpoint: "https://127.0.0.1/x", keys: key("a") },
      null
    ),
    /public https/
  )
  await push.saveSubscription(
    agentId,
    { endpoint: B, keys: key("b") },
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604"
  )
  assert.equal((await push.listSubscriptions(agentId)).length, 2)
  assert.equal(await push.removeSubscription(agentId, B), 1)
  assert.equal(await push.removeSubscription(agentId, B), 0)
  assert.equal(await push.removeSubscription("someone-else", A), 0)

  // a message from before the device was added never notifies; her chat replies never do
  const now = new Date()
  await message("old", "share", "以前的", minutes(60, now))
  await pool.query("UPDATE push_subscriptions SET created_at=$1", [minutes(30, now)])
  await message("chat1", "chat", "你好呀", minutes(5, now))
  await message(
    "share1",
    "share",
    "我刚读到一篇文章 https://example.com/a\n很有意思",
    minutes(5, now)
  )
  await message("hidden", "share", "没显示出来的", minutes(5, now))
  await pool.query(
    "UPDATE companion_messages SET reveal_at=now()+interval '1 hour' WHERE id='hidden'"
  )
  await message("replaced", "share", "被重说替换的", minutes(5, now), "x")
  let result = await push.pushTick(now, sender)
  assert.deepEqual(
    result.map((r) => [r.sent, r.skipped, r.devices]),
    [[1, 0, 1]]
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0].endpoint, A)
  assert.deepEqual(sent[0].payload, {
    title: "小满",
    body: "我刚读到一篇文章 很有意思",
    url: "/companion",
    tag: "msg-share1",
  })
  assert.deepEqual(await delivery("share1"), { status: "sent", reason: null, devices: 1 })
  for (const id of ["old", "chat1", "hidden", "replaced"])
    assert.equal(await delivery(id), undefined, id)
  // sent once: the next tick does nothing
  await push.pushTick(now, sender)
  assert.equal(sent.length, 1)

  // preview off: the words of her message are not in the payload at all
  await updateCompanion(ownerId, agentId, { pushPreview: false } as never)
  await message("share2", "errand_update", "我把表格整理好了，放在桌面", minutes(1, now))
  await push.pushTick(now, sender)
  assert.equal(sent[1].payload.body, "发来一条消息")
  assert.ok(!JSON.stringify(sent[1]).includes("表格"))
  await updateCompanion(ownerId, agentId, { pushPreview: true } as never)

  // page open now / opened after the message: no notification, and the reason is recorded
  await push.recordSeen(agentId, now)
  await message("share3", "coview", "这一段太好笑了", minutes(0, now))
  await push.pushTick(new Date(now.getTime() + 5_000), sender)
  assert.equal(sent.length, 2)
  assert.equal((await delivery("share3")).status, "skipped")
  assert.match((await delivery("share3")).reason, /seen|viewing/)
  // the page closed a while ago and a new message arrives: notifies again
  const later = new Date(now.getTime() + 10 * 60_000)
  await message("share4", "share", "晚上好", minutes(1, later))
  await push.pushTick(later, sender)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].payload.body, "晚上好")

  // several waiting at once become one notification and each is recorded
  const t1 = new Date(later.getTime() + 20 * 60_000)
  await message("m1", "share", "第一条", minutes(3, t1))
  await message("m2", "share", "第二条", minutes(2, t1))
  result = await push.pushTick(t1, sender)
  assert.equal(sent.length, 4)
  assert.equal(sent[3].payload.body, "[2条] 第二条")
  assert.equal((await delivery("m1")).status, "sent")
  assert.equal((await delivery("m2")).status, "sent")

  // quiet hours hold it back, then it goes out once they end; very old ones are dropped
  await updateCompanion(ownerId, agentId, {
    quietStart: "00:00",
    quietEnd: "23:59",
  } as never)
  const t2 = new Date(t1.getTime() + 20 * 60_000)
  await message("q1", "share", "夜里想到的", minutes(2, t2))
  await push.pushTick(t2, sender)
  assert.equal(sent.length, 4)
  assert.equal(await delivery("q1"), undefined, "held, not dropped")
  await updateCompanion(ownerId, agentId, {
    quietStart: "03:00",
    quietEnd: "03:01",
  } as never)
  await push.pushTick(new Date(t2.getTime() + 60_000), sender)
  assert.equal(sent.length, 5)
  assert.equal(sent[4].payload.body, "夜里想到的")
  await updateCompanion(ownerId, agentId, {
    quietStart: "00:00",
    quietEnd: "23:59",
  } as never)
  const t3 = new Date(t2.getTime() + 8 * 3600_000)
  await message("q2", "share", "太久以前的", new Date(t3.getTime() - 7 * 3600_000))
  await push.pushTick(t3, sender)
  assert.deepEqual(await delivery("q2"), {
    status: "skipped",
    reason: "quiet",
    devices: 0,
  })
  await updateCompanion(ownerId, agentId, {
    quietStart: "03:00",
    quietEnd: "03:01",
  } as never)

  // a transient failure keeps the message for the next tick; a device that is gone is removed
  const t4 = new Date(t3.getTime() + 20 * 60_000)
  await message("f1", "share", "重试一下", minutes(1, t4))
  failWith = { [A]: "network" }
  await push.pushTick(t4, sender)
  assert.equal(await delivery("f1"), undefined)
  assert.equal((await push.listSubscriptions(agentId))[0].failures, 1)
  failWith = {}
  await push.pushTick(new Date(t4.getTime() + 30_000), sender)
  assert.equal((await delivery("f1")).status, "sent")
  assert.equal((await push.listSubscriptions(agentId))[0].failures, 0)
  const t5 = new Date(t4.getTime() + 20 * 60_000)
  await message("g1", "share", "设备失效", minutes(1, t5))
  failWith = { [A]: 410 }
  await push.pushTick(t5, sender)
  assert.equal(
    (await push.listSubscriptions(agentId)).length,
    0,
    "410 Gone removes the device"
  )
  assert.equal((await delivery("g1")).status, "skipped")
  // a device added moments ago is not thrown away for "gone": the push service may not know it yet
  await push.saveSubscription(agentId, { endpoint: A, keys: key("a") }, null)
  failWith = { [A]: 410 }
  await push.sendTestPush(agentId, "小满", true, sender)
  const fresh = await push.listSubscriptions(agentId)
  assert.equal(fresh.length, 1, "a new device survives one 'gone' answer")
  assert.equal(fresh[0].failures, 1)
  await pool.query("DELETE FROM push_subscriptions WHERE agent_id=$1", [agentId])
  // repeated failures remove a device that never recovers
  await push.saveSubscription(agentId, { endpoint: A, keys: key("a") }, null)
  failWith = { [A]: 500 }
  for (let i = 0; i < push.MAX_FAILURES; i++)
    await push.sendTestPush(agentId, "小满", true, sender).catch(() => undefined)
  // test pushes count as failures too; the device is gone after the limit
  assert.equal((await push.listSubscriptions(agentId)).length, 0)

  // the test button: reaches every device, even with the page open
  failWith = {}
  await push.saveSubscription(agentId, { endpoint: A, keys: key("a") }, null)
  await push.saveSubscription(agentId, { endpoint: B, keys: key("b") }, null)
  const before = sent.length
  assert.deepEqual(await push.sendTestPush(agentId, "小满", true, sender), {
    sent: 2,
    gone: 0,
    failed: 0,
  })
  assert.equal(sent.length, before + 2)
  assert.equal(sent[before].payload.body, "收到啦，通知是开着的")
  await push.sendTestPush(agentId, "小满", false, sender)
  assert.equal(sent[before + 2].payload.body, "发来一条消息")

  // deleting the companion's messages or agent cleans up after itself
  await pool.query("DELETE FROM agents WHERE id=$1", [agentId])
  assert.equal((await pool.query("SELECT 1 FROM push_subscriptions")).rowCount, 0)
  assert.equal((await pool.query("SELECT 1 FROM push_deliveries")).rowCount, 0)

  await pool.end()
  console.log("web push integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
