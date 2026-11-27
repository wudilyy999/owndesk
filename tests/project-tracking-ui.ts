import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chromium } from "playwright"
import { pool } from "@/db"
import { env } from "@/lib/env"
import { indexDocuments } from "@/lib/document-index"
assert.equal(new URL(env.DATABASE_URL).pathname, "/library_probe")
assert.equal(new URL(env.APP_URL).hostname, "127.0.0.1")
const password = process.env.LIBRARY_TEST_PASS
assert(password)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(env.APP_URL + "/login")
  await page.locator("input[name=email]").fill("reader@example.test")
  await page.locator("input[type=password]").fill(password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL((u) => u.pathname !== "/login")
  const {
    rows: [r],
  } = await pool.query(
    "SELECT entry_id FROM library_mail_watches ORDER BY since DESC LIMIT 1"
  )
  assert(r)
  await page.goto(env.APP_URL + "/library?entry=" + encodeURIComponent(r.entry_id))
  await page.getByRole("heading", { name: "项目时间线" }).waitFor()
  assert(await page.getByText("7 万", { exact: false }).count())
  const name = "合同-" + Date.now() + ".pdf"
  await page.getByLabel("添加项目文件").setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: execFileSync(process.platform === "win32" ? "python" : "python3", [
      "tests/document-text.py",
      "--pdf",
    ]),
  })
  await page.getByRole("button", { name: "上传并共享正文" }).click()
  await page.getByText(name, { exact: false }).first().waitFor()
  await indexDocuments()
  await page.reload()
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: name }) })
    .last()
  await details.locator("summary").click()
  await details.getByText(/Payment term: NET45/).waitFor()
  await details.getByRole("link", { name: "查看原文" }).click()
  await page.getByRole("link", { name: "下载原文件" }).waitFor()
  console.log(
    "PASS: signed-in project timeline, real multipart PDF upload, indexed text and original file link"
  )
} finally {
  await browser.close()
  await pool.end()
}
