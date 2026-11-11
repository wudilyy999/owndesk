import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { chromium } from "playwright"
import { env } from "@/lib/env"

const credentials = JSON.parse(await readFile("data/dev-owner.json", "utf8"))
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.UI_BROWSER_PATH,
})
const ids: string[] = [],
  errors: string[] = []
const context = await browser.newContext()
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.message))
const stamp = randomUUID()
try {
  await page.goto(`${env.APP_URL}/login`)
  await page.getByLabel("邮箱").fill(credentials.email)
  await page.getByLabel("密码").fill(credentials.password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL((url) => url.pathname !== "/login")
  await page.goto(`${env.APP_URL}/settings`)
  const section = page.locator("#connections")
  const submit = async (button: string) => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/connections") && r.request().method() === "POST"
    )
    await section.getByRole("button", { name: button, exact: true }).click()
    const r = await response
    assert.equal(r.status(), 201, await r.text())
    return (await r.json()).id as string
  }
  await section.getByLabel("连接名称", { exact: true }).fill(`edit-A-${stamp}`)
  await section.getByLabel("连接类型").selectOption("mcp_stdio")
  await section.getByLabel("启动程序", { exact: true }).fill("node")
  const first = await submit("保存连接")
  ids.push(first)
  const article = section.locator("article").filter({ hasText: `edit-A-${stamp}` })
  await article.getByRole("button", { name: "重新配置", exact: true }).click()
  await section.getByLabel("连接名称", { exact: true }).fill(`edit-B-${stamp}`)
  await section.getByLabel("启动程序", { exact: true }).fill("node")
  assert.equal(await submit("替换连接配置"), first)
  await section.getByRole("button", { name: "保存连接", exact: true }).waitFor()
  assert.equal(await section.getByLabel("连接名称", { exact: true }).inputValue(), "")
  assert.equal(await section.getByLabel("连接类型").inputValue(), "mcp_http")
  await section.getByLabel("连接名称", { exact: true }).fill(`new-C-${stamp}`)
  await section.getByLabel("连接类型").selectOption("mcp_stdio")
  await section.getByLabel("启动程序", { exact: true }).fill("node")
  const second = await submit("保存连接")
  ids.push(second)
  assert.notEqual(second, first)
  await section
    .locator("article")
    .filter({ hasText: `edit-B-${stamp}` })
    .getByRole("button", { name: "重新配置", exact: true })
    .click()
  await section.getByRole("button", { name: "取消重新配置", exact: true }).click()
  assert.equal(await section.getByLabel("连接名称", { exact: true }).inputValue(), "")
  await section.getByRole("button", { name: "保存连接", exact: true }).waitFor()
  // Deleting the connection currently being edited also exits edit mode.
  const deleting = section.locator("article").filter({ hasText: `edit-B-${stamp}` })
  await deleting.getByRole("button", { name: "重新配置", exact: true }).click()
  await deleting.getByRole("button", { name: "删除", exact: true }).click()
  await section.getByRole("button", { name: "保存连接", exact: true }).waitFor()
  const rows = await (await context.request.get(`${env.APP_URL}/api/connections`)).json()
  assert(!rows.some((row: { id: string }) => row.id === first))
  assert(
    rows.some(
      (row: { id: string; name: string }) =>
        row.id === second && row.name === `new-C-${stamp}`
    )
  )
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "edit/save exits edit mode",
        "next save creates a distinct connection",
        "cancel clears editor",
        "delete exits editor",
      ],
      pageErrors: errors,
    })
  )
} finally {
  for (const id of ids)
    await context.request.post(`${env.APP_URL}/api/connections/${id}`, {
      data: { action: "delete" },
      headers: { Origin: env.APP_URL },
    })
  await browser.close()
}
