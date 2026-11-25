// Run alongside a disposable next server and the migrated library_probe fixture (npm run test:library).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chromium } from "playwright"
const base = process.env.APP_URL!,
  url = new URL(base)
assert(["127.0.0.1", "localhost"].includes(url.hostname))
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/library_probe")
assert(process.env.LIBRARY_TEST_PASS)
const browser = await chromium.launch(),
  page = await browser.newPage()
page.setDefaultTimeout(60000)
try {
  await page.goto(base + "/library")
  await page.waitForURL("**/login")
  await page.locator("input[name=email]").fill("reader@example.test")
  await page.locator("input[type=password]").fill(process.env.LIBRARY_TEST_PASS)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL((u) => u.pathname != "/login")
  await page.goto(base + "/library")
  const title = "回看报价 " + randomUUID().slice(0, 8)
  await page.locator("#lookup").fill("报价")
  await page.getByRole("button", { name: "搜索", exact: true }).click()
  await page
    .getByRole("link", { name: /聊天原话 ·/ })
    .first()
    .click()
  await page.getByLabel("条目类型").selectOption("followup")
  await page.getByLabel("标题", { exact: true }).fill(title)
  await page.getByLabel("正文", { exact: true }).fill("保存时由主人选择共享")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await page.getByRole("link", { name: "查看原始出处" }).waitFor()
  await page
    .locator("article")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) })
    .getByRole("button", { name: "标记已完成" })
    .click()
  await page.waitForURL(/view=done/)
  await page.getByRole("link", { name: title, exact: true }).click()
  await page.getByRole("link", { name: "查看原始出处" }).click()
  await page.waitForURL((u) => u.searchParams.get("source") === "chat")
  await page.getByRole("heading", { name: /聊天原话 ·/ }).waitFor()
  assert((await page.locator("section").first().innerText()).includes("报价"))
  await page.goto(base + "/library")
  const filetitle = "会议-" + randomUUID().slice(0, 8) + ".vtt"
  await page.locator("input[type=file]").setInputFiles({
    name: filetitle,
    mimeType: "text/vtt",
    buffer: Buffer.from("WEBVTT\n\n00:00.000 --> 00:02.000\n周五给客户报价"),
  })
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await page.waitForURL(/entry=/)
  assert.equal(await page.getByLabel("标题", { exact: true }).inputValue(), filetitle)
  assert(
    (await page.getByLabel("正文", { exact: true }).inputValue()).includes(
      "周五给客户报价"
    )
  )
  await page.addInitScript({
    content: `window.SpeechRecognition=class { start(){this.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'语音草稿测试'}}]});this.onend()} stop(){this.onend()} abort(){} };`,
  })
  await page.goto(base + "/companion")
  let sent = 0
  page.on("request", (r) => {
    if (r.url().endsWith("/api/companion/chat") && r.method() === "POST") sent++
  })
  await page.getByRole("button", { name: "听写", exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[placeholder="发消息"]')?.value ===
      "语音草稿测试",
    undefined,
    { timeout: 10000 }
  )
  assert.equal(sent, 0)
  console.log(
    "PASS: authenticated library search, linked follow-up, completion, provenance, VTT file import and browser dictation result to unsent draft"
  )
} finally {
  await browser.close()
}
