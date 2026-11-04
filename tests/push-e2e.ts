// Web Push end to end in a real browser, through a REAL push service: Google Chrome (persistent,
// non-incognito profile) subscribes through the settings page, Google's FCM carries the push, the
// service worker shows the notification. Needs the dev server (6797) and the worker running, the
// VAPID keys in .env (npm run push:keys), Google Chrome installed and internet access.
//
// What the harness does, not the app: the notification permission is pre-granted (a headless
// browser cannot answer the prompt), the background messages are inserted into the dev database
// (the same rows the worker writes for a share / errand result), and the notifications are read
// back with ServiceWorkerRegistration.getNotifications() because a headless browser has no
// notification shelf to look at. Everything the test changes is restored at the end.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import pg from "pg"
import { chromium, type Page } from "playwright"
import { env } from "@/lib/env"

assert.ok(env.VAPID_PUBLIC_KEY, "run `npm run push:keys` first")
const credentials = JSON.parse(await readFile("data/dev-owner.json", "utf8"))
const shots = path.resolve(
  process.env.PUSH_SHOTS ?? path.join("data/experiments", `push-e2e-${Date.now()}`)
)
await mkdir(shots, { recursive: true })
const origin = env.APP_URL
const db = new pg.Client({ connectionString: env.DATABASE_URL })
await db.connect()
const {
  rows: [saved],
} = await db.query(
  "SELECT agent_id,quiet_start,quiet_end,rhythm,push_preview,web_seen_at FROM companions LIMIT 1"
)
assert.ok(saved, "the dev database has a companion")
const agentId: string = saved.agent_id
const {
  rows: [{ name: agentName }],
} = await db.query("SELECT name FROM agents WHERE id=$1", [agentId])
const inserted: string[] = []
const profile = await mkdtemp(path.join(os.tmpdir(), "owndesk-push-profile-"))
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: !process.env.PUSH_HEADED,
  viewport: { width: 900, height: 1000 },
})
const errors: string[] = []
let passed = false
// The notification settings box, not the whole long settings page
const snap = (page: Page, name: string) =>
  page
    .locator("fieldset", { hasText: "手机 / 浏览器通知" })
    .screenshot({ path: path.join(shots, `${name}.png`) })
// PUSH_HEADED=1 runs a visible Chrome on the box desktop (DISPLAY) so the notification the browser
// puts on screen can be photographed: a picture of the desktop, taken with PIL
const desktopShot = (name: string) => {
  if (!process.env.PUSH_HEADED) return
  execFileSync("python3", [
    "-c",
    `from PIL import ImageGrab; ImageGrab.grab(xdisplay="${process.env.DISPLAY ?? ":0"}").save(${JSON.stringify(path.join(shots, `${name}.png`))})`,
  ])
}

// A page that is not the chat page, so it sends no "I am looking" heartbeat of its own
const notifications = async (): Promise<
  { title: string; body: string; url: string; tag: string }[]
> => {
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/offline.html`)
    return (await page.evaluate(`(async () => {
      const registration = await navigator.serviceWorker.ready
      const list = await registration.getNotifications()
      return list.map((n) => ({ title: n.title, body: n.body, url: n.data && n.data.url, tag: n.tag }))
    })()`)) as never
  } finally {
    await page.close()
  }
}
const waitForNotification = async (
  match: (n: { body: string; tag: string }) => boolean,
  seconds: number
) => {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const found = (await notifications()).find(match)
    if (found) return found
    if (Date.now() > deadline) throw new Error("no notification arrived in time")
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
const addMessage = async (id: string, kind: string, content: string) => {
  inserted.push(id)
  await db.query(
    "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at) VALUES($1,$2,'assistant',$3,$4,'web',now())",
    [id, agentId, kind, content]
  )
}
const deliveryOf = async (id: string) =>
  (
    await db.query(
      "SELECT status,reason,devices FROM push_deliveries WHERE message_id=$1",
      [id]
    )
  ).rows[0]
// The chat page is closed: the last heartbeat is old
const awayFromChat = () =>
  db.query(
    "UPDATE companions SET web_seen_at=now()-interval '10 minutes' WHERE agent_id=$1",
    [agentId]
  )
const stamp = Date.now().toString(36)

try {
  await context.grantPermissions(["notifications"], { origin })
  // not in quiet hours or asleep for the duration of the test (restored below)
  await db.query(
    "UPDATE companions SET quiet_start='00:00',quiet_end='00:00',rhythm=$2::jsonb,push_preview=true WHERE agent_id=$1",
    [
      agentId,
      JSON.stringify({ sleep: { start: "00:00", end: "00:00" }, nap: null, away: [] }),
    ]
  )
  await db.query("DELETE FROM push_subscriptions WHERE agent_id=$1", [agentId])

  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${origin}/login`)
  await page.getByLabel("邮箱").fill(credentials.email)
  await page.getByLabel("密码").fill(credentials.password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"))
  await page.goto(`${origin}/companion`)
  await page.getByPlaceholder("发消息").waitFor()
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByText("手机 / 浏览器通知").waitFor()
  await page.getByText("这台设备未开").waitFor()
  await snap(page, "01-settings-before")

  // 1. subscribe through the page: real FCM registration
  await page.getByRole("button", { name: "开启通知" }).click()
  await page.getByText("这台设备已开").waitFor({ timeout: 30_000 })
  await page.getByText("通知开好了").waitFor()
  const devices = await page.evaluate(
    async () =>
      (await (await fetch("/api/companion/push")).json()) as {
        devices: { endpoint: string; label: string }[]
      }
  )
  assert.equal(devices.devices.length, 1)
  const host = new URL(devices.devices[0].endpoint).hostname
  assert.match(
    host,
    /google\.com$|googleapis\.com$/,
    `a real Google push service address, got ${host}`
  )
  assert.match(devices.devices[0].label, /Chrome/)
  console.log(`subscribed through the real push service (${host})`)

  // 2. the test button goes through the same path and arrives
  await page.getByRole("button", { name: "发一条测试通知" }).click()
  await page.getByText(/已发出（1 台设备）/).waitFor({ timeout: 60_000 })
  const test = await waitForNotification((n) => n.body === "收到啦，通知是开着的", 30)
  assert.equal(test.title, agentName)
  assert.equal(test.url, "/companion")
  await snap(page, "02-settings-enabled")
  console.log("test notification received")

  // 3. she writes while the page is closed: the worker sends it with a preview
  await page.close()
  await awayFromChat()
  const share1 = `push-e2e-${stamp}-1`
  await addMessage(share1, "share", `我刚路过一家很香的面包店 ${stamp}`)
  const first = await waitForNotification((n) => n.tag === `msg-${share1}`, 90)
  assert.equal(first.title, agentName)
  assert.equal(first.body, `我刚路过一家很香的面包店 ${stamp}`)
  assert.equal(first.url, "/companion")
  await new Promise((resolve) => setTimeout(resolve, 1500))
  desktopShot("05-desktop-notification")
  assert.deepEqual(await deliveryOf(share1), { status: "sent", reason: null, devices: 1 })
  console.log("proactive share notified with preview")

  // 4. preview off in the settings page: only the plain notice
  const page2 = await context.newPage()
  await page2.goto(`${origin}/companion`)
  await page2.getByRole("button", { name: "设置", exact: true }).click()
  await page2.getByLabel(/通知里显示她说的那句话/).uncheck()
  await page2.waitForFunction(
    async () => (await (await fetch("/api/companion")).json()).pushPreview === false
  )
  await snap(page2, "03-settings-preview-off")
  await page2.close()
  await awayFromChat()
  const share2 = `push-e2e-${stamp}-2`
  await addMessage(share2, "errand_update", "秘密的内容：体检报告已经整理好了")
  const second = await waitForNotification((n) => n.tag === `msg-${share2}`, 90)
  assert.equal(second.body, "发来一条消息")
  assert.ok(!JSON.stringify(second).includes("体检"))
  console.log("preview off: the words stay out of the notification")

  // 5. the chat page is open: nothing is sent for it
  const page3 = await context.newPage()
  await page3.goto(`${origin}/companion`)
  await page3.getByPlaceholder("发消息").waitFor()
  const share3 = `push-e2e-${stamp}-3`
  await addMessage(share3, "share", "这条你正在看着，不该弹通知")
  const deadline = Date.now() + 90_000
  let third = await deliveryOf(share3)
  while (!third && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    third = await deliveryOf(share3)
  }
  assert.equal(third?.status, "skipped", "the worker looked at it and skipped it")
  assert.match(third.reason, /seen|viewing/)
  assert.ok(!(await notifications()).some((n) => n.tag === `msg-${share3}`))
  await page3.close()
  console.log("page open: no notification")

  // 6. turning it off removes the device; a later message does not notify
  const page4 = await context.newPage()
  await page4.goto(`${origin}/companion`)
  await page4.getByRole("button", { name: "设置", exact: true }).click()
  await page4.getByRole("button", { name: "关闭这台设备的通知" }).click()
  await page4.getByText("这台设备未开").waitFor()
  const left = await page4.evaluate(
    async () => (await (await fetch("/api/companion/push")).json()).devices.length
  )
  assert.equal(left, 0)
  assert.equal(
    await page4.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      return (await registration.pushManager.getSubscription()) === null
    }),
    true
  )
  await snap(page4, "04-settings-off")
  await page4.close()
  assert.deepEqual(errors, [])
  console.log("push e2e passed; screenshots in " + shots)
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await db.query(
    "UPDATE companions SET quiet_start=$2,quiet_end=$3,rhythm=$4::jsonb,push_preview=$5,web_seen_at=$6 WHERE agent_id=$1",
    [
      agentId,
      saved.quiet_start,
      saved.quiet_end,
      JSON.stringify(saved.rhythm),
      saved.push_preview,
      saved.web_seen_at,
    ]
  )
  if (inserted.length)
    await db.query("DELETE FROM companion_messages WHERE id = ANY($1)", [inserted])
  await db.query("DELETE FROM push_subscriptions WHERE agent_id=$1", [agentId])
  await context.close().catch(() => undefined)
  await rm(profile, { recursive: true, force: true })
  await db.end()
  process.exit(passed ? 0 : 1)
}
