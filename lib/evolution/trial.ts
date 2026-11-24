import { needsCandidateWorkstation } from "./policy"
import { randomUUID } from "node:crypto"
import type { Page } from "playwright"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { agentVersions } from "@/db/schema"
import { docker } from "@/lib/docker"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"

import { CandidateSession, removeCandidateStack, startCandidateStack } from "./evaluator"
import { startReviewBrowser } from "./browser"
import { evolutionEnabled, readImprovement } from "./store"
import { trialViewport, type TrialCommand, type TrialFrame } from "./trial-input"

const key = () => `trial-${env.INSTALL_ID}`
type Trial = {
  id: string
  owner: string
  goal: string
  version: string
  phase: "starting" | "ready" | "failed"
  origin?: string
  page?: Page
  browser?: Awaited<ReturnType<typeof startReviewBrowser>>
  timer?: NodeJS.Timeout
}
let current: Trial | undefined
let tail = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job)
  tail = run.then(
    () => {},
    () => {}
  )
  return run
}
async function reclaim() {
  await removeCandidateStack(key())
  const prefix = `pa-${env.INSTALL_ID.slice(0, 8)}-cand-${key()}`
  const queries = [
    ["ps", "-aq", "--filter", `label=owndesk.lab.stack=${key()}`],
    ["volume", "ls", "-q", "--filter", `name=^${prefix}-artifacts$`],
    ["network", "ls", "-q", "--filter", `name=^${prefix}-net$`],
  ]
  for (const query of queries)
    if ((await docker(query)).stdout.toString().trim())
      throw new HttpError(503, "试用资源尚未释放，请再关闭一次")
}
async function clear() {
  const t = current
  if (t?.timer) clearTimeout(t.timer)
  try {
    await t?.browser?.close()
  } finally {
    await reclaim()
    current = undefined
  }
}
export function closeTrialAtShutdown() {
  return serial(async () => {
    if (current) await clear()
  })
}
export function reclaimTrialAtStartup() {
  return serial(reclaim)
}
export function withTrialClosed<T>(
  owner: string,
  goal: string,
  change: () => Promise<T>,
  expectedVersion?: string
) {
  return serial(async () => {
    if (current?.owner === owner && current.goal === goal) {
      if (expectedVersion && expectedVersion !== current.version)
        throw new HttpError(409, "试用版本已经变化，请刷新后再采用")
      await clear()
    }
    return change()
  })
}
function touch(t: Trial) {
  if (t.timer) clearTimeout(t.timer)
  t.timer = setTimeout(() => {
    void serial(async () => {
      if (current === t) await clear()
    }).catch(() => console.warn("Trial cleanup pending"))
  }, 15 * 60_000)
  t.timer.unref()
}
async function target(owner: string, goal: string, version: string) {
  const item = await readImprovement(goal),
    last = item?.candidates.at(-1)
  if (!item || item.ownerId !== owner) throw new HttpError(404, "找不到改进")
  if (
    item.status !== "ready" ||
    last?.versionId !== version ||
    !last.evaluation?.passed ||
    !last.commit
  )
    throw new HttpError(409, "候选版本已变化，请从最新报告打开")
  const [v] = await db.select().from(agentVersions).where(eq(agentVersions.id, version))
  if (
    !v ||
    v.status !== "ready" ||
    v.gitCommit !== last.commit ||
    v.kind !== "local" ||
    ![v.webImageId, v.workerImageId].every((v) => /^sha256:[0-9a-f]{64}$/.test(v))
  )
    throw new HttpError(409, "候选镜像尚未就绪")
  return {
    web: v.webImageId,
    worker: v.workerImageId,
    workstation: needsCandidateWorkstation((last.files ?? []).map((file) => file.path)),
  }
}
async function launch(
  t: Trial,
  images: { web: string; worker: string; workstation: boolean }
) {
  try {
    const stack = await startCandidateStack({
      key: key(),
      images,
      trial: true,
      workstation: images.workstation,
      log: () => {},
    })
    const session = new CandidateSession(stack)
    await session.signIn()
    t.browser = await startReviewBrowser(stack)
    const context = await t.browser.browser.newContext({
      viewport: trialViewport,
      serviceWorkers: "block",
      acceptDownloads: false,
    })
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === stack.appUrl
        ? route.continue()
        : route.abort()
    )
    await context.routeWebSocket("**/*", (r) => r.close())
    await context.addCookies(
      session.cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: stack.appUrl,
        }))
    )
    const page = await context.newPage()
    t.page = page
    t.origin = stack.appUrl
    page.setDefaultTimeout(8000)
    await page.goto(stack.appUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
    t.phase = "ready"
    touch(t)
  } catch {
    try {
      await t.browser?.close()
    } finally {
      t.phase = "failed"
      try {
        await reclaim()
      } finally {
        touch(t)
      }
    }
  }
}
export async function trial(
  owner: string,
  goal: string,
  cmd: TrialCommand
): Promise<TrialFrame> {
  // A polling client must not queue up behind the initial container build/start.
  if (
    cmd.action === "view" &&
    current?.id === cmd.session &&
    current.owner === owner &&
    current.goal === goal &&
    current.version === cmd.versionId &&
    current.phase === "starting"
  )
    return { session: current.id, state: "starting" }
  return serial(async () => {
    if (cmd.action === "open") {
      if (!(await evolutionEnabled())) throw new HttpError(409, "请先打开自我改进")
      const images = await target(owner, goal, cmd.versionId)
      if (
        current &&
        current.phase !== "failed" &&
        (current.owner !== owner ||
          current.goal !== goal ||
          current.version !== cmd.versionId)
      )
        throw new HttpError(409, "请先关闭已打开的候选试用")
      if (current?.phase === "failed") await clear()
      if (!current) {
        const t: Trial = {
          id: randomUUID(),
          owner,
          goal,
          version: cmd.versionId,
          phase: "starting",
        }
        current = t
        void serial(() => launch(t, images)).catch(() =>
          console.warn("Candidate trial initialization failed")
        )
      }
      return {
        session: current.id,
        state: current.phase === "ready" ? "ready" : "starting",
      }
    }
    const t = current
    if (
      !t ||
      t.id !== cmd.session ||
      t.owner !== owner ||
      t.goal !== goal ||
      t.version !== cmd.versionId
    )
      throw new HttpError(410, "这次试用已结束")
    if (cmd.action === "close") {
      await clear()
      return { session: t.id, state: "closed" }
    }
    if (t.phase === "failed") {
      await clear()
      throw new HttpError(503, "候选网页启动失败，请重新打开试用")
    }
    if (!(await evolutionEnabled())) {
      await clear()
      throw new HttpError(410, "自我改进已关闭，本次试用已结束")
    }
    await target(owner, goal, t.version)
    touch(t)
    const page = t.page
    if (!page) return { session: t.id, state: "starting" }
    if (cmd.action === "input") {
      const e = cmd.event
      switch (e.type) {
        case "click":
          await page.mouse.click(e.x, e.y)
          break
        case "text":
          await page.keyboard.insertText(e.text)
          break
        case "key":
          await page.keyboard.press(e.key)
          break
        case "scroll":
          await page.mouse.wheel(0, e.y)
          break
        case "navigate": {
          const target = new URL(e.path, t.origin)
          if (target.origin !== t.origin) throw new HttpError(400, "只能打开候选内的页面")
          await page.goto(target.href, { waitUntil: "domcontentloaded" })
          break
        }
        case "refresh":
          await page.reload({ waitUntil: "domcontentloaded" })
          break
      }
    }
    return {
      session: t.id,
      state: "ready",
      image: (
        await page.screenshot({ type: "jpeg", quality: 70, timeout: 8000 })
      ).toString("base64"),
      title: (await page.title()).slice(0, 120),
    }
  })
}
