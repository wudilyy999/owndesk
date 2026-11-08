import { createServer } from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { mkdir, rename, readFile, writeFile, readdir, stat, open } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { chromium } from "playwright-core"
import { z } from "zod"
import { nativeSchemas } from "./native-schema.mjs"
import { runProcess, stopProcessGroups, shellUsed } from "./processes.mjs"
import {
  captureDesktop,
  nativeDesktop,
  desktopInput,
  invalidateDesktopObservation,
  openDesktopApplication,
} from "./desktop.mjs"

const token = process.env.PA_WORKSPACE_TOKEN
if (!token || token.length < 32) throw new Error("PA_WORKSPACE_TOKEN must be configured")
// The errand profile is the one the person's desktop browser uses. A companion's own
// browsing keeps its cookies and history in a separate profile.
const profiles = {
  errand: "/home/agent/.config/owndesk-browser",
  life: "/home/agent/.config/owndesk-life-browser",
}
let profileName = "errand"
const bootId = randomUUID()
const journalDir = "/home/agent/.local/state/personal-agent/actions"
await mkdir(journalDir, { recursive: true })

let epoch = 0
let mode = "idle"
let active = 0
const operations = new Map()
const pending = () =>
  [...operations.values()].filter(
    (o) => o.status === "starting" || o.status === "running"
  )
const pages = new Map()
function track(page) {
  const id = randomUUID()
  const state = { id, page, observation: null }
  pages.set(id, state)
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) state.observation = null
  })
  page.on("close", () => pages.delete(id))
}
let browser
let firstPage
function ensureBrowser() {
  browser ??= chromium
    .launchPersistentContext(profiles[profileName], {
      executablePath: "/usr/bin/chromium",
      headless: false,
      viewport: null,
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
      acceptDownloads: true,
      downloadsPath: "/home/agent/Downloads/.inflight",
      args: [
        "--no-sandbox",
        "--test-type",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--start-maximized",
        "--hide-crash-restore-bubble",
      ],
    })
    .then((context) => {
      firstPage = context.pages().find((page) => page.url() === "about:blank")
      context.pages().forEach(track)
      context.on("page", track)
      context.on("close", () => {
        browser = undefined
        firstPage = undefined
      })
      return context
    })
    .catch((error) => {
      browser = undefined
      throw error
    })
  return browser
}

const base = z.object({ epoch: z.number().int().nonnegative() })
const pageInput = base.extend({ pageId: z.uuid() })
const actionInput = pageInput.extend({
  observationId: z.uuid(),
  ref: z.string().regex(/^r\d+$/),
})
const openInput = base.extend({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
})
const controlInput = z.object({
  epoch: z.number().int().nonnegative(),
  mode: z.enum(["idle", "agent", "quiescing", "human", "quarantined"]),
  profile: z.enum(["errand", "life"]).default("errand"),
})
const vaultField = z.enum([
  "username",
  "password",
  "code",
  "name",
  "email",
  "phone",
  "address",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postcode",
  "country",
  "number",
  "expiry",
  "expiry_month",
  "expiry_year",
  "expiry_year_short",
  "id",
])
const paymentRefs = z.object({
  merchant: z.string().regex(/^t\d+$/),
  amount: z.string().regex(/^t\d+$/),
})
const paymentText = z.object({
  ref: z.string().regex(/^t\d+$/),
  tag: z.string().max(40),
  text: z.string().min(1).max(500),
})
const paymentEvidence = z.object({ merchant: paymentText, amount: paymentText })
const paymentInspectInput = pageInput.extend({
  observationId: z.uuid(),
  evidenceRefs: paymentRefs,
})
const vaultBinding = z.object({
  field: vaultField,
  ref: z.string().regex(/^r\d+$/),
})
const vaultInspectInput = pageInput.extend({
  observationId: z.uuid(),
  fields: z.array(vaultBinding).min(1).max(10),
  payment: z.object({ evidence: paymentEvidence }).optional(),
})
const vaultDescriptor = z.object({
  tag: z.enum(["input", "textarea"]),
  type: z.string().max(40),
  name: z.string().max(200),
  autocomplete: z.string().max(100),
})
const vaultFillInput = vaultInspectInput.extend({
  origin: z.string(),
  bootId: z.uuid(),
  fields: z
    .array(vaultBinding.extend({ descriptor: vaultDescriptor }))
    .min(1)
    .max(10),
})
const submitInspectInput = actionInput.extend({ evidenceRefs: paymentRefs })
const paymentTarget = z.object({
  tag: z.enum(["button", "input"]),
  type: z.enum(["button", "submit"]),
  label: z.string().min(1).max(200),
  formAction: z.string().max(2048),
  formMethod: z.enum(["", "get", "post"]),
})
const submitInput = actionInput.extend({
  origin: z.string(),
  bootId: z.uuid(),
  expiresAt: z.iso.datetime(),
  submissionRequestId: z.string(),
  evidence: paymentEvidence,
  target: paymentTarget,
})
const resultInput = pageInput.extend({
  observationId: z.uuid(),
  submissionRequestId: z.string(),
  origin: z.string(),
  merchant: z.string(),
  amount: z.string(),
  evidenceRefs: paymentRefs.extend({
    status: z.string().regex(/^t\d+$/),
    receipt: z.string().regex(/^t\d+$/),
  }),
})

async function inspectSubmission(input) {
  const evidence = await readPaymentEvidence(input)
  const { state, locator } = getLocator(input)
  if (
    (await locator.count()) !== 1 ||
    !(await locator.isVisible()) ||
    !(await locator.isEnabled())
  )
    throw Object.assign(new Error("Payment button is not uniquely available"), {
      status: 409,
    })
  const raw = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    type: element.type,
    label: (
      element.getAttribute("aria-label") ||
      (element.tagName === "INPUT" ? element.value : element.innerText) ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
    formAction: element.form
      ? element.hasAttribute("formaction")
        ? element.formAction
        : element.form.action
      : "",
    formMethod: element.form
      ? (element.getAttribute("formmethod") || element.form.method).toLowerCase()
      : "",
  }))
  const parsed = paymentTarget.safeParse(raw)
  if (
    !parsed.success ||
    (raw.tag === "input" && raw.type !== "submit") ||
    (raw.formAction && new URL(raw.formAction).origin !== evidence.origin)
  )
    throw Object.assign(new Error("Unsupported payment button/form; take over"), {
      status: 409,
    })
  requireAgent(input)
  return { state, locator, inspection: { ...evidence, target: parsed.data } }
}

async function vaultTarget(input, binding) {
  const { state, locator } = getLocator({ ...input, ref: binding.ref })
  if (
    (await locator.count()) !== 1 ||
    !(await locator.isVisible()) ||
    !(await locator.isEditable())
  )
    throw Object.assign(new Error("Vault target is not uniquely editable"), {
      status: 409,
    })
  const descriptor = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    type: element.type ?? "textarea",
    name: (
      element.getAttribute("aria-label") ??
      element.getAttribute("placeholder") ??
      element.getAttribute("name") ??
      ""
    ).slice(0, 200),
    autocomplete: (element.getAttribute("autocomplete") ?? "").slice(0, 100),
  }))
  if (
    !["input", "textarea"].includes(descriptor.tag) ||
    (descriptor.tag === "input" &&
      !["text", "password", "email", "tel", "url", "search", "number"].includes(
        descriptor.type
      ))
  )
    throw Object.assign(new Error("Vault target type is not supported"), { status: 409 })
  return { state, locator, descriptor }
}

function requireAgent(input) {
  if (input.epoch !== epoch)
    throw Object.assign(new Error("Stale workspace epoch"), { status: 409 })
  if (mode !== "agent")
    throw Object.assign(new Error(`Workspace is ${mode}; agent input disabled`), {
      status: 409,
    })
}
function getPage(input) {
  if (input.epoch !== epoch)
    throw Object.assign(new Error("Stale workspace epoch"), { status: 409 })
  const state = pages.get(input.pageId)
  if (!state)
    throw Object.assign(new Error("Page no longer exists; observe again"), {
      status: 409,
    })
  return state
}
function getLocator(input) {
  requireAgent(input)
  const state = getPage(input)
  if (state.observation !== input.observationId)
    throw Object.assign(new Error("Stale observation; observe again"), { status: 409 })
  return { state, locator: state.page.locator(`[data-pa-ref="${input.ref}"]`) }
}

async function readPaymentEvidence(input) {
  requireAgent(input)
  const state = getPage(input)
  if (state.observation !== input.observationId)
    throw Object.assign(new Error("Stale payment observation"), { status: 409 })
  if (
    new Set(Object.values(input.evidenceRefs)).size !==
    Object.keys(input.evidenceRefs).length
  )
    throw Object.assign(new Error("Payment text references must differ"), { status: 409 })
  const evidence = {}
  for (const key of Object.keys(input.evidenceRefs)) {
    const ref = input.evidenceRefs[key]
    const locator = state.page.locator(`[data-pa-text-ref="${ref}"]`)
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
      throw Object.assign(new Error("Payment source is no longer uniquely visible"), {
        status: 409,
      })
    const source = await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      text: element.innerText.replace(/\s+/g, " ").trim(),
      leaf: element.childElementCount === 0,
    }))
    if (!source.leaf || !source.text || source.text.length > 500)
      throw Object.assign(new Error("Payment source is unsupported"), { status: 409 })
    evidence[key] = { ref, tag: source.tag, text: source.text }
  }
  return { origin: new URL(state.page.url()).origin, epoch, bootId, evidence }
}

async function assertPaymentEvidence(input) {
  if (!input.payment) return
  const actual = await readPaymentEvidence({
    ...input,
    evidenceRefs: {
      merchant: input.payment.evidence.merchant.ref,
      amount: input.payment.evidence.amount.ref,
    },
  })
  if (!isDeepStrictEqual(actual.evidence, input.payment.evidence))
    throw Object.assign(new Error("Payment page text changed"), { status: 409 })
}

// OwnDesk path convention: relative paths and ~/ start at the workstation home.
function resolvePath(input) {
  const value = input.trim() || "."
  if (value === "~") return "/home/agent"
  if (value.startsWith("~/")) return `/home/agent/${value.slice(2)}`
  return path.resolve("/home/agent", value)
}

const actionEnvelope = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._:-]{1,180}$/),
  kind: z.enum([
    "shell",
    "fs_read",
    "fs_write",
    "fs_list",
    "screen_capture",
    "screen_share",
    "pointer_click",
    "pointer_move",
    "pointer_drag",
    "pointer_scroll",
    "key_type",
    "key_press",
    "desktop_open_application",
    ...Object.keys(nativeSchemas),
    "open",
    "pages",
    "observe",
    "click",
    "fill",
    "screenshot",
    "download",
    "vault_fill",
    "payment_submit",
    "payment_result",
  ]),
  params: z.record(z.string(), z.unknown()),
  transient: z
    .array(
      z.object({
        field: vaultField,
        value: z.string().min(1).max(1500),
      })
    )
    .min(1)
    .max(10)
    .optional(),
})

async function savedAction(id) {
  try {
    return JSON.parse(
      await readFile(path.join(journalDir, `${encodeURIComponent(id)}.json`), "utf8")
    )
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}
async function saveAction(operation) {
  const target = path.join(journalDir, `${encodeURIComponent(operation.id)}.json`)
  const { completion, ...data } = operation
  await writeFile(`${target}.partial`, JSON.stringify(data), { mode: 0o600 })
  await rename(`${target}.partial`, target)
}
async function actionStatus(id) {
  const operation = operations.get(id) ?? (await savedAction(id))
  if (!operation) return { found: false, bootId }
  const { completion, ...data } = operation
  if (operation.bootId !== bootId && ["starting", "running"].includes(operation.status)) {
    return {
      found: true,
      ...data,
      status: "unknown",
      error: "Controller restarted while the action had no final receipt",
      currentBootId: bootId,
    }
  }
  return { found: true, ...data, currentBootId: bootId }
}
function startAction(raw) {
  const { transient, ...input } = actionEnvelope.parse(raw)
  if ((input.kind === "vault_fill") !== (transient !== undefined))
    throw Object.assign(new Error("Sensitive values require the dedicated fill action"), {
      status: 400,
    })
  const existing = operations.get(input.id)
  if (existing) {
    if (existing.kind !== input.kind || !isDeepStrictEqual(existing.params, input.params))
      throw Object.assign(new Error("Action ID reused with different parameters"), {
        status: 409,
      })
    return { accepted: true, id: input.id }
  }
  const operation = {
    ...input,
    bootId,
    status: "starting",
    startedAt: new Date().toISOString(),
  }
  operations.set(input.id, operation)
  operation.completion = (async () => {
    const previous = await savedAction(input.id)
    if (previous) {
      if (
        previous.kind !== input.kind ||
        !isDeepStrictEqual(previous.params, input.params)
      ) {
        Object.assign(operation, {
          status: "rejected",
          error: "Action ID reused with different persisted parameters",
        })
        return
      }
      Object.assign(operation, previous)
      if (["starting", "running"].includes(previous.status))
        Object.assign(operation, {
          status: "unknown",
          error: "Action was interrupted; reconcile its external effect",
        })
      if (["succeeded", "rejected"].includes(previous.status)) operations.delete(input.id)
      return
    }
    let dispatched = false
    try {
      operation.status = "running"
      await saveAction(operation)
      dispatched = true
      operation.result = await dispatch(
        `/${input.kind}`,
        input.params,
        input.id,
        transient
      )
      operation.status = "succeeded"
    } catch (error) {
      operation.status =
        !dispatched || error instanceof z.ZodError || error.status === 409
          ? "rejected"
          : "unknown"
      operation.error = error.message
      if (
        (input.kind === "vault_fill" || input.kind in nativeSchemas) &&
        error.safeResult
      )
        operation.result = error.safeResult
    }
    operation.finishedAt = new Date().toISOString()
    await saveAction(operation)
    operations.delete(input.id) // Durable receipts stay on disk; completed screenshots do not accumulate in memory.
  })()
  operation.completion.catch((error) => {
    operation.status = "unknown"
    operation.error = `Action journal failed: ${error.message}`
    console.error("Workspace action journal failed", error)
  })
  return { accepted: true, id: input.id }
}

async function dispatch(route, body, actionId = randomUUID(), transient) {
  if (
    [
      "/quiesce",
      "/shell",
      "/open",
      "/desktop-browser",
      "/click",
      "/fill",
      "/download",
      "/vault_fill",
      "/payment_submit",
    ].includes(route)
  )
    invalidateDesktopObservation()
  if (route === "/payment-submit-inspect")
    return (await inspectSubmission(submitInspectInput.parse(body))).inspection
  if (route === "/payment_submit") {
    const input = submitInput.parse(body)
    const { state, locator, inspection } = await inspectSubmission({
      ...input,
      evidenceRefs: {
        merchant: input.evidence.merchant.ref,
        amount: input.evidence.amount.ref,
      },
    })
    if (
      input.bootId !== bootId ||
      !isDeepStrictEqual(inspection, {
        origin: input.origin,
        epoch: input.epoch,
        bootId: input.bootId,
        evidence: input.evidence,
        target: input.target,
      }) ||
      Date.now() >= Date.parse(input.expiresAt)
    )
      throw Object.assign(
        new Error("Payment authorization/page/button changed before click"),
        { status: 409 }
      )
    state.observation = null
    try {
      await locator.click({ timeout: 10000 })
    } catch {
      throw Object.assign(
        new Error("Payment click outcome unknown; inspect without repeating"),
        { status: 500 }
      )
    }
    return {
      clicked: true,
      origin: input.origin,
      submissionRequestId: input.submissionRequestId,
      verification: "dispatch_only",
    }
  }
  if (route === "/payment_result") {
    const input = resultInput.parse(body)
    const actual = await readPaymentEvidence(input)
    if (
      actual.origin !== input.origin ||
      actual.evidence.merchant.text !== input.merchant ||
      actual.evidence.amount.text !== input.amount
    )
      throw Object.assign(
        new Error("Payment result site/merchant/amount does not match; inspect manually"),
        { status: 409 }
      )
    return {
      ...actual,
      submissionRequestId: input.submissionRequestId,
      verification: "page_text_only",
    }
  }
  if (route === "/payment-inspect")
    return readPaymentEvidence(paymentInspectInput.parse(body))
  if (route === "/vault-inspect" || route === "/vault_fill") {
    let safeResult
    let state
    try {
      const input = (
        route === "/vault-inspect" ? vaultInspectInput : vaultFillInput
      ).parse(body)
      requireAgent(input)
      if (
        new Set(input.fields.map((f) => f.field)).size !== input.fields.length ||
        new Set(input.fields.map((f) => f.ref)).size !== input.fields.length
      )
        throw Object.assign(new Error("Duplicate sensitive target"), { status: 409 })
      state = getPage(input)
      const origin = new URL(state.page.url()).origin
      if (!["https:", "http:"].includes(new URL(state.page.url()).protocol))
        throw Object.assign(new Error("Unsupported sensitive origin"), { status: 409 })
      if (route === "/vault_fill" && (input.bootId !== bootId || input.origin !== origin))
        throw Object.assign(new Error("Sensitive site or boot changed"), { status: 409 })
      safeResult = { origin, filled: [], attempted: [], stage: "preflight" }
      await assertPaymentEvidence(input)
      const fields = []
      for (const binding of input.fields) {
        const target = await vaultTarget(input, binding)
        if (
          route === "/vault_fill" &&
          !isDeepStrictEqual(target.descriptor, binding.descriptor)
        )
          throw Object.assign(new Error("Sensitive target changed"), { status: 409 })
        fields.push({ ...binding, descriptor: target.descriptor })
      }
      if (route === "/vault-inspect") return { origin, epoch, bootId, fields }
      if (
        !transient ||
        transient.length !== fields.length ||
        transient.some((value, i) => value.field !== fields[i].field)
      )
        throw Object.assign(new Error("Sensitive values do not match approved fields"), {
          status: 409,
        })
      safeResult.stage = "fill"
      for (let i = 0; i < fields.length; i++) {
        const binding = fields[i],
          target = await vaultTarget(input, binding)
        if (
          new URL(target.state.page.url()).origin !== origin ||
          !isDeepStrictEqual(target.descriptor, binding.descriptor)
        )
          throw Object.assign(new Error("Sensitive page changed"), { status: 409 })
        await assertPaymentEvidence(input)
        // Reduce accidental screenshot exposure without changing input semantics.
        // Site/guest code can still read values; this is no isolation boundary.
        await target.locator.evaluate((element) =>
          element.style.setProperty("-webkit-text-security", "disc", "important")
        )
        safeResult.attempted.push(binding.field)
        await target.locator.fill(transient[i].value, { timeout: 10000 })
        safeResult.filled.push(binding.field)
      }
      state.observation = null
      safeResult.stage = "done"
      return safeResult
    } catch (error) {
      if (route === "/vault_fill" && state) state.observation = null
      // Playwright can include fill arguments in its error log. Report only a
      // fixed category/stage and field names; never attach the original cause.
      const attempted = !!safeResult?.attempted.length
      const category =
        error instanceof z.ZodError || error.status === 409
          ? "stale_or_invalid"
          : error.name === "TimeoutError"
            ? "timeout"
            : "operation_failed"
      throw Object.assign(
        new Error(
          `Sensitive operation ${category} at ${safeResult?.stage ?? "preflight"}`
        ),
        {
          status: attempted ? 500 : category === "stale_or_invalid" ? 409 : 500,
          safeResult,
        }
      )
    }
  }
  if (route === "/quiesce") {
    const input = base.parse(body)
    if (input.epoch < epoch)
      throw Object.assign(new Error("Stale workspace epoch"), { status: 409 })
    mode = "quiescing"
    epoch = input.epoch
    for (const state of pages.values()) state.observation = null
    await stopProcessGroups()
    return { epoch, mode, bootId, active: pending().length + active, shellUsed }
  }
  if (route === "/control") {
    const input = controlInput.parse(body)
    if (input.epoch < epoch)
      throw Object.assign(new Error("Control epoch cannot go backwards"), { status: 409 })
    if (active !== 0 || pending().length !== 0)
      throw Object.assign(
        new Error("An action is still running; control was not transferred"),
        { status: 409 }
      )
    if (input.epoch === epoch && input.mode !== mode)
      throw Object.assign(new Error("A control transfer must advance the epoch"), {
        status: 409,
      })
    if (input.profile !== profileName) {
      // The browser reopens on the other profile at its next use
      if (browser) await (await browser).close()
      profileName = input.profile
    }
    epoch = input.epoch
    mode = input.mode
    invalidateDesktopObservation()
    for (const state of pages.values()) state.observation = null
    return { epoch, mode, active, bootId, shellUsed }
  }
  if (route === "/shell") {
    const input = base
      .extend({
        command: z.string().min(1).max(100000),
        cwd: z.string().optional(),
        timeout: z.number().int().min(1).max(900).default(120),
      })
      .parse(body)
    requireAgent(input)
    return runProcess("bash", ["-lc", input.command], {
      actionId,
      cwd: resolvePath(input.cwd ?? "."),
      timeoutMs: input.timeout * 1000,
      shell: true,
    })
  }
  if (route === "/fs_read") {
    const input = base.extend({ path: z.string().min(1) }).parse(body)
    requireAgent(input)
    const target = resolvePath(input.path),
      info = await stat(target)
    const fd = await open(target, "r")
    const bytes = Buffer.alloc(Math.min(info.size, 1000000))
    try {
      await fd.read(bytes, 0, bytes.length, 0)
    } finally {
      await fd.close()
    }
    return {
      path: input.path,
      content: bytes.toString("utf8"),
      bytes: info.size,
      truncated: info.size > bytes.length,
    }
  }
  if (route === "/fs_write") {
    const input = base
      .extend({ path: z.string().min(1), content: z.string().max(1000000) })
      .parse(body)
    requireAgent(input)
    const target = resolvePath(input.path),
      temporary = `${target}.pa-${encodeURIComponent(actionId)}.partial`
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(temporary, input.content)
    await rename(temporary, target)
    return { path: input.path, bytes: Buffer.byteLength(input.content) }
  }
  if (route === "/fs_list") {
    const input = base.extend({ path: z.string().default(".") }).parse(body)
    requireAgent(input)
    const target = resolvePath(input.path)
    const entries = await Promise.all(
      (await readdir(target, { withFileTypes: true }))
        .slice(0, 500)
        .map(async (entry) => ({
          name: entry.name,
          dir: entry.isDirectory(),
          size: (await stat(path.join(target, entry.name))).size,
        }))
    )
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    return { path: input.path, entries }
  }
  if (route.slice(1) in nativeSchemas) {
    requireAgent(base.parse(body))
    return nativeDesktop(route.slice(1), body, actionId, { epoch, bootId })
  }
  if (route === "/screen_capture" || route === "/screen_share") {
    requireAgent(base.parse(body))
    return captureDesktop(actionId, { epoch, bootId })
  }
  if (route === "/desktop_open_application") {
    const input = base
      .extend({
        application: z.enum(["Thunar", "Browser", "Writer", "Calc", "Mousepad"]),
      })
      .parse(body)
    requireAgent(input)
    return openDesktopApplication(actionId, { epoch, bootId }, input.application)
  }
  if (
    [
      "pointer_click",
      "pointer_move",
      "pointer_drag",
      "pointer_scroll",
      "key_type",
      "key_press",
    ].includes(route.slice(1))
  ) {
    requireAgent(base.parse(body))
    return desktopInput(route.slice(1), body, actionId, { epoch, bootId })
  }
  if (route === "/pages") {
    const input = base.parse(body)
    if (input.epoch !== epoch)
      throw Object.assign(new Error("Stale workspace epoch"), { status: 409 })
    return {
      epoch,
      mode,
      pages: await Promise.all(
        [...pages.values()].map(async (s) => ({
          pageId: s.id,
          url: s.page.url(),
          title: await s.page.title(),
        }))
      ),
    }
  }
  if (route === "/open" || route === "/desktop-browser") {
    const input = openInput.parse(body)
    if (route === "/desktop-browser") {
      if (input.epoch !== epoch || !["idle", "human"].includes(mode))
        throw Object.assign(new Error("Desktop browser launch requires human control"), {
          status: 409,
        })
    } else requireAgent(input)
    const startingMode = mode
    const context = await ensureBrowser()
    if (input.epoch !== epoch || mode !== startingMode)
      throw Object.assign(new Error("Control changed while starting the browser"), {
        status: 409,
      })
    const initialPage = firstPage
    firstPage = undefined
    const page =
      initialPage && !initialPage.isClosed() ? initialPage : await context.newPage()
    await page.bringToFront()
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 })
    return {
      pageId: [...pages.values()].find((s) => s.page === page).id,
      url: page.url(),
    }
  }
  if (route === "/observe") {
    const input = pageInput.parse(body)
    const state = getPage(input)
    const observationId = randomUUID()
    const elements = await state.page
      .locator("a,button,input,textarea,select,[role=button],[contenteditable=true]")
      .evaluateAll((nodes) => {
        document
          .querySelectorAll("[data-pa-ref]")
          .forEach((n) => n.removeAttribute("data-pa-ref"))
        return nodes
          .filter((n) => {
            const r = n.getBoundingClientRect()
            return (
              r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"
            )
          })
          .slice(0, 150)
          .map((n, i) => {
            const ref = `r${i}`
            n.setAttribute("data-pa-ref", ref)
            return {
              ref,
              tag: n.tagName.toLowerCase(),
              name:
                n.getAttribute("aria-label") ??
                n.getAttribute("placeholder") ??
                n.getAttribute("name") ??
                n.textContent?.trim().slice(0, 160),
              type: n.getAttribute("type"),
            }
          })
      })
    const textRefs = await state.page.locator("body *").evaluateAll((nodes) => {
      document
        .querySelectorAll("[data-pa-text-ref]")
        .forEach((node) => node.removeAttribute("data-pa-text-ref"))
      return nodes
        .filter((node) => {
          if (
            !(node instanceof HTMLElement) ||
            node.childElementCount ||
            [
              "SCRIPT",
              "STYLE",
              "NOSCRIPT",
              "INPUT",
              "TEXTAREA",
              "SELECT",
              "OPTION",
            ].includes(node.tagName)
          )
            return false
          const text = node.innerText.replace(/\s+/g, " ").trim(),
            rect = node.getBoundingClientRect()
          return (
            text.length > 0 &&
            text.length <= 500 &&
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(node).visibility !== "hidden"
          )
        })
        .slice(0, 150)
        .map((node, index) => {
          const ref = `t${index}`
          node.setAttribute("data-pa-text-ref", ref)
          return {
            ref,
            tag: node.tagName.toLowerCase(),
            text: node.innerText.replace(/\s+/g, " ").trim(),
          }
        })
    })
    state.observation = observationId
    return {
      pageId: state.id,
      epoch,
      observationId,
      url: state.page.url(),
      title: await state.page.title(),
      text: (await state.page.locator("body").innerText()).slice(0, 20000),
      elements,
      textRefs,
    }
  }
  if (route === "/screenshot") {
    const input = pageInput.parse(body)
    const state = getPage(input)
    return {
      image: (await state.page.screenshot({ type: "jpeg", quality: 70 })).toString(
        "base64"
      ),
      mediaType: "image/jpeg",
      pageId: state.id,
      epoch,
    }
  }
  if (route === "/click") {
    const input = actionInput.parse(body)
    const { state, locator } = getLocator(input)
    await locator.click({ timeout: 15000 })
    state.observation = null
    return { clicked: true, url: state.page.url() }
  }
  if (route === "/fill") {
    const input = actionInput.extend({ text: z.string().max(50000) }).parse(body)
    const { state, locator } = getLocator(input)
    await locator.fill(input.text, { timeout: 15000 })
    state.observation = null
    return { filled: true }
  }
  if (route === "/download") {
    const input = actionInput
      .extend({ actionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
      .parse(body)
    const { state, locator } = getLocator(input)
    const [download] = await Promise.all([
      state.page.waitForEvent("download", { timeout: 30000 }),
      locator.click({ timeout: 15000 }),
    ])
    const directory = path.join("/home/agent/Downloads/agent", input.actionId)
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, path.basename(download.suggestedFilename()))
    await download.saveAs(`${target}.partial`)
    await rename(`${target}.partial`, target)
    state.observation = null
    return { path: target, name: path.basename(target), url: download.url() }
  }
  throw Object.assign(new Error("Unknown browser operation"), { status: 404 })
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        ready: true,
        protocolVersion: 6,
        capabilities: [
          "thunar-keyboard-v1",
          "desktop-apps-v1",
          "atspi-observation-v1",
          "atspi-native-v1",
        ],
        epoch,
        mode,
        bootId,
        active: active + pending().length,
        shellUsed,
      })
    )
    return
  }
  const supplied = Buffer.from(request.headers.authorization ?? "")
  const expected = Buffer.from(`Bearer ${token}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(401).end()
    return
  }
  if (request.method !== "POST") {
    response.writeHead(405).end()
    return
  }
  let entered = false
  try {
    let body = ""
    for await (const chunk of request) {
      body += chunk
      if (Buffer.byteLength(body) > 6000000)
        throw Object.assign(new Error("Request too large"), { status: 413 })
    }
    if (!["/control", "/quiesce", "/actions", "/action-status"].includes(request.url)) {
      active++
      entered = true
    }
    const parsed = JSON.parse(body)
    let result
    if (request.url === "/actions") result = startAction(parsed)
    else if (request.url === "/action-status")
      result = await actionStatus(actionEnvelope.shape.id.parse(parsed.id))
    else result = await dispatch(request.url, parsed)
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(result))
  } catch (error) {
    const status =
      error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : (error.status ?? 500)
    if (status === 500) console.error("Browser operation failed", error)
    response.writeHead(status, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        error: error instanceof SyntaxError ? "Invalid JSON request" : error.message,
        code: error.code,
        status,
      })
    )
  } finally {
    if (entered) active--
  }
})
server.listen(6079, "127.0.0.1", () => console.log("Shared browser controller ready"))
async function close() {
  console.log("Closing shared browser and flushing persistent profile")
  server.close()
  mode = "quiescing"
  await stopProcessGroups()
  if (browser) await (await browser).close()
  console.log("Persistent browser profile closed")
  process.exit(0)
}
process.once("SIGTERM", close)
process.once("SIGINT", close)
