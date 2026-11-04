import assert from "node:assert/strict"
import test from "node:test"
import { crisisReply, detectCrisis, regionOf } from "@/lib/companion/crisis"
import {
  buildCompanionPrompt,
  companionSettingsSchema,
  defaultPersona,
} from "@/lib/companion/persona"
import {
  extractLink,
  isPrivateAddress,
  isPublicUrl,
  linkIsOpenable,
} from "@/lib/companion/coview"
import { splitBubbles, historyMessages } from "@/lib/companion/chat"
import { resolveModeChange } from "@/lib/companion/store"
import {
  decideShare,
  dueLifeSlots,
  inQuietHours,
  lifeBudgetForSession,
  rhythmAt,
} from "@/lib/companion/rules"
import { linkResolves, lifePathAllowed } from "@/worker/life"
import { toolsForTask } from "@/lib/agent/tools"
import { defaultRhythm, type CompanionMessage } from "@/db/schema"

const context = {
  name: "小满",
  persona: defaultPersona,
  mode: "friend" as const,
  now: "2026-11-01T05:00:00Z",
  timeZone: "Asia/Taipei",
  rhythm: { state: "online" as const, label: null },
  link: null,
  memories: [{ id: "n1", content: "生日是12月15日" }],
  recentLife: [
    {
      kind: "read",
      title: "一篇关于咖啡的文章",
      summary: "写了手冲",
      url: "https://example.com/coffee",
      at: "11月1日 10:30",
    },
  ],
}

test("crisis wording is detected in Chinese and English, ordinary talk is not", () => {
  for (const text of [
    "我不想活了",
    "最近总想自杀",
    "I want to die",
    "thinking about suicide",
  ])
    assert.equal(detectCrisis(text), true, text)
  for (const text of ["今天好累", "这个bug快把我杀了", "我想死记硬背这些单词不太行"])
    assert.equal(detectCrisis(text), false, text)
})

test("crisis reply names hotlines for the person's region and no persona text", () => {
  assert.match(crisisReply("Asia/Taipei"), /1925/)
  assert.match(crisisReply("Asia/Taipei"), /1995/)
  assert.match(crisisReply("Asia/Shanghai"), /12356/)
  assert.match(crisisReply("America/New_York"), /988/)
  assert.match(crisisReply("Europe/Paris"), /findahelpline/)
  assert.equal(regionOf("Asia/Hong_Kong"), "OTHER")
})

test("persona prompt: real-person tone, one honesty rule, no AI repetition, memory notes and life log", () => {
  const prompt = buildCompanionPrompt(context)
  assert.match(prompt, /你是小满/)
  assert.match(prompt, /- 生日是12月15日/)
  assert.match(prompt, /https:\/\/example\.com\/coffee/)
  assert.match(prompt, /如实回答，不撒谎/)
  assert.match(prompt, /propose_errand/)
  assert.equal(/人工智能|AI助手|作为AI|语言模型/.test(prompt), false)
  assert.match(prompt, /朋友/)
  const partner = buildCompanionPrompt({ ...context, mode: "partner" })
  assert.match(partner, /恋人/)
  assert.match(partner, /不控制对方/)
})

test("partner mode needs an 18+ confirmation, once given it stays", () => {
  const now = new Date("2026-11-01T00:00:00Z")
  assert.throws(
    () =>
      resolveModeChange({ mode: "friend", adultConfirmedAt: null }, { mode: "partner" }),
    /18/
  )
  const confirmed = resolveModeChange(
    { mode: "friend", adultConfirmedAt: null },
    { mode: "partner", adultConfirmed: true },
    now
  )
  assert.equal(confirmed.mode, "partner")
  assert.equal(confirmed.adultConfirmedAt, now)
  const back = resolveModeChange(
    { mode: "partner", adultConfirmedAt: now },
    { mode: "friend" }
  )
  assert.equal(back.adultConfirmedAt, now)
  assert.equal(
    resolveModeChange({ mode: "friend", adultConfirmedAt: now }, { mode: "partner" })
      .mode,
    "partner"
  )
})

test("replies split into at most four bubbles; errand cards reach the model as text", () => {
  assert.deepEqual(splitBubbles("a\n\nb\n\n\nc"), ["a", "b", "c"])
  assert.equal(splitBubbles("1\n\n2\n\n3\n\n4\n\n5\n\n6").length, 4)
  assert.deepEqual(splitBubbles("  \n\n "), [])
  const rows = [
    {
      role: "assistant",
      kind: "errand_proposal",
      content: "x",
      metadata: { goal: "查票价" },
    },
    { role: "user", kind: "chat", content: "好", metadata: null },
  ] as CompanionMessage[]
  assert.match(String(historyMessages(rows)[0].content), /查票价/)
})

test("the prompt carries the topic summaries and every unsorted note, nothing cut", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: `id${i}`,
    content: `第${i}条零散记忆${"x".repeat(100)}`,
  }))
  const prompt = buildCompanionPrompt({
    ...context,
    summaries: [{ topic: "饮食习惯", content: "爱喝冰美式" }],
    memories: many,
  })
  assert.match(prompt, /饮食习惯：爱喝冰美式/)
  for (const note of many) assert.ok(prompt.includes(note.content))
  assert.match(prompt, /recall_memory/)
})

test("life slots fire within two hours after their time, in the companion's zone", () => {
  const times = ["10:30", "20:30"]
  // 11:00 in Taipei = 03:00 UTC
  assert.deepEqual(dueLifeSlots(new Date("2026-11-01T03:00:00Z"), "Asia/Taipei", times), [
    { date: "2026-11-01", slot: "10:30" },
  ])
  assert.deepEqual(
    dueLifeSlots(new Date("2026-11-01T02:00:00Z"), "Asia/Taipei", times),
    []
  )
  // 14:00 Taipei: the 10:30 slot is stale
  assert.deepEqual(
    dueLifeSlots(new Date("2026-11-01T06:00:00Z"), "Asia/Taipei", times),
    []
  )
  // The same instant is the previous evening in New York
  assert.deepEqual(
    dueLifeSlots(new Date("2026-11-01T03:00:00Z"), "America/New_York", times),
    []
  )
})

test("quiet hours wrap midnight", () => {
  const at = (iso: string) => inQuietHours(new Date(iso), "Asia/Taipei", "23:00", "08:00")
  assert.equal(at("2026-11-01T15:30:00Z"), true) // 23:30
  assert.equal(at("2026-11-01T22:00:00Z"), true) // 06:00
  assert.equal(at("2026-11-01T02:00:00Z"), false) // 10:00
  assert.equal(inQuietHours(new Date(), "UTC", "09:00", "09:00"), false)
})

test("share gate: pause, daily limit, quiet hours, spacing, expiry", () => {
  const companion = {
    sharesPaused: false,
    maxSharesPerDay: 2,
    quietStart: "23:00",
    quietEnd: "08:00",
    timeZone: "Asia/Taipei",
    rhythm: defaultRhythm,
  }
  const now = new Date("2026-11-01T04:00:00Z") // 12:00 Taipei
  const base = {
    now,
    companion,
    createdAt: new Date("2026-11-01T02:00:00Z"),
    sentToday: 0,
    lastSentAt: null,
  }
  assert.deepEqual(decideShare(base), { send: true })
  assert.deepEqual(
    decideShare({ ...base, companion: { ...companion, sharesPaused: true } }),
    { send: false }
  )
  assert.deepEqual(decideShare({ ...base, sentToday: 2 }), { send: false })
  assert.deepEqual(
    decideShare({ ...base, lastSentAt: new Date("2026-11-01T03:00:00Z") }),
    { send: false }
  )
  assert.deepEqual(decideShare({ ...base, now: new Date("2026-11-01T16:00:00Z") }), {
    send: false,
  })
  assert.deepEqual(
    decideShare({ ...base, createdAt: new Date("2026-10-30T00:00:00Z") }),
    {
      send: false,
      skip: "expired",
    }
  )
})

test("daily life budget leaves the remainder to the next session and stops at zero", () => {
  const input = {
    sessionMaxSteps: 25,
    dailyBudgetMicros: 100_000,
    spentTodayMicros: 30_000,
  }
  assert.deepEqual(lifeBudgetForSession(input), { maxSteps: 25, maxCostMicros: 70_000 })
  assert.equal(lifeBudgetForSession({ ...input, spentTodayMicros: 100_000 }), null)
  assert.equal(
    lifeBudgetForSession({ ...input, dailyBudgetMicros: 0, spentTodayMicros: 0 }),
    null
  )
})

test("life sessions may touch only ~/Life", () => {
  for (const path of [
    "/home/agent/Life",
    "Life/diary/2026-11-01.md",
    "/home/agent/Life/a/../b",
  ])
    assert.equal(lifePathAllowed(path), true, path)
  for (const path of [
    "/etc/passwd",
    ".",
    "/home/agent/Life/../.ssh/id",
    "Lifeboat/x",
    "/home/agent/.config/owndesk-browser",
  ])
    assert.equal(lifePathAllowed(path), false, path)
})

test("a life link must resolve: real pages and bot walls pass, dead links fail", async () => {
  const answer = (status: number) =>
    (async () => new Response(null, { status })) as typeof fetch
  assert.equal(await linkResolves("https://a.test", answer(200)), true)
  assert.equal(await linkResolves("https://a.test", answer(403)), true)
  assert.equal(await linkResolves("https://a.test", answer(404)), false)
  assert.equal(
    await linkResolves("https://a.test", (async () => {
      throw new Error("ENOTFOUND")
    }) as typeof fetch),
    false
  )
})

test("a life session gets browse/read/log tools only; ordinary tasks never see life tools", () => {
  const life = Object.keys(toolsForTask({ lifeSession: { prompt: "x" } })).sort()
  assert.deepEqual(life, [
    "browser_click",
    "browser_observe",
    "browser_open",
    "browser_pages",
    "browser_screenshot",
    "complete_task",
    "fs_list",
    "fs_read",
    "fs_write",
    "life_log",
    "life_share",
    "screen_capture",
  ])
  const ordinary = Object.keys(toolsForTask({}))
  assert.equal(ordinary.includes("life_log"), false)
  assert.equal(ordinary.includes("life_share"), false)
  assert.equal(ordinary.includes("shell"), true)
})

test("settings reject an unknown time zone and out-of-range life budget", () => {
  assert.equal(
    companionSettingsSchema.safeParse({ timeZone: "Mars/Base" }).success,
    false
  )
  assert.equal(
    companionSettingsSchema.safeParse({ timeZone: "Asia/Taipei" }).success,
    true
  )
  assert.equal(
    companionSettingsSchema.safeParse({ lifeDailyBudgetMicros: 5_000_001 }).success,
    false
  )
  assert.equal(
    companionSettingsSchema.safeParse({ adultConfirmed: false }).success,
    false
  )
})

test("rhythm: sleep beats nap beats away; wraps midnight; follows the companion's zone", () => {
  const rhythm = {
    sleep: { start: "23:30", end: "07:30" },
    nap: { start: "13:00", end: "14:00" },
    away: [{ start: "08:30", end: "09:30", label: "通勤" }],
  }
  const at = (iso: string) => rhythmAt(new Date(iso), "Asia/Taipei", rhythm)
  assert.equal(at("2026-11-01T16:00:00Z").state, "asleep") // 00:00
  assert.equal(at("2026-11-01T22:00:00Z").state, "asleep") // 06:00
  assert.deepEqual(at("2026-11-02T00:40:00Z"), { state: "away", label: "通勤" }) // 08:40
  assert.equal(at("2026-11-01T05:30:00Z").state, "nap") // 13:30
  assert.equal(at("2026-11-01T03:00:00Z").state, "online") // 11:00
  assert.equal(
    rhythmAt(new Date("2026-11-01T16:00:00Z"), "America/New_York", rhythm).state,
    "online"
  )
  assert.equal(
    rhythmAt(new Date("2026-11-01T02:00:00Z"), "UTC", defaultRhythm).state,
    "asleep"
  )
})

test("no share while she sleeps, naps or is away; the prompt tells her state", () => {
  const companion = {
    sharesPaused: false,
    maxSharesPerDay: 2,
    quietStart: "00:00",
    quietEnd: "00:00",
    timeZone: "Asia/Taipei",
    rhythm: {
      sleep: { start: "23:30", end: "07:30" },
      nap: null,
      away: [{ start: "12:00", end: "13:00" }],
    },
  }
  const base = {
    companion,
    createdAt: new Date("2026-11-01T03:00:00Z"),
    sentToday: 0,
    lastSentAt: null,
  }
  const gate = (iso: string) => decideShare({ ...base, now: new Date(iso) })
  assert.deepEqual(gate("2026-11-01T03:00:00Z"), { send: true }) // 11:00 online
  assert.deepEqual(gate("2026-11-01T04:30:00Z"), { send: false }) // 12:30 away
  assert.deepEqual(gate("2026-11-01T16:30:00Z"), { send: false }) // 00:30 asleep
  assert.match(
    buildCompanionPrompt({ ...context, rhythm: { state: "asleep", label: null } }),
    /在睡觉/
  )
  assert.match(
    buildCompanionPrompt({ ...context, rhythm: { state: "away", label: "通勤" } }),
    /通勤/
  )
  assert.match(buildCompanionPrompt(context), /醒着/)
})

test("co-view: finds the link in a message and never trails punctuation", () => {
  assert.equal(
    extractLink("看这个 https://example.com/a?b=1。好看吗"),
    "https://example.com/a?b=1"
  )
  assert.equal(extractLink("(https://example.com/x)"), "https://example.com/x")
  assert.equal(extractLink("没有链接"), null)
})

test("co-view: only public web addresses are opened", async () => {
  for (const url of [
    "http://localhost:6797/api",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://192.168.0.5/",
    "http://172.20.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://printer.local/",
    "http://intranet/",
    "ftp://example.com/file",
    "https://user:pw@example.com/",
  ])
    assert.equal(isPublicUrl(url), false, url)
  assert.equal(isPublicUrl("https://example.com/a"), true)
  assert.equal(isPublicUrl("http://8.8.8.8/"), true)
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true)
  // a public-looking name that resolves to a private address is refused
  const resolver = (async () => [{ address: "10.0.0.7", family: 4 }]) as never
  assert.equal(await linkIsOpenable("https://sneaky.example.com/", resolver), false)
  const open = (async () => [{ address: "93.184.216.34", family: 4 }]) as never
  assert.equal(await linkIsOpenable("https://example.com/", open), true)
  const gone = (async () => {
    throw new Error("ENOTFOUND")
  }) as never
  assert.equal(await linkIsOpenable("https://nowhere.example/", gone), false)
})

test("a co-view session may only read and reply; coview_reply exists nowhere else", () => {
  const coview = Object.keys(
    toolsForTask({
      lifeSession: { prompt: "x", coview: { requestId: "r", url: "https://a.test" } },
    })
  ).sort()
  assert.deepEqual(coview, [
    "browser_click",
    "browser_observe",
    "browser_open",
    "browser_pages",
    "browser_screenshot",
    "complete_task",
    "coview_reply",
  ])
  assert.equal(
    Object.hasOwn(toolsForTask({ lifeSession: { prompt: "x" } }), "coview_reply"),
    false
  )
  assert.equal(Object.hasOwn(toolsForTask({}), "coview_reply"), false)
})

test("the prompt tells her about a fresh link without letting her invent its content", () => {
  const queued = buildCompanionPrompt({
    ...context,
    link: { url: "https://a.test/x", queued: true },
  })
  assert.match(queued, /https:\/\/a\.test\/x/)
  assert.match(queued, /还没有点开/)
  const refused = buildCompanionPrompt({
    ...context,
    link: { url: "http://10.0.0.1", queued: false },
  })
  assert.match(refused, /没法打开/)
  assert.doesNotMatch(buildCompanionPrompt(context), /对方刚发来的链接/)
})

test("rhythm settings reject malformed times and too many away blocks", () => {
  const base = { sleep: { start: "23:00", end: "07:00" }, nap: null, away: [] }
  assert.ok(companionSettingsSchema.safeParse({ rhythm: base }).success)
  assert.equal(
    companionSettingsSchema.safeParse({
      rhythm: { ...base, sleep: { start: "24:00", end: "07:00" } },
    }).success,
    false
  )
  assert.equal(
    companionSettingsSchema.safeParse({
      rhythm: {
        ...base,
        away: Array.from({ length: 7 }, () => ({ start: "09:00", end: "10:00" })),
      },
    }).success,
    false
  )
})
