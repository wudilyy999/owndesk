// Stage B1 in a real browser (Chromium via Playwright) against the dev server and the real model:
// typing indicator, staggered bubbles, copy, regenerate, edit, the pace setting, and PWA
// installability (manifest, icons, service worker, offline page). Stage B2a adds sending a picture and the memory change log
// with undo. Screenshots go to B1_SHOTS.
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"
import sharp from "sharp"
import { env } from "@/lib/env"

const credentials = JSON.parse(await readFile("data/dev-owner.json", "utf8"))
const shots = path.resolve(
  process.env.B1_SHOTS ?? path.join("data/experiments", `companion-ui-${Date.now()}`)
)
await mkdir(shots, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.UI_BROWSER_PATH,
})
const errors: string[] = []
const snap = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`) })
const typing = (page: Page) => page.locator('[data-testid="typing-indicator"]')
const assistant = (page: Page) => page.locator('[data-role="assistant"]')
const idle = (page: Page) =>
  page.waitForFunction(
    () => !document.querySelector('input[placeholder="发消息"]:disabled')
  )

// Timestamps (ms since page load) at which a new assistant bubble was added to the chat
const watchBubbles = (page: Page) =>
  // A string, so the test runner's transform does not inject helpers the page does not have
  page.evaluate(`(() => {
    const seen = (window.__seen = [])
    const log = document.querySelector('[data-testid="chat-log"]')
    const known = new Set()
    const scan = () => {
      for (const node of log.querySelectorAll('[data-role="assistant"]')) {
        const id = node.getAttribute("data-message-id")
        if (!known.has(id)) {
          known.add(id)
          seen.push(performance.now())
        }
      }
    }
    scan()
    seen.length = 0
    new MutationObserver(scan).observe(log, { childList: true, subtree: true })
  })()`)
const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: number[] }).__seen)
const idsOf = (page: Page) =>
  assistant(page).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-message-id") ?? "")
  )
// Assistant bubbles after the last user message: the latest answer
const roundIds = (page: Page) =>
  page.evaluate(`(() => {
    const ids = []
    for (const node of document.querySelectorAll('[data-testid="chat-log"] [data-role]')) {
      if (node.getAttribute("data-role") === "user") ids.length = 0
      else ids.push(node.getAttribute("data-message-id"))
    }
    return ids
  })()`) as Promise<string[]>
// Resolves once an assistant bubble that was not in `old` is on screen
const newBubble = (page: Page, old: string[]) =>
  page.waitForFunction(
    (known) =>
      [...document.querySelectorAll('[data-role="assistant"]')].some(
        (n) => !known.includes(n.getAttribute("data-message-id")!)
      ),
    old,
    { timeout: 60_000 }
  )

// A co-view she was asked for earlier (the full e2e links a web page) lands in the room whenever
// it finishes, which can be in the middle of the regenerate step below: let it finish first
const { pool: waitPool } = await import("@/db")
for (let i = 0; i < 300; i++) {
  const { rows } = await waitPool.query(
    "SELECT 1 FROM coview_requests WHERE status IN ('pending','started') LIMIT 1"
  )
  if (!rows.length) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${env.APP_URL}/login`)
  await page.getByLabel("邮箱").fill(credentials.email)
  await page.getByLabel("密码").fill(credentials.password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"))
  await page.goto(`${env.APP_URL}/companion`)
  await page.getByPlaceholder("发消息").waitFor()

  const setPace = async (pace: "natural" | "fast" | "off") => {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByLabel("打字节奏").selectOption(pace)
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByText("已保存").waitFor()
    await page.getByRole("button", { name: "聊天", exact: true }).click()
    await page.getByPlaceholder("发消息").waitFor()
  }
  await setPace("natural")

  // 1. Typing indicator and staggered bubbles (the model decides how many bubbles; retry if one)
  let stamps: number[] = []
  for (let attempt = 0; attempt < 3 && stamps.length < 2; attempt++) {
    await page.waitForLoadState("networkidle")
    await watchBubbles(page)
    const before = await idsOf(page)
    const tag = attempt === 0 ? "" : `-try${attempt + 1}`
    await page
      .getByPlaceholder("发消息")
      .fill(
        "请分成三条很短的消息回我，每条之间空一行：先打招呼，再说你现在在做什么，最后问我吃饭了没"
      )
    await page.getByRole("button", { name: "发送" }).click()
    await typing(page).waitFor({ state: "visible", timeout: 30_000 })
    await snap(page, `01-typing-indicator${tag}`)
    await newBubble(page, before)
    if ((await typing(page).count()) > 0)
      await snap(page, `02-staggered-first-bubble${tag}`)
    await idle(page)
    stamps = await seen(page)
    await snap(page, `03-staggered-final${tag}`)
  }
  assert.ok(stamps.length >= 2, `expected at least 2 bubbles, got ${stamps.length}`)
  for (let i = 1; i < stamps.length; i++)
    assert.ok(
      stamps[i] - stamps[i - 1] >= 300,
      `bubbles ${i} and ${i + 1} arrived ${Math.round(stamps[i] - stamps[i - 1])} ms apart`
    )
  console.log(
    "bubble gaps (ms):",
    stamps.slice(1).map((t, i) => Math.round(t - stamps[i]))
  )

  // 2. Copy
  const lastReply = assistant(page).last()
  const replyText = (await lastReply.locator("div").first().innerText()).trim()
  await lastReply.getByRole("button", { name: "复制" }).click()
  await lastReply.getByRole("button", { name: "已复制" }).waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), replyText)

  // 3. Regenerate the last reply: new bubbles, the old ones are gone and hidden on reload
  const oldIds = await roundIds(page)
  let newIds: string[] = []
  // A provider hiccup puts the old answer back (by design); ask again before judging
  for (let attempt = 0; attempt < 3; attempt++) {
    await assistant(page).last().getByRole("button", { name: "重说" }).click()
    await typing(page).waitFor({ state: "visible", timeout: 30_000 })
    if (attempt === 0) await snap(page, "04-regenerate-typing")
    await idle(page)
    newIds = await roundIds(page)
    if (newIds.length >= 1 && newIds.every((id) => !oldIds.includes(id))) break
    console.log("regenerate restored the old answer, trying again")
  }
  assert.ok(newIds.length >= 1)
  assert.ok(
    newIds.every((id) => !oldIds.includes(id)),
    "old bubbles replaced"
  )
  await snap(page, "05-regenerated")
  await page.reload()
  await page.getByPlaceholder("发消息").waitFor()
  await assistant(page).first().waitFor()
  assert.deepEqual(await roundIds(page), newIds, "reload shows only the new answer")

  // 4. Edit the last user message
  const oldPrompt = page.getByText("请分成三条很短的消息回我")
  const oldCount = await oldPrompt.count()
  const edited = "改一下：你更喜欢猫还是狗？一句话就好"
  await page
    .locator('[data-role="user"]')
    .last()
    .getByRole("button", { name: "编辑" })
    .click()
  await snap(page, "06-edit-box")
  await page.getByLabel("编辑消息").fill(edited)
  await page.getByRole("button", { name: "保存并重发" }).click()
  await typing(page).waitFor({ state: "visible", timeout: 30_000 })
  await idle(page)
  assert.ok(
    (await page.locator('[data-role="user"]').last().innerText()).includes(edited)
  )
  assert.equal(await oldPrompt.count(), oldCount - 1, "old message hidden")
  await snap(page, "07-edited")

  // 5. Pace "关闭": no stagger
  await setPace("off")
  await page.waitForLoadState("networkidle")
  await watchBubbles(page)
  const beforeOff = await idsOf(page)
  await page
    .getByPlaceholder("发消息")
    .fill("请分成两条很短的消息回我，每条之间空一行：先说晚安，再说明天见")
  await page.getByRole("button", { name: "发送" }).click()
  await newBubble(page, beforeOff)
  await idle(page)
  const offStamps = await seen(page)
  if (offStamps.length >= 2)
    assert.ok(
      offStamps.at(-1)! - offStamps[0] < 300,
      "with the pace off the bubbles land together"
    )
  await snap(page, "08-pace-off")
  await setPace("natural")

  // 5b. B2a: send a picture (real model looks at it), bad files are refused, the memory change log with undo
  await setPace("off")
  const scene = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">
        <rect width="900" height="600" fill="#5cb8ff"/>
        <rect y="400" width="900" height="200" fill="#3fa34d"/>
        <circle cx="720" cy="120" r="70" fill="#ffd400"/>
        <ellipse cx="200" cy="110" rx="110" ry="40" fill="#ffffff"/>
        <ellipse cx="270" cy="95" rx="80" ry="35" fill="#ffffff"/>
      </svg>`
    )
  )
    .png()
    .toBuffer()
  const picker = page.getByTestId("picture-input")
  await picker.setInputFiles({ name: "scene.png", mimeType: "image/png", buffer: scene })
  await page.getByTestId("picture-preview").waitFor()
  await snap(page, "12-picture-ready")
  const beforePicture = await idsOf(page)
  await page.getByPlaceholder("发消息").fill("你看这张图里都有什么？用一句话说")
  await page.getByRole("button", { name: "发送" }).click()
  await newBubble(page, beforePicture)
  await idle(page)
  const sent = page.getByTestId("sent-picture").last()
  await sent.waitFor()
  assert.ok(
    await sent.evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
    "the picture is shown in the conversation"
  )
  const answer = (await assistant(page).last().innerText()).trim()
  console.log("picture answer:", answer)
  assert.match(
    answer,
    /太阳|阳光|草|天空|蓝天|白云|云|绿|黄|风景|画|插画|简笔|天/,
    "her answer is about the picture"
  )
  await snap(page, "13-picture-answer")
  // Still there after a reload
  await page.reload()
  await page.getByPlaceholder("发消息").waitFor()
  await page.getByTestId("sent-picture").last().waitFor()
  await snap(page, "14-picture-after-reload")
  // Bad files: not a picture, too big
  await picker.setInputFiles({
    name: "fake.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("this is not a picture"),
  })
  // the error line under the picker, not any earlier chat message that happens to say 打不开
  await page.locator("p.text-destructive", { hasText: /打不开|只支持/ }).waitFor()
  await picker.setInputFiles({
    name: "huge.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.alloc(11 * 1024 * 1024, 1),
  })
  await page.getByText(/图片太大/).waitFor({ timeout: 30_000 })
  await snap(page, "15-picture-refused")
  assert.equal(await page.getByTestId("picture-preview").count(), 0)

  const memoryApi = (suffix = "", init?: RequestInit) =>
    page.evaluate(
      ([path, body]) =>
        fetch(`/api/companion/memories${path}`, {
          ...(body as object),
          headers: { "Content-Type": "application/json" },
        }).then((r) => r.json()),
      [suffix, init ?? {}] as const
    )
  // Memory changes: what she changed on her own is listed with a one-click undo. The changes are
  // made through the same code the chat uses (the real model's decisions are in the e2e run).
  const { db, pool } = await import("@/db")
  const { companions } = await import("@/db/schema")
  const memory = await import("@/lib/companion/memory")
  const [{ agentId }] = await db.select({ agentId: companions.agentId }).from(companions)
  const info = {
    actor: "model",
    origin: "chat",
    sourceText: "我最近戒咖啡了",
    reason: "偏好变了，以前爱喝冰美式",
  } as const
  await pool.query("DELETE FROM memories WHERE content LIKE '%界面测试%'")
  await pool.query(
    "DELETE FROM memory_changes WHERE before->>'content' LIKE '%界面测试%' OR after->>'content' LIKE '%界面测试%'"
  )
  const before = await memory.addNote(agentId, "喜欢喝冰美式（界面测试）", "user")
  await memory.updateNote(agentId, before.id, "最近戒咖啡了（界面测试）", info)
  const gone = await memory.addNote(
    agentId,
    "住在上海（界面测试）",
    "agent",
    "active",
    info
  )
  await memory.deleteNote(agentId, gone.id, { ...info, reason: "对方说搬家了" })
  await page.getByRole("button", { name: "记忆", exact: true }).click()
  await page.getByText("最近戒咖啡了（界面测试）", { exact: true }).first().waitFor()
  const log = page.getByTestId("change-log")
  await log.waitFor()
  assert.equal(await page.getByTestId("suggestion-card").count(), 0, "no merge cards")
  assert.equal(await page.getByRole("button", { name: "找相似的笔记" }).count(), 0)
  const rows = log.getByTestId("change-row")
  assert.ok((await rows.count()) >= 3)
  await log.getByText("原因：对方说搬家了").first().waitFor()
  await snap(page, "16-change-log")
  // Undo the update: the old wording comes back; undo the delete: the note comes back
  await log
    .locator('[data-op="update"]')
    .first()
    .getByRole("button", { name: "撤销" })
    .click()
  await page.getByText("喜欢喝冰美式（界面测试）", { exact: true }).first().waitFor()
  assert.equal(
    await page.getByText("最近戒咖啡了（界面测试）", { exact: true }).count(),
    1
  )
  // The entry stays, marked as undone
  await log.getByText("已撤销").first().waitFor()
  await log
    .locator('[data-op="delete"]')
    .first()
    .getByRole("button", { name: "撤销" })
    .click()
  // The undo is a request the page sends; read the API until the note is back
  const noteBack = async () =>
    ((await memoryApi()) as { content: string }[]).some((n) =>
      n.content.includes("住在上海（界面测试）")
    )
  for (let i = 0; i < 30 && !(await noteBack()); i++)
    await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(await noteBack(), "the deleted note is back")
  await snap(page, "17-after-undo")
  // Clean up the test notes
  for (const note of (await memoryApi()) as { id: string; content: string }[])
    if (note.content.includes("界面测试"))
      await memoryApi(`/${note.id}`, { method: "DELETE" })
  await pool.query(
    "DELETE FROM memory_changes WHERE (before->>'content' LIKE '%界面测试%' OR after->>'content' LIKE '%界面测试%')"
  )

  // 5c. The tidy-up button: the real model rewrites loose notes into topic summaries ("关于你"),
  //     the change log shows the run as one entry, and one click undoes all of it
  const tagged = [
    "喜欢喝冰美式（整理测试）",
    "平时只喝无糖乌龙茶（整理测试）",
    "爱吃辣（整理测试）",
    "不吃香菜（整理测试）",
    "在一家游戏公司做策划（整理测试）",
    "这周在赶版本，天天加班（整理测试）",
    "周末常去徐汇滨江跑步（整理测试）",
  ]
  for (const content of tagged) await memory.addNote(agentId, content, "user")
  await pool.query("UPDATE memories SET summary_id = NULL WHERE agent_id = $1", [agentId])
  await pool.query("DELETE FROM memories WHERE agent_id = $1 AND kind = 'summary'", [
    agentId,
  ])
  await page.reload()
  await page.getByRole("button", { name: "记忆", exact: true }).click()
  await page.getByText(tagged[0], { exact: true }).first().waitFor()
  await page.getByTestId("organize").click()
  await page.getByText(/整理好了，动了 \d+ 处/).waitFor({ timeout: 240_000 })
  await page.getByTestId("summary").first().waitFor()
  assert.ok(
    (await page.getByTestId("summary").count()) >= 1,
    "topic summaries appeared under 关于你"
  )
  await page.getByRole("heading", { name: "关于你" }).waitFor()
  const run = page.getByTestId("change-row").filter({ hasText: "整理了记忆" }).first()
  await run.waitFor()
  assert.equal(await run.getAttribute("data-origin"), "organize")
  assert.ok(
    Number(await run.getAttribute("data-size")) >= 1,
    "the run is one entry in the log"
  )
  await snap(page, "18-organized-summaries")
  await page.screenshot({
    path: path.join(shots, "18b-organized-full-page.png"),
    fullPage: true,
  })
  await run.getByRole("button", { name: "撤销" }).click()
  await run.getByText("已撤销").waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="summary"]').length === 0
  )
  for (const content of tagged)
    assert.ok(
      ((await memoryApi()) as { content: string }[]).some((n) => n.content === content),
      `back after undo: ${content}`
    )
  await snap(page, "19-organize-undone")
  for (const note of (await memoryApi()) as { id: string; content: string }[])
    if (note.content.includes("整理测试"))
      await memoryApi(`/${note.id}`, { method: "DELETE" })
  await pool.query(
    "DELETE FROM memory_changes WHERE (before->>'content' LIKE '%整理测试%' OR after->>'content' LIKE '%整理测试%')"
  )
  await pool.end()
  await page.getByRole("button", { name: "聊天", exact: true }).click()
  await page.getByPlaceholder("发消息").waitFor()
  await setPace("natural")

  // 6. Mobile layout of the chat
  await page.setViewportSize({ width: 390, height: 844 })
  await snap(page, "09-mobile")
  // The header stays tidy: the back link is one line, nothing makes the page scroll sideways
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const back = await page.getByRole("link", { name: "返回工作现场" }).boundingBox()
    assert.ok(back && back.height < 22, `back link wraps at ${width}px`)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    )
    assert.ok(overflow <= 0, `page scrolls sideways at ${width}px`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.setViewportSize({ width: 1100, height: 900 })

  // 7. PWA: manifest, icons, installability (Chromium's own check), service worker, offline page
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute("href")
  assert.ok(manifestUrl, "page links a manifest")
  const manifestResponse = await context.request.get(
    new URL(manifestUrl, env.APP_URL).toString()
  )
  assert.equal(manifestResponse.status(), 200)
  const manifest = await manifestResponse.json()
  assert.equal(manifest.display, "standalone")
  assert.equal(manifest.start_url, "/companion")
  for (const icon of manifest.icons) {
    const response = await context.request.get(new URL(icon.src, env.APP_URL).toString())
    assert.equal(response.status(), 200, icon.src)
    assert.equal(response.headers()["content-type"], "image/png")
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")
  assert.ok(apple)
  assert.equal(
    (await context.request.get(new URL(apple, env.APP_URL).toString())).status(),
    200
  )
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready
    return { scope: ready.scope, active: !!ready.active }
  })
  assert.ok(registration.active)
  assert.equal(registration.scope, `${new URL(env.APP_URL).origin}/`)
  const cdp = await context.newCDPSession(page)
  const parsed = (await cdp.send("Page.getAppManifest")) as {
    errors: { message: string }[]
  }
  assert.deepEqual(parsed.errors, [], "Chromium parses the manifest without errors")
  const installability = (await cdp.send("Page.getInstallabilityErrors")) as {
    installabilityErrors: { errorId: string }[]
  }
  console.log(
    "installability errors:",
    installability.installabilityErrors.map((e) => e.errorId)
  )
  assert.deepEqual(
    installability.installabilityErrors,
    [],
    "Chromium says it is installable"
  )
  const manifestPage = await context.newPage()
  await manifestPage.goto(new URL(manifestUrl, env.APP_URL).toString())
  await snap(manifestPage, "10-manifest")
  await manifestPage.close()
  // Reload once so the worker controls the page, then lose the network
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await context.setOffline(true)
  await page.goto(`${env.APP_URL}/companion`).catch(() => {})
  await page.getByText("现在连不上服务器").waitFor({ timeout: 10_000 })
  await snap(page, "11-offline")
  await context.setOffline(false)

  assert.deepEqual(errors, [])
  console.log(`companion UI passed; screenshots in ${shots}`)
} finally {
  await browser.close()
}
