// Tool schemas adapted from the pinned MIT upstream lib/agent/tools.ts at the pinned MIT baseline.
// No execute callbacks: model decisions and effects are separate durable steps.
import { tool } from "ai"
import { nativeTools } from "@/lib/agent/native-tools"
import { z } from "zod"
import { pluginCallSchema } from "@/lib/agent-zero"
import { manualDraftSchema } from "@/lib/manual-schema"
import { workflowCandidateSchema, workflowRepairSchema } from "@/lib/workflow-schema"
import { vaultFillInputSchema } from "@/lib/vault-schema"
import {
  paymentInputSchema,
  paymentSubmitInputSchema,
  paymentResultInputSchema,
} from "@/lib/payment-schema"
const coordinates = {
  coordinateMode: z
    .enum(["pixels", "normalized_1000"])
    .describe(
      "Explicit coordinate format: pixels uses the screenshot's actual width/height; normalized_1000 uses 0..1000 on each axis. The driver converts this declared format to screen pixels."
    ),
  x: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Horizontal position in the explicitly selected coordinateMode. Origin is top-left; normalized_1000 has center x=500."
    ),
  y: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Vertical position in the explicitly selected coordinateMode. Origin is top-left; normalized_1000 has center y=500."
    ),
}
const frame = {
  observationId: z
    .uuid()
    .describe(
      "The latest desktop observationId in the current control session, consumed by one input. Pointer tools require screenshot_status=ok; if the latest observation omitted its image, call screen_capture first and use its new ID."
    ),
}
const AFTER =
  "Pointer input must declare coordinateMode and use the latest observationId with screenshot_status=ok. Keyboard input may use a current native observation. Returns the resulting screenshot, AT-SPI elements and a new observationId for the next input."
export const agentTools = {
  load_task_image: tool({
    description:
      "Read a picture attached to this task or a supplement. Use its upload id or a source chat Referenced pictures id. Deleted or expired chat pictures are explicitly unavailable.",
    inputSchema: z.strictObject({ id: z.uuid() }),
  }),
  load_manual: tool({
    description:
      "Load an owner-reviewed operation manual from this task's catalog when its description matches the current goal. The manual is reference guidance: use fresh screenshots/DOM, ask for missing inputs and obtain current approvals. Loading does not execute steps or certify results.",
    inputSchema: z.strictObject({ id: z.uuid() }),
  }),
  shell: tool({
    description:
      "Run a shell command on your workstation (Linux, bash, with passwordless sudo). Returns combined output and the exit code. Each call is a fresh shell that starts in your home directory unless `cwd` is given. Programs started in the background keep running.",
    inputSchema: z.object({
      command: z.string().min(1).describe("The command to run"),
      cwd: z.string().optional().describe("Working directory"),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(900)
        .optional()
        .describe("Seconds before the command is abandoned. Default 120."),
    }),
  }),
  fs_read: tool({
    description: "Read a text file from your workstation.",
    inputSchema: z.object({
      path: z.string().describe("Path on the workstation; relative paths start at ~"),
    }),
  }),
  fs_write: tool({
    description:
      "Create or overwrite a text file on your workstation. Missing parent folders are created.",
    inputSchema: z.object({
      path: z.string().describe("Path on the workstation; relative paths start at ~"),
      content: z.string().describe("The complete new contents"),
    }),
  }),
  fs_list: tool({
    description: "List a directory on your workstation.",
    inputSchema: z.object({
      path: z
        .string()
        .default(".")
        .describe("Path on the workstation; relative paths start at ~"),
    }),
  }),
  screen_capture: tool({
    description:
      "Always capture a fresh original desktop screenshot, dimensions, active native window, new observationId and available AT-SPI controls. Call whenever uncertain, confused, controls do not explain the state, or visual layout/image verification is needed. Call before coordinate input when the latest native observation has screenshot_status=omitted; use this new ID. Missing or partial controls do not prove absence. Capture is observational and does not repeat any prior action.",
    inputSchema: z.object({}),
  }),
  screen_share: tool({
    description:
      "Show your desktop to the person: the screenshot appears in the conversation. Use only when they ask to see the screen.",
    inputSchema: z.object({}),
  }),
  pointer_click: tool({
    description: `Click at a point on the desktop. ${AFTER}`,
    inputSchema: z.object({
      ...frame,
      ...coordinates,
      button: z.enum(["left", "right", "middle"]).default("left"),
      double: z.boolean().default(false),
    }),
  }),
  pointer_move: tool({
    description: `Move the pointer without clicking, e.g. to reveal a hover menu. ${AFTER}`,
    inputSchema: z.object({ ...frame, ...coordinates }),
  }),
  pointer_drag: tool({
    description: `Press the left button at one point, drag to another and release. ${AFTER}`,
    inputSchema: z.object({
      ...frame,
      coordinateMode: coordinates.coordinateMode,
      fromX: coordinates.x,
      fromY: coordinates.y,
      toX: coordinates.x,
      toY: coordinates.y,
    }),
  }),
  pointer_scroll: tool({
    description: `Scroll the mouse wheel at a point on the desktop. ${AFTER}`,
    inputSchema: z.object({
      ...frame,
      ...coordinates,
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(30).default(3).describe("Wheel notches"),
    }),
  }),
  key_type: tool({
    description: `Type text into the focused element on the desktop. Newlines are sent as Enter. ${AFTER}`,
    inputSchema: z.object({ ...frame, text: z.string() }),
  }),
  key_press: tool({
    description: `Press one key, optionally with modifiers held — e.g. key 'enter', or key 'l' with ['ctrl']. ${AFTER}`,
    inputSchema: z.object({
      ...frame,
      key: z
        .string()
        .describe(
          "A letter or digit, or one of: enter, escape, tab, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1–f12"
        ),
      modifiers: z.array(z.enum(["ctrl", "alt", "shift", "cmd"])).default([]),
    }),
  }),
  request_takeover: tool({
    description:
      "Pause and hand your desktop to the person for a step only they should do: signing in, entering a one-time code, paying, solving a CAPTCHA, or a choice they must make on screen. Leave the page ready, then describe exactly what is waiting and what they need to do. Execution waits durably for the person to hand control back. Then observe the changed desktop before continuing.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(
          "What is on screen and what the person needs to do, in one or two sentences"
        ),
    }),
  }),
}

const page = { pageId: z.uuid() }
const reference = { ...page, observationId: z.uuid(), ref: z.string().regex(/^r\d+$/) }
export const browserTools = {
  browser_open: tool({
    description:
      "Open a URL in the shared headed browser and bring it to the desktop. Prefer DOM tools over visual clicking when the page exposes controls.",
    inputSchema: z.object({
      url: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol)),
    }),
  }),
  browser_pages: tool({
    description: "List open pages in the same browser the person can see and control.",
    inputSchema: z.object({}),
  }),
  browser_observe: tool({
    description:
      "Read visible text, current r element references and up to 150 t textRefs for visible main-frame leaf text. t refs are read-only payment evidence, never click targets. Input actions invalidate the observation; observe again afterward. Payment choice and its following fill share the same unchanged observation.",
    inputSchema: z.object(page),
  }),
  browser_click: tool({
    description:
      "Click a reference from a current observation. For a file download use browser_download instead.",
    inputSchema: z.object(reference),
  }),
  browser_fill: tool({
    description: "Fill an input using a fresh observation reference.",
    inputSchema: z.object({ ...reference, text: z.string().max(50000) }),
  }),
  browser_screenshot: tool({
    description: "Capture the current browser page.",
    inputSchema: z.object(page),
  }),
  browser_download: tool({
    description:
      "Click a download reference and save the completed file in a stable home directory. Inspect and validate the resulting file before completing.",
    inputSchema: z.object(reference),
  }),
}
const deliverable = z.object({
  path: z.string().min(1).max(2000),
  name: z.string().min(1).max(180).optional(),
  mediaType: z
    .enum([
      "text/csv",
      "text/plain",
      "text/markdown",
      "application/json",
      "application/pdf",
      "application/octet-stream",
    ])
    .default("application/octet-stream"),
})

export const delegationTools = {
  list_agents: tool({
    description:
      "List only the agents the owner approved for delegation in this task, by id, name and role. An empty list means delegation is disabled for this task. Use delegate to hand the rest of this task to one of these agents on its own workstation and model.",
    inputSchema: z.object({}),
  }),
  // agentId/brief and the take-over-the-turn semantics are retained from the pinned MIT upstream.
  delegate: tool({
    description:
      "Hand the rest of this task to another agent whose role fits it better. Give its id, a self-contained brief and any regular home files it needs (up to eight, 20 MB each). The worker freezes host copies, releases your workstation and enqueues the next segment on the target workstation. This ends your segment; the overall task and its step/cost budget continue. Old approvals, browser references and login sessions do not transfer. Use list_agents to discover ids. No parallel child or return-to-parent execution.",
    inputSchema: z.object({
      agentId: z.string().min(1).max(100),
      brief: z.string().trim().min(1).max(4000),
      files: z.array(deliverable).max(8).default([]),
    }),
  }),
}

export const completionTools = {
  complete_task: tool({
    description:
      "Deliver the actual result. Files are copied out of the workstation and checked by the server. A missing or invalid required artifact returns an error so you can correct it. This ends the task only when the server accepts the result.",
    inputSchema: z.object({
      summary: z.string().min(1).max(16000),
      files: z.array(deliverable).max(8).default([]),
    }),
  }),
}
export const userTools = {
  ask_user: tool({
    description:
      "Ask for a decision, missing information, or explicit consent for the exact external action you describe. Execution waits durably for the person's answer.",
    inputSchema: z.object({ question: z.string().min(1).max(4000) }),
  }),
}

// Names and note schema retained from the pinned MIT upstream's memory tools.
export const memoryTools = {
  recall_memory: tool({
    description:
      "Read this agent's current active memories, including notes older than the initial 30. Set summaries=true to browse topic summaries; use topic for its detailed notes or omit it to page through all notes. Pages start at 1. Follow pages until the relevant details are found. Latest reads supersede historical snapshots.",
    inputSchema: z.object({
      topic: z.string().trim().max(40).optional(),
      page: z.number().int().min(1).optional(),
      summaries: z.boolean().optional(),
    }),
  }),
  memory_write: tool({
    description:
      "Save a durable note about the person's preferences, projects or standing instructions when they ask you to remember it. Notes are scoped to this agent and available to future tasks. Never save passwords, API keys or one-time codes.",
    inputSchema: z.object({ note: z.string().trim().min(1).max(2000) }),
  }),
  memory_forget: tool({
    description:
      "Delete this agent's saved note by its id when the person asks or it is wrong/outdated. Apply the correction immediately; the task's initial memory snapshot remains in its audit history.",
    inputSchema: z.object({ id: z.string().min(1).max(200) }),
  }),
}

export const vaultTools = {
  payment_submit: tool({
    description:
      "After a known complete approved card/UPI fill, observe fresh DOM and request a separate final owner approval for this exact visible main-frame button and current merchant/amount t refs. Supply the original paymentRequestId. The server freezes and rechecks site, control, text and button, then clicks once only after approval. Preparation/fill approvals never authorize submission; do not use browser_click, shell or desktop keys to bypass this. If the click outcome is unknown, inspect/reconcile without submitting again. The receipt proves dispatch only, not payment. Unsupported/iframe/CVV/PIN/cross-site forms use takeover.",
    inputSchema: paymentSubmitInputSchema,
  }),
  payment_result: tool({
    description:
      "After an approved dispatched payment_submit (or review of its unknown outcome), inspect the current same-site result with fresh DOM and four distinct t refs: merchant, amount, status and receipt/order number. Supply its submissionRequestId. The worker stores actual page text separately from your summary. It proves page evidence only, not issuer settlement or authenticity; missing/mismatched evidence requires manual verification. Never resubmit to obtain a receipt.",
    inputSchema: paymentResultInputSchema,
  }),
  request_payment_approval: tool({
    description:
      "On the checkout page, ask the owner to choose a saved card/UPI, take over, or decline. Supply the exact visible merchant and amount (including currency) and their distinct t references from the current browser_observe.textRefs. The worker rereads those nodes; a model guess cannot authorize payment. Owner selection returns only itemId/revision/kind. For a card/UPI vault_fill include this paymentRequestId and the same still-current page/observation; it requires its own exact-field approval and consumes the payment choice once. A changed page/control/text requires a new request. This prepares payment details only, never authorizes a payment submission or proves payment succeeded. For unavailable/iframe/CVV/PIN flows use human takeover. Provision missing credentials via request_secret before creating a new payment request.",
    inputSchema: paymentInputSchema,
  }),
  vault_fill: tool({
    description:
      "Request explicit owner approval, then fill selected vault fields into current main-frame input/textarea references (up to ten). Login/code/identity use itemId/revision. Identity fields: name,email,phone,address,address_line1,address_line2,city,state,postcode,country. Card fields: number,expiry,expiry_month,expiry_year,expiry_year_short,name; UPI: id. Card/UPI additionally require the owner-selected paymentRequestId, its exact item/revision and unchanged page/observation/merchant/amount/control; payment choice is single-use. Selects, iframes, CVV and PIN need human takeover. Missing values reject the entire batch before release. No secret values are returned. Filling does not submit forms or authorize payment. Changed/unknown effects must not be repeated. Observe fresh DOM afterward; screenshots can expose values mirrored by the site.",
    inputSchema: vaultFillInputSchema,
  }),
  vault_list: tool({
    description:
      "List permanent credentials as ids, versions, labels, masked hints and exact allowed origins; no secrets or one-time codes. vault_fill requires separate approval. Cards/UPI first require request_payment_approval and the owner's exact method choice; CVV/PIN/unsupported controls use takeover.",
    inputSchema: z.object({}),
  }),
  request_secret: tool({
    description:
      "Ask the person to securely provide/select a credential in the authenticated web form for an exact origin; returns only itemId/revision. Never request secrets in chat. Provisioning does not fill or authorize payment. Cards/UPI still need a new request_payment_approval and exact-field vault_fill approval. CVV/PIN use human takeover.",
    inputSchema: z.object({
      kind: z.enum(["card", "upi", "login", "identity", "code"]),
      origin: z.url().max(2048),
      reason: z.string().min(1).max(1000),
    }),
  }),
}

// Only a companion's daily-life session can call these (see toolsForTask)
export const lifeTools = {
  life_log: tool({
    description:
      "Record one thing you really did in this session (read an article, watched a video, wrote a diary entry, saved something). The title, summary and URL must come from pages you actually opened; an unreachable URL is rejected. Returns the activity id.",
    inputSchema: z.object({
      kind: z.enum(["read", "watch", "diary", "save", "other"]),
      title: z.string().trim().min(1).max(200),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(600)
        .describe(
          "One or two sentences in your own words: what it was and what you thought"
        ),
      url: z
        .url()
        .refine((url) => ["http:", "https:"].includes(new URL(url).protocol))
        .optional(),
      body: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .optional()
        .describe("For a diary entry: the diary text itself, in your own words"),
      screenshotPageId: z
        .uuid()
        .optional()
        .describe(
          "The pageId of an open page whose screenshot should be kept with this record. Use it for a page worth showing; never for pages with personal or sign-in content"
        ),
    }),
  }),
  coview_reply: tool({
    description:
      "Only in a session where the person sent you a link: after you have really opened and read it, send them your honest reaction, written the way you would text a friend. Say what you actually saw on the page. Call it once.",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200).describe("The page title you saw"),
      text: z.string().trim().min(1).max(600),
      screenshotPageId: z.uuid().optional(),
    }),
  }),
  life_share: tool({
    description:
      "Queue a short message to the person about one logged activity, written the way you would text a friend. It is delivered later, within their daily limit and quiet hours; it may be dropped. Share only what you really found, with its real link.",
    inputSchema: z.object({
      activityId: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(500),
    }),
  }),
}
// A session that opens one link for the person keeps only reading tools and coview_reply
const coviewToolNames = new Set([
  "browser_open",
  "browser_pages",
  "browser_observe",
  "browser_click",
  "browser_screenshot",
  "complete_task",
  "coview_reply",
])
const lifeToolNames = new Set([
  "browser_open",
  "browser_pages",
  "browser_observe",
  "browser_click",
  "browser_screenshot",
  "fs_read",
  "fs_write",
  "fs_list",
  "screen_capture",
  "complete_task",
  ...Object.keys(lifeTools).filter((name) => name !== "coview_reply"),
])
export const tools = {
  ...lifeTools,
  agent_zero_call: tool({
    description:
      "Call an enabled Agent Zero Python plugin tool in this task's Linux desktop. Select plugin and tool from the frozen plugin list; pass original tool arguments in args. Results use the existing task/action ledger. Plugin break_loop never marks the overall task complete; use complete_task after checking results.",
    inputSchema: pluginCallSchema,
  }),
  ...agentTools,
  ...nativeTools,
  ...browserTools,
  ...completionTools,
  ...delegationTools,
  ...userTools,
  ...memoryTools,
  ...vaultTools,
}
export type AgentToolName = keyof typeof tools
export function toolsForCoordinateMode(mode: "pixels" | "normalized_1000") {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      name.startsWith("pointer_")
        ? {
            ...definition,
            inputSchema: (definition.inputSchema as z.ZodObject).extend({
              coordinateMode: z
                .literal(mode)
                .describe(`This task's frozen coordinate format is ${mode}.`),
            }),
          }
        : definition,
    ])
  ) as typeof tools
}
export const isAgentTool = (name: string): name is AgentToolName =>
  Object.hasOwn(tools, name)

export const compilationTools = {
  submit_workflow: tool({
    description:
      "Submit a finite parameterized Thunar workflow candidate. The host freezes the original completion contract, source and environment. This compiles only: it performs no desktop actions and does not mark the candidate ready. Keep private/human-only source segments as human_checkpoint steps.",
    inputSchema: workflowCandidateSchema,
  }),
}
export const manualCompilationTools = {
  submit_manual: tool({
    description:
      "Submit an editable operation-manual draft from the frozen sanitized successful task. This saves a draft only; the owner must review and save it before other tasks can discover it.",
    inputSchema: manualDraftSchema,
  }),
}
export const workflowRepairTools = {
  submit_workflow_repair: tool({
    description:
      "Submit one bounded repair for the undispatched failed workflow step. Preserve its final intended operation; prefixes may only recover dialog/navigation state. This returns a candidate, never executes desktop actions or changes the frozen completion contract.",
    inputSchema: workflowRepairSchema,
  }),
}
export const desktopToolNames = new Set([
  "recall_memory",
  "load_task_image",
  ...Object.keys(nativeTools),
  "load_manual",
  "screen_capture",
  "screen_share",
  "pointer_click",
  "pointer_move",
  "pointer_drag",
  "pointer_scroll",
  "key_press",
  "key_type",
  "request_takeover",
  "ask_user",
  "complete_task",
  "desktop_open_application",
])
const desktopLaunchTool = tool({
  description:
    "Open the native Thunar file manager at /home/agent in a fresh window. Returns the resulting screenshot. File changes use desktop mouse/keyboard tools only.",
  inputSchema: z.object({ application: z.literal("Thunar") }),
})
export function toolsForTask(config: {
  companionContext?: { images: unknown[] }
  agentZeroPlugins?: unknown[]
  manuals?: unknown[]
  manualCompilation?: unknown
  desktopCoordinateMode?: "pixels" | "normalized_1000"
  workflowCompilation?: unknown
  workflowExecution?: { allowRepair?: boolean }
  workstationChannel?: "desktop"
  lifeSession?: { prompt?: string; coview?: unknown }
}) {
  if (config.lifeSession) {
    const allowed = config.lifeSession.coview ? coviewToolNames : lifeToolNames
    return Object.fromEntries(
      Object.entries(toolsForCoordinateMode("pixels")).filter(([name]) =>
        allowed.has(name)
      )
    )
  }
  const available = config.manualCompilation
    ? manualCompilationTools
    : config.workflowCompilation
      ? compilationTools
      : config.workflowExecution?.allowRepair
        ? workflowRepairTools
        : config.workstationChannel === "desktop"
          ? {
              ...Object.fromEntries(
                Object.entries(
                  toolsForCoordinateMode(config.desktopCoordinateMode ?? "pixels")
                ).filter(([name]) => desktopToolNames.has(name))
              ),
              desktop_open_application: desktopLaunchTool,
            }
          : Object.fromEntries(
              Object.entries(
                toolsForCoordinateMode(config.desktopCoordinateMode ?? "pixels")
              ).filter(
                ([name]) =>
                  name !== "agent_zero_call" || !!config.agentZeroPlugins?.length
              )
            )
  return Object.fromEntries(
    Object.entries(available).filter(
      ([name]) =>
        !Object.hasOwn(lifeTools, name) &&
        (name !== "load_manual" || !!config.manuals?.length)
    )
  )
}
