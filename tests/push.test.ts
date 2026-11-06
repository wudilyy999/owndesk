import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import {
  PUSH_EXPIRY_MS,
  QUIET_EXPIRY_MS,
  VIEWING_MS,
  buildPayload,
  checkEndpoint,
  decidePush,
  deviceLabel,
  previewLine,
} from "@/lib/companion/push"
import { companionSettingsSchema } from "@/lib/companion/persona"
import { generateVapidKeys } from "../scripts/vapid-keys.mjs"

const NOON = new Date("2026-11-05T12:00:00+08:00")
const companion = {
  quietStart: "23:00",
  quietEnd: "08:00",
  timeZone: "Asia/Taipei",
  rhythm: { sleep: { start: "23:30", end: "07:30" }, nap: null, away: [] },
  webSeenAt: null as Date | null,
}
const ago = (ms: number, from = NOON) => new Date(from.getTime() - ms)

test("the preview is one short line without links, and hidden text is a plain notice", () => {
  assert.equal(
    previewLine("今天路过一家店\n看到这个 https://example.com/x?a=1  想给你看"),
    "今天路过一家店 看到这个 想给你看"
  )
  const long = previewLine("好".repeat(100))
  assert.equal([...long].length, 61)
  assert.ok(long.endsWith("…"))
  const message = {
    id: "m1",
    kind: "share" as const,
    content: "我刚读到一篇有意思的文章",
  }
  assert.deepEqual(buildPayload("小满", [message], true), {
    title: "小满",
    body: "我刚读到一篇有意思的文章",
    url: "/companion",
    tag: "msg-m1",
  })
  const hidden = buildPayload("小满", [message], false)
  assert.equal(hidden.body, "发来一条消息")
  assert.ok(!JSON.stringify(hidden).includes("文章"))
  const two = [message, { id: "m2", kind: "share" as const, content: "还有这个" }]
  assert.equal(buildPayload("小满", two, true).body, "[2条] 还有这个")
  assert.equal(buildPayload("小满", two, false).body, "发来 2 条消息")
  assert.equal(buildPayload("小满", two, true).tag, "msg-m2")
})

test("push decisions: send, hold in quiet hours, skip when seen or looking, expire", () => {
  const at = (createdAt: Date, now = NOON, seen: Date | null = null) =>
    decidePush({
      now,
      message: { createdAt },
      companion: { ...companion, webSeenAt: seen },
    })
  assert.deepEqual(at(ago(60_000)), { action: "send" })
  // the page was opened after the message arrived: she was read already
  assert.deepEqual(at(ago(60_000), NOON, ago(10_000)), { action: "skip", reason: "seen" })
  // the page was last open before the message, so it is not being looked at: send
  assert.deepEqual(at(ago(60_000), NOON, ago(120_000)), { action: "send" })
  // viewing: the heartbeat is fresh even if the message is older than it
  assert.deepEqual(at(ago(5 * 60_000), NOON, ago(VIEWING_MS - 1)), {
    action: "skip",
    reason: "seen",
  })
  assert.deepEqual(at(ago(PUSH_EXPIRY_MS + 1)), { action: "skip", reason: "expired" })
  // quiet hours 23:00-08:00 and sleep: held, then dropped after six hours
  const night = new Date("2026-11-05T02:00:00+08:00")
  assert.deepEqual(at(ago(60_000, night), night), { action: "wait" })
  assert.deepEqual(at(ago(QUIET_EXPIRY_MS + 1, night), night), {
    action: "skip",
    reason: "quiet",
  })
  // outside quiet hours but she is napping/away is not a reason to hold a notification
  const nap = decidePush({
    now: NOON,
    message: { createdAt: ago(60_000) },
    companion: {
      ...companion,
      rhythm: {
        sleep: { start: "23:30", end: "07:30" },
        nap: { start: "11:00", end: "13:00" },
        away: [],
      },
    },
  })
  assert.deepEqual(nap, { action: "send" })
  // her sleep time inside the person's non-quiet hours also holds it
  const sleepy = decidePush({
    now: NOON,
    message: { createdAt: ago(60_000) },
    companion: {
      ...companion,
      quietStart: "00:00",
      quietEnd: "00:00",
      rhythm: { sleep: { start: "11:30", end: "13:30" }, nap: null, away: [] },
    },
  })
  assert.deepEqual(sleepy, { action: "wait" })
})

test("only public https push addresses are accepted", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc",
  ])
    assert.equal(checkEndpoint(ok), ok)
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://[::1]/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://intranet/x",
    "https://user:pw@fcm.googleapis.com/x",
    "not a url",
  ])
    assert.throws(() => checkEndpoint(bad), bad)
})

test("device labels never contain the push address", () => {
  assert.equal(
    deviceLabel(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36"
    ),
    "Chrome · Linux"
  )
  assert.equal(
    deviceLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Version/18.0 Mobile Safari/604.1"
    ),
    "Safari · iPhone/iPad"
  )
  assert.equal(deviceLabel(null), "浏览器")
})

test("generated VAPID keys are a valid P-256 pair that pushforge accepts, and differ each time", async () => {
  const { buildPushHTTPRequest } = await import("@pushforge/builder")
  const { vapidToPrivateJwk } = await import("@/lib/companion/vapid-jwk")
  const keys = generateVapidKeys()
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65)
  assert.equal(Buffer.from(keys.publicKey, "base64url")[0], 4)
  assert.equal(Buffer.from(keys.privateKey, "base64url").length, 32)
  // A second keypair supplies a plausible subscriber public key (65-byte uncompressed).
  const subscriber = generateVapidKeys()
  const built = await buildPushHTTPRequest({
    privateJWK: vapidToPrivateJwk(keys.publicKey, keys.privateKey),
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
      keys: {
        p256dh: subscriber.publicKey,
        auth: Buffer.alloc(16, 7).toString("base64url"),
      },
    },
    message: {
      payload: { title: "t", body: "b" },
      adminContact: "mailto:test@example.com",
      options: { ttl: 3600, urgency: "normal" },
    },
  })
  const auth =
    built.headers instanceof Headers
      ? built.headers.get("Authorization")
      : (built.headers as Record<string, string>).Authorization
  assert.match(auth ?? "", /^vapid t=/)
  assert.notEqual(generateVapidKeys().privateKey, keys.privateKey)
})

test("npm run push:keys writes the pair to a private .env once and never prints it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owndesk-push-"))
  try {
    const file = path.join(directory, ".env")
    await writeFile(file, "APP_URL=http://localhost:6797\n", { mode: 0o600 })
    const run = () =>
      execFileSync(process.execPath, ["scripts/push-keys.mjs", file], {
        encoding: "utf8",
      })
    const first = run()
    const text = await readFile(file, "utf8")
    const pub = /^VAPID_PUBLIC_KEY=(\S+)$/m.exec(text)![1]
    const priv = /^VAPID_PRIVATE_KEY=(\S+)$/m.exec(text)![1]
    assert.ok(text.startsWith("APP_URL=http://localhost:6797\n"))
    assert.ok(!first.includes(pub) && !first.includes(priv))
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const second = run()
    assert.match(second, /unchanged/)
    assert.equal(await readFile(file, "utf8"), text)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("the notification preview switch is a setting, and no secret leaves the server", async () => {
  assert.equal(companionSettingsSchema.parse({ pushPreview: false }).pushPreview, false)
  assert.throws(() => companionSettingsSchema.parse({ pushPreview: "no" }))
  const route = await readFile("app/api/companion/push/route.ts", "utf8")
  assert.ok(
    !/privateKey/.test(route.replace(/\/\/.*$/gm, "")),
    "the route never reads the private key"
  )
  assert.match(route, /requireSameOrigin/)
  const component = await readFile("components/companion-push.tsx", "utf8")
  assert.ok(!/VAPID_PRIVATE|privateKey/.test(component))
})

// Runs public/sw.js in a sandbox with a fake service worker scope
function loadWorker() {
  const listeners: Record<string, (event: unknown) => void> = {}
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const calls: string[] = []
  let windows: {
    url: string
    focus: () => Promise<void>
    navigate?: (url: string) => Promise<void>
  }[] = []
  const self = {
    location: { origin: "https://owndesk.example" },
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      (listeners[name] = handler),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        calls.push(`open ${url}`)
      },
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
  }
  return readFile("public/sw.js", "utf8").then((source) => {
    vm.runInNewContext(source, {
      self,
      URL,
      caches: {},
      fetch: async () => undefined,
      console,
    })
    return {
      shown,
      calls,
      setWindows: (list: typeof windows) => (windows = list),
      push: async (data: unknown) => {
        let waited: Promise<unknown> = Promise.resolve()
        listeners.push({
          data:
            data === undefined
              ? null
              : { json: () => (typeof data === "string" ? JSON.parse(data) : data) },
          waitUntil: (promise: Promise<unknown>) => (waited = promise),
        })
        await waited
      },
      click: async (url?: string) => {
        let waited: Promise<unknown> = Promise.resolve()
        let closed = false
        listeners.notificationclick({
          notification: { close: () => (closed = true), data: url ? { url } : undefined },
          waitUntil: (promise: Promise<unknown>) => (waited = promise),
        })
        await waited
        return closed
      },
    }
  })
}

test("the service worker always shows what it receives, even a broken or empty payload", async () => {
  const sw = await loadWorker()
  await sw.push({ title: "小满", body: "在吗", url: "/companion", tag: "msg-1" })
  assert.equal(sw.shown[0].title, "小满")
  assert.equal(sw.shown[0].options.body, "在吗")
  assert.equal(sw.shown[0].options.tag, "msg-1")
  assert.equal(JSON.stringify(sw.shown[0].options.data), '{"url":"/companion"}')
  await sw.push("not json {")
  await sw.push(undefined)
  assert.equal(
    sw.shown.length,
    3,
    "every push shows a notification: Safari revokes the permission otherwise"
  )
  assert.equal(sw.shown[2].options.body, "发来一条消息")
  // an address outside this site is never opened from a notification
  await sw.push({ title: "x", body: "y", url: "https://evil.example/" })
  assert.equal(JSON.stringify(sw.shown[3].options.data), '{"url":"/companion"}')
})

test("tapping a notification opens the chat: the open window if there is one", async () => {
  const sw = await loadWorker()
  assert.equal(await sw.click("/companion"), true)
  assert.deepEqual(sw.calls, ["open https://owndesk.example/companion"])
  const events: string[] = []
  sw.setWindows([
    { url: "https://other.example/", focus: async () => void events.push("other") },
    {
      url: "https://owndesk.example/settings",
      focus: async () => void events.push("focus"),
      navigate: async (url) => void events.push(`navigate ${url}`),
    },
  ])
  await sw.click("/companion")
  assert.deepEqual(events, ["focus", "navigate https://owndesk.example/companion"])
  assert.deepEqual(sw.calls.length, 1, "no second window was opened")
})
