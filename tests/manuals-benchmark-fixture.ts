import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { chromium } from "playwright"
import { createConsoleServer, type ConsoleState } from "./fixtures/manual-console"
import { benchmarkCases, evaluateConsole } from "./manuals-benchmark-cases"

test("console evaluation uses actual GUI state, exact instance, policy and missing-target inspection", async () => {
  const server = createConsoleServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const prep: ConsoleState = await (
      await fetch(`${base}/sessions`, {
        method: "POST",
        body: JSON.stringify({ layout: "sidebar" }),
      })
    ).json()
    const changed: ConsoleState = await (
      await fetch(`${base}/sessions/${prep.id}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "region", value: "华北二" }),
      })
    ).json()
    assert.equal(changed.region, "华北二")
    for (const c of benchmarkCases) {
      const s: ConsoleState = await (
        await fetch(`${base}/sessions`, { method: "POST", body: JSON.stringify(c) })
      ).json()
      const state = async (): Promise<ConsoleState> =>
        (await fetch(`${base}/sessions/${s.id}/state`)).json()
      await page.goto(`${base}/sessions/${s.id}`)
      assert(!(await page.locator("body").innerText()).includes("交接核查"))
      assert.equal(evaluateConsole(c, await state(), true).passed, false)
      const click = async (name: string) => {
        await Promise.all([
          page.waitForEvent("load"),
          page.getByRole("button", { name, exact: true }).first().click(),
        ])
      }
      await click("数据与存储")
      await click("关系型数据库")
      await click("华北二")
      if (c.missing) {
        assert.equal(evaluateConsole(c, await state(), false).passed, false)
        assert.equal(evaluateConsole(c, await state(), true).passed, true)
        await click("管理 db-eval-2090")
        assert.equal(evaluateConsole(c, await state(), true).passed, false)
      } else {
        await click("管理 " + c.instance)
        await click("备份与恢复")
        await click("归档日志")
        assert.equal(
          evaluateConsole(c, await state(), false).passed,
          c.expect === "navigation"
        )
        await click("最近30分钟")
        await click("仅异常")
        if (c.expect === "policy")
          assert.equal(evaluateConsole(c, await state(), false).passed, false)
        await click("应用筛选")
        assert.equal(evaluateConsole(c, await state(), false).passed, true)
      }
    }
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
