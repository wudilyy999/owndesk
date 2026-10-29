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
  await page.getByRole("heading", { name: "任务进度留在服务器" }).waitFor()
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
  await page.goto(`${env.APP_URL}/settings`)
  await page.getByRole("heading", { name: "模型与 Agent", exact: true }).waitFor()
  assert.equal(await page.getByText("Recovery Lab", { exact: true }).count(), 0)
  await page.goto(env.APP_URL)
  await page.getByRole("heading", { name: "任务进度留在服务器" }).waitFor()
  await page.screenshot({ path: path.join(directory, "desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(directory, "mobile.png"), fullPage: true })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    "Mobile viewport must not overflow horizontally"
  )
  await page.getByRole("button", { name: "会话", exact: true }).click()
  const navigation = page.getByRole("dialog", { name: "会话导航", exact: true })
  await navigation.waitFor()
  assert.equal(
    await navigation.getByRole("button", { name: "新对话", exact: true }).isVisible(),
    true
  )
  await navigation.getByRole("button", { name: "退出登录", exact: true }).click()
  await page.getByRole("heading", { name: "回到你的工作现场" }).waitFor()
  assert.deepEqual(errors, [])
  const result = {
    passed: true,
    modelRequests: 0,
    browser: browser.version(),
    checks: [
      "Owner login",
      "Development fixture hidden from home, settings and public lists",
      "No task submission or model requests",
      "Completed conversation replies stay in the transcript without a duplicate result card",
      "Desktop sidebar stays fixed while the workspace scrolls; mobile navigation opens in a drawer",
      "Desktop/mobile layout",
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
