import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { pool } from "@/db"
import { setEvolutionEnabled, writeImprovement } from "@/lib/evolution/store"
const sh = promisify(execFile)
const docker = async (...args: string[]) => (await sh("docker", args)).stdout.trim()
const until = async (fn: () => Promise<boolean>, desc: string, ms = 120000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > ms) throw Error(desc)
    await delay(400)
  }
}
const {
  INSTALL_ID: id,
  APP_URL: url,
  B2_IMAGE_WEB: web,
  B2_IMAGE_WORKER: worker,
  B2_IMAGE_REVISION: rev,
  B2_EVIDENCE: out,
} = process.env
const goal = "trial-proof",
  v = "trial-ready-1",
  key = "trial-" + id
const pfx = `pa-${id!.slice(0, 8)}-cand-${key}`
assert.equal(url, "http://127.0.0.1:17231")
assert.equal(process.env.OWNER_EMAIL, "trial-owner@fixture.test")
const dbURL = new URL(process.env.DATABASE_URL!)
assert.equal(dbURL.hostname, "127.0.0.1")
assert.equal(
  await docker(
    "inspect",
    "-f",
    '{{index .Config.Labels "owndesk.test"}}',
    process.env.B2_TEST_PG!
  ),
  "b2-owner-trial"
)
assert.equal(
  await docker("port", process.env.B2_TEST_PG!, "5432/tcp"),
  "127.0.0.1:" + dbURL.port
)
const owner = (await pool.query("select user_id from owners")).rows[0].user_id,
  agent = (await pool.query("select id from agents limit 1")).rows[0].id
await pool.query(
  "insert into agent_versions(id,label,kind,source_revision,git_commit,web_image_id,worker_image_id,images,status,created_at) values($1,'Test candidate','local',$2,$2,$3,$4,'{}','ready',now())",
  [v, rev, web, worker]
)
await setEvolutionEnabled(true)
const now = new Date().toISOString()
await writeImprovement({
  objectiveId: goal,
  ownerId: owner,
  agentId: agent,
  title: "Notebook candidate",
  request: "Save entry",
  checklist: ["save"],
  baseVersionId: null,
  baseCommit: rev!,
  status: "ready",
  candidates: [
    {
      roundNo: 1,
      branch: "fixture",
      parent: rev!,
      commit: rev!,
      taskId: "fixture",
      phase: "done",
      versionId: v,
      evaluation: {
        passed: true,
        stages: [],
        acceptance: [],
        suiteRevision: rev!,
        startedAt: now,
        finishedAt: now,
      },
    },
  ],
  createdAt: now,
  updatedAt: now,
})
const browser = await chromium.launch({
  executablePath: process.env.B2_CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const act = `/api/improvements/${goal}`
const api = (body: unknown) =>
  page.request.post(url + act, { headers: { Origin: url! }, data: body })
const gone = async () =>
  !(await docker("ps", "-aq", "--filter", `label=owndesk.lab.stack=${key}`)) &&
  !(await docker("volume", "ls", "-q", "--filter", `name=^${pfx}-artifacts$`)) &&
  !(await docker("network", "ls", "-q", "--filter", `name=^${pfx}-net$`))
let session = ""
let sig = ""
const open = async () => {
  const f = page.waitForResponse(
    (r) => r.url().endsWith(act) && r.request().postDataJSON().command?.action === "open"
  )
  await page.getByRole("button", { name: "试用这个版本" }).click()
  const r = await f
  assert.equal(r.status(), 200)
  session = (await r.json()).session
  await page
    .getByRole("button", { name: "候选网页，点击页面或使用键盘" })
    .waitFor({ timeout: 180000 })
}
const hit = async (fn: () => Promise<unknown>, action = "input") => {
  const f = page.waitForResponse(
    (r) => r.url().endsWith(act) && r.request().postDataJSON().command?.action === action
  )
  await fn()
  const r = await f
  assert.equal(r.status(), 200)
  return r.json()
}
try {
  const login = await page.request.post(url + "/api/auth/sign-in/email", {
    headers: { Origin: url! },
    data: { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD },
  })
  assert(login.ok())
  await page.goto(url + "/improvements")
  await open()
  console.log("PASS signed-in owner opened pinned built images in real Chromium")
  const bad = await api({
    action: "trial",
    command: { action: "view", versionId: "another", session },
  })
  assert.equal(bad.status(), 410)
  const staleAdoption = await api({ action: "adopt", versionId: "obsolete" })
  assert.equal(staleAdoption.status(), 409)
  assert.equal(
    (
      await api({ action: "trial", command: { action: "view", versionId: v, session } })
    ).status(),
    200
  )
  const obs = await docker(
    "inspect",
    "-f",
    "{{.Image}} {{len .HostConfig.PortBindings}}",
    pfx + "-web"
  )
  assert.equal(obs, web + " 0")
  const innerPg = pfx + "-postgres"
  const inner = async (q: string) =>
    docker(
      "exec",
      innerPg,
      "psql",
      "-XqAt",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "-c",
      q
    )
  assert.notEqual(await inner("select user_id from owners"), owner)
  assert.equal(await inner("select count(*) from agents where name='预览助手'"), "1")
  await page.getByLabel("候选页面路径").fill("/trial-check.html")
  const fixture = await hit(() => page.getByRole("button", { name: "打开页面" }).click())
  assert.equal(
    fixture.title,
    "Candidate notebook",
    "built candidate must render the feature page before input"
  )
  const screen = page.getByRole("button", { name: "候选网页，点击页面或使用键盘" })
  const coordinate = async (x: number, y: number) => {
    await screen.scrollIntoViewIfNeeded()
    const rect = (await screen.boundingBox())!
    await hit(() =>
      page.mouse.click(rect.x + (rect.width * x) / 1080, rect.y + (rect.height * y) / 720)
    )
  }
  await coordinate(100, 90)
  sig = "Trial-" + randomUUID().slice(0, 8)
  await page.getByLabel("输入到选中的候选控件").fill(sig)
  await hit(() => page.getByRole("button", { name: "输入", exact: true }).click())
  await coordinate(110, 210)
  await until(
    async () => (await inner(`select count(*) from agents where name='${sig}'`)) === "1",
    "candidate did not save"
  )
  assert.equal(
    (await pool.query("select count(*)::int n from agents where name=$1", [sig])).rows[0]
      .n,
    0
  )
  await hit(() => page.getByRole("button", { name: "查看当前画面" }).click(), "view")
  await page.getByAltText("Saved " + sig).waitFor()
  console.log(
    "PASS owner mouse/text changed candidate only; response was rendered in the real trial frame"
  )
  await hit(() => page.getByRole("button", { name: "关闭试用" }).click(), "close")
  assert(await gone())
  console.log("PASS close removed containers, network and volume")
  const stale = (
    await api({ action: "trial", command: { action: "view", versionId: v, session } })
  ).status()
  assert.equal(stale, 410)
  await open()
  assert.equal(await inner(`select count(*) from agents where name='${sig}'`), "0")
  // This installation has no active/base version: adoption must close the trial,
  // then refuse the stale switch without starting a deployment.
  const refusal = page.waitForResponse(
    (r) => r.url().endsWith(act) && r.request().postDataJSON().action === "adopt"
  )
  await page.getByRole("button", { name: "采用", exact: true }).click()
  assert.equal((await refusal).status(), 409)
  await until(gone, "adopt preflight did not close trial")
  assert.equal((await pool.query("SELECT count(*)::int n FROM deployments")).rows[0].n, 0)
  await open()
  await page.getByRole("button", { name: "放弃", exact: true }).click()
  await until(gone, "abandon cleanup")
  await until(
    async () =>
      (await pool.query("select status from agent_versions where id=$1", [v])).rows[0]
        .status === "rejected",
    "not abandoned"
  )
  // Transport-only regression: the real switch is tested on the Docker deployment.
  // Drop the browser response and persist the server outcome in this fixture DB.
  await pool.query(
    "UPDATE settings SET value=(value::jsonb || jsonb_build_object('status','ready'))::text WHERE key=$1",
    ["evolution.improvement." + goal]
  )
  await page.reload()
  let posts = 0
  const deploymentId = randomUUID().slice(0, 12)
  await page.route("**" + act, async (route) => {
    if (route.request().postDataJSON()?.action !== "adopt") return route.continue()
    posts++
    assert.equal(route.request().postDataJSON().versionId, v)
    await pool.query(
      "UPDATE settings SET value=(value::jsonb || jsonb_build_object('status','adopted','adoption',jsonb_build_object('versionId',$2::text,'roundNo',1,'at',now(),'deploymentId',$3::text,'outcome','healthy')))::text WHERE key=$1",
      ["evolution.improvement." + goal, v, deploymentId]
    )
    await route.abort("connectionreset")
  })
  await page.getByRole("button", { name: "采用", exact: true }).click()
  await page.getByTestId("improvement-status").filter({ hasText: "已采用" }).waitFor()
  await until(
    async () => (await page.getByText("正在核对采用结果，请稍候。").count()) === 0,
    "pending confirmation"
  )
  assert.equal(posts, 1)
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: /Failed to fetch|未确认/ })
      .count(),
    0
  )
  console.log(
    "PASS browser reconciled a lost response against the exact saved candidate and deployment; one POST"
  )
  await writeFile(
    out + "/receipt.json",
    JSON.stringify({
      pinnedWeb: web,
      pinnedWorker: worker,
      candidateRow: sig,
      candidateCount: 1,
      ownerCount: 0,
      publishedPorts: 0,
      staleStatus: stale,
      explicitCloseClean: true,
      abandonClean: true,
      refusedAdoptionClean: true,
    })
  )
  console.log(
    "PASS second trial had fresh data; abandoning candidate reclaimed all trial resources"
  )
} finally {
  try {
    if (session)
      await api({ action: "trial", command: { action: "close", versionId: v, session } })
  } finally {
    await browser.close()
    await pool.end()
  }
}
