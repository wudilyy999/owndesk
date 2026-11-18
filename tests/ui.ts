import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { env } from "@/lib/env"

const credentials = JSON.parse(await readFile("data/dev-owner.json", "utf8"))
const directory = path.resolve("data/experiments", `ui-${Date.now()}`)
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.UI_BROWSER_PATH,
})
const errors: string[] = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${env.APP_URL}/login`)
  await page.getByLabel("邮箱").fill(credentials.email)
  await page.getByLabel("密码").fill(credentials.password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.getByRole("region", { name: "对话工作区", exact: true }).waitFor()
  const agentOptions = await page
    .getByLabel("选择 Agent")
    .locator("option")
    .allTextContents()
  assert.equal(agentOptions.includes("Recovery Lab"), false)
  assert.equal(await page.getByLabel("本次实验说明").count(), 0)
  assert.equal(await page.getByRole("button", { name: "运行三步骤实验" }).count(), 0)
  const agentResponse = await context.request.get(`${env.APP_URL}/api/agents`)
  assert.equal(agentResponse.status(), 200)
  const agents = await agentResponse.json()
  assert(
    agents.every(
      (agent: { model: string | null }) => agent.model !== "fixture/durable-report"
    )
  )
  const tasksResponse = await context.request.get(`${env.APP_URL}/api/tasks`)
  assert.equal(tasksResponse.status(), 200)
  const tasks = await tasksResponse.json()
  assert(
    tasks.every(
      (task: { configSnapshot: { runtime: string } }) =>
        task.configSnapshot.runtime !== "fixture"
    )
  )
  const completedTurn = tasks.find(
    (task: {
      status: string
      threadId: string | null
      result: { summary?: string } | null
    }) => task.status === "completed" && task.threadId && task.result?.summary
  )
  if (completedTurn) {
    await page.goto(`${env.APP_URL}/?task=${completedTurn.id}`)
    await page.getByRole("heading", { name: "已完成", exact: true }).waitFor()
    await page
      .getByRole("article", {
        name: `第 ${completedTurn.threadTurn} 轮对话`,
        exact: true,
      })
      .waitFor()
    assert.equal(
      await page.getByRole("article", { name: "交付结果", exact: true }).count(),
      0
    )
    const sidebar = page.getByRole("complementary", { name: "会话导航" })
    const beforeScroll = await sidebar.boundingBox()
    await page
      .getByRole("region", { name: "对话工作区", exact: true })
      .hover({ position: { x: 8, y: 8 } })
    await page.mouse.wheel(0, 600)
    await page.waitForFunction(
      () => document.querySelector('[aria-label="对话工作区"]')!.scrollTop > 0
    )
    assert.deepEqual(await sidebar.boundingBox(), beforeScroll)
    assert.equal(await page.evaluate(() => window.scrollY), 0)
  }
  await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).click()
  await page.getByRole("heading", { name: "模型与 Agent", exact: true }).waitFor()
  assert.equal(await page.getByText("Recovery Lab", { exact: true }).count(), 0)
  const pageMenu = page.getByRole("button", { name: "页面导航" })
  await pageMenu.click()
  assert.equal(
    await page
      .getByRole("menuitem", { name: "模型与 Agent 设置" })
      .getAttribute("aria-current"),
    "page"
  )
  await page.getByRole("menuitem", { name: "版本", exact: true }).click()
  await page.getByRole("heading", { name: "版本", exact: true }).waitFor()
  await page.getByRole("link", { name: "返回工作现场", exact: true }).click()
  await page.getByRole("region", { name: "对话工作区", exact: true }).waitFor()
  await page.getByRole("button", { name: "新对话", exact: true }).click()
  await page.getByRole("heading", { name: "工作区", exact: true }).waitFor()
  await page.screenshot({ path: path.join(directory, "desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(directory, "mobile.png"), fullPage: true })
  const fileChooser = page.waitForEvent("filechooser")
  await page.getByText("添加文件", { exact: true }).click()
  await (
    await fileChooser
  ).setFiles({
    name: "ui-check.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,amount\n2026-11-01,1\n"),
  })
  await page.getByRole("link", { name: "ui-check.csv", exact: true }).waitFor()
  await page.getByRole("button", { name: "移除 ui-check.csv", exact: true }).click()
  assert.equal(
    await page.getByRole("link", { name: "ui-check.csv", exact: true }).count(),
    0
  )
  const delivery = page.getByText("交付检查与执行额度（可选）", { exact: true })
  await delivery.click()
  await page.getByLabel("CSV 文件路径").fill("report.csv")
  await page.getByLabel("CSV 开始日期").fill("2026-11-01")
  await page.getByLabel("交付前由我确认").check()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(
      await page
        .getByRole("region", { name: "对话工作区" })
        .evaluate((region) => region.scrollWidth > region.clientWidth),
      false,
      `Workspace must not overflow horizontally at ${width}px`
    )
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileMenu = page.getByRole("button", { name: "会话", exact: true })
  await mobileMenu.click()
  const navigation = page.getByRole("dialog", { name: "会话导航", exact: true })
  await navigation.waitFor()
  assert.equal(
    await navigation.getByRole("button", { name: "新对话", exact: true }).isVisible(),
    true
  )
  await page.screenshot({
    path: path.join(directory, "mobile-navigation.png"),
    animations: "disabled",
  })
  await navigation.getByRole("link", { name: "陪伴聊天", exact: true }).click()
  await page.getByPlaceholder("发消息").waitFor()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const back = await page.getByRole("link", { name: "返回工作现场" }).boundingBox()
    assert.ok(back && back.height < 22, `Companion back link wraps at ${width}px`)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      `Companion must not overflow horizontally at ${width}px`
    )
  }
  await page.getByRole("link", { name: "返回工作现场" }).click()
  await mobileMenu.click()
  await navigation.getByRole("button", { name: "退出登录", exact: true }).click()
  await page.getByRole("heading", { name: "登录 OwnDesk", exact: true }).waitFor()
  assert.deepEqual(errors, [])
  const result = {
    passed: true,
    modelRequests: 0,
    browser: browser.version(),
    checks: [
      "Owner login",
      "Development fixture hidden from home, settings and public lists",
      "No task submission or model requests",
      ...(completedTurn
        ? [
            "Completed conversation replies stay in the transcript without a duplicate result card",
            "Desktop sidebar stays fixed while the workspace scrolls",
          ]
        : []),
      "Sidebar and page menu navigation, including active page state",
      "Attachment picker uploads and removes a file",
      "Delivery form and companion layout at 390px and 320px",
      "Sign out",
    ],
    evidence: directory,
    recordedAt: new Date().toISOString(),
  }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n"
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
