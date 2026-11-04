import { relations } from "drizzle-orm"
import {
  type AnyPgColumn,
  index,
  integer,
  bigint,
  primaryKey,
  pgTable,
  text,
  timestamp as pgTimestamp,
  jsonb,
  boolean,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { createInsertSchema } from "drizzle-zod"
import { nanoid } from "nanoid"
import { z } from "zod"
import type { AgentZeroPluginReference } from "@/lib/agent-zero"
import type { WorkflowPackage } from "@/lib/workflow-package"
import {
  manualCompilationInputSchema,
  type ManualCompilation,
  type ManualReference,
} from "@/lib/manual-schema"
import {
  workflowCompilationInputSchema,
  workflowExecutionInputSchema,
  type WorkflowCompilation,
  type WorkflowExecution,
  type WorkflowCheckpoint,
  type WorkflowEnvironment,
  type WorkflowPlan,
} from "@/lib/workflow-schema"

const id = () =>
  text()
    .primaryKey()
    .$defaultFn(() => nanoid(12))

const timestamp = () =>
  pgTimestamp({ withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())

/* ───────────────────────────── agents ───────────────────────────── */

export const agents = pgTable("agents", {
  id: id(),
  name: text().notNull(),
  // One line describing what the agent is for
  role: text().notNull(),
  // Standing orders appended to the agent's system prompt
  instructions: text(),
  // "provider/model". Null falls back to the workspace default.
  model: text(),
  // Seed for the agent's generated glyph
  glyph: text()
    .notNull()
    .$defaultFn(() => nanoid(10)),
  // Docker container backing the agent's workstation. Created on first use.
  workstationId: text(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
})

/* ───────────────────────────── squads ───────────────────────────── */

export const squads = pgTable("squads", {
  id: id(),
  name: text().notNull(),
  createdAt: timestamp(),
})

export const squadMembers = pgTable(
  "squad_members",
  {
    squadId: text()
      .notNull()
      .references(() => squads.id, { onDelete: "cascade" }),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.squadId, t.agentId] }),
    index("squad_members_agent_idx").on(t.agentId),
  ]
)

/* ───────────────────────────── threads ──────────────────────────── */

// A conversation with one agent (agentId) or with a squad (squadId)
export const threads = pgTable(
  "threads",
  {
    id: id(),
    agentId: text().references(() => agents.id, { onDelete: "cascade" }),
    squadId: text().references(() => squads.id, { onDelete: "cascade" }),
    title: text(),
    preview: text(),
    activeAt: timestamp(),
    createdAt: timestamp(),
  },
  (t) => [
    index("threads_agent_idx").on(t.agentId, t.activeAt),
    index("threads_squad_idx").on(t.squadId, t.activeAt),
    index("threads_active_idx").on(t.activeAt),
  ]
)

export const messages = pgTable(
  "messages",
  {
    // UI message id, assigned by the client (user) or the stream (assistant)
    id: text().primaryKey(),
    threadId: text()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text({ enum: ["user", "assistant", "system"] }).notNull(),
    parts: jsonb().notNull().$type<unknown[]>(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)]
)

/* ───────────────────────────── memory ───────────────────────────── */

// Long-term notes an agent keeps about the person and their work. Shared
// across every thread the agent takes part in.
export const memories = pgTable(
  "memories",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    content: text().notNull(),
    // Who wrote the note: the person on the memory page, or the agent while chatting
    source: text({ enum: ["user", "agent"] })
      .notNull()
      .default("agent"),
    // A candidate is something the companion is unsure about; it is not used until confirmed
    status: text({ enum: ["active", "candidate"] })
      .notNull()
      .default("active"),
    // A note is one detailed fact. A summary is a topic block ("饮食习惯") she wrote herself while
    // organizing her notes; the notes it covers point at it through `summaryId`.
    kind: text({ enum: ["note", "summary"] })
      .notNull()
      .default("note"),
    topic: text(),
    summaryId: text().references((): AnyPgColumn => memories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp(),
    updatedAt: pgTimestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("memories_agent_idx").on(t.agentId, t.createdAt)]
)

// Everything that changed her notes, one row per change, so the person can see it and undo it.
// `before` / `after` are snapshots ({content, status, createdAt}); memoryId has no foreign key
// because a deleted note must stay undoable.
export const memoryChanges = pgTable(
  "memory_changes",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    memoryId: text().notNull(),
    op: text({ enum: ["add", "update", "delete"] }).notNull(),
    // Changes made together (one merge, one organizing run) share a group and are undone together
    groupId: text(),
    // model: decided by the memory update call; user: the person edited or deleted a note
    actor: text({ enum: ["model", "user"] }).notNull(),
    // Where it came from: chat, life, share, memory page
    origin: text().notNull().default("chat"),
    before: jsonb().$type<MemorySnapshot | null>(),
    after: jsonb().$type<MemorySnapshot | null>(),
    reason: text(),
    // The message that led to it
    messageId: text(),
    sourceText: text(),
    createdAt: timestamp(),
    undoneAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [index("memory_changes_agent_idx").on(t.agentId, t.createdAt)]
)

export type MemorySnapshot = {
  content: string
  status: "active" | "candidate"
  source: "user" | "agent"
  createdAt: string
  kind?: "note" | "summary"
  topic?: string | null
  // A summary also remembers which notes it covered
  covers?: string[]
  summaryId?: string | null
}

// Two notes that say nearly the same thing. Nothing is merged until the person decides:
// merge (the older note takes the merged wording, the newer one goes), keep both, or drop the
// newer one. A decision is kept so the same pair is not offered again.
export const memorySuggestions = pgTable(
  "memory_suggestions",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // The newer note (may still be a candidate) and the older one it resembles
    memoryId: text()
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    otherId: text()
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    // What the older note would say after a merge
    mergedText: text().notNull(),
    // 0-100
    score: integer().notNull(),
    status: text({ enum: ["pending", "merged", "kept", "dropped"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp(),
  },
  (t) => [
    uniqueIndex("memory_suggestions_pair_idx").on(t.memoryId, t.otherId),
    index("memory_suggestions_agent_idx").on(t.agentId, t.status),
  ]
)

/* ───────────────────────────── ledger ───────────────────────────── */

// One row per agent turn: what it ran on, what it consumed, how it ended
export const turns = pgTable(
  "turns",
  {
    id: id(),
    threadId: text().references(() => threads.id, { onDelete: "set null" }),
    agentId: text().references(() => agents.id, { onDelete: "set null" }),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    reasoningTokens: integer().notNull().default(0),
    cachedTokens: integer().notNull().default(0),
    steps: integer().notNull().default(0),
    toolCalls: integer().notNull().default(0),
    durationMs: integer().notNull().default(0),
    // What the turn cost in millionths of a dollar, priced when it ran. Zero
    // on local models; null when the model's price isn't known.
    costMicros: integer(),
    status: text({ enum: ["completed", "stopped", "failed"] }).notNull(),
    error: text(),
    createdAt: timestamp(),
  },
  (t) => [index("turns_created_idx").on(t.createdAt)]
)

/* ──────────────────────────── routines ──────────────────────────── */

// Wall-clock times belong to the routine's explicit IANA time zone.
export type RoutineSchedule =
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; day: number }
  | { kind: "hourly"; every: number }
  // Just once, at a local date and time like "2026-10-21T09:00"
  | { kind: "once"; at: string }

// Retain upstream agent/squad references. This runtime accepts single-agent plans.
export const routines = pgTable(
  "routines",
  {
    id: id(),
    name: text().notNull(),
    agentId: text().references(() => agents.id, { onDelete: "cascade" }),
    squadId: text().references(() => squads.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    schedule: jsonb().notNull().$type<RoutineSchedule>(),
    timeZone: text().notNull().default("UTC"),
    planVersion: integer().notNull().default(1),
    missedRunPolicy: text({ enum: ["latest", "skip"] })
      .notNull()
      .default("latest"),
    dateRange: text({ enum: ["none", "previous_week"] })
      .notNull()
      .default("none"),
    completionContract: jsonb()
      .notNull()
      .$type<CompletionContract>()
      .default({ requireHumanReview: false }),
    budget: jsonb().notNull().$type<TaskInput["budget"]>().default({ maxSteps: 40 }),
    delegateAgentIds: jsonb().notNull().$type<string[]>().default([]),
    deletedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    enabled: boolean().notNull().default(true),
    threadId: text().references(() => threads.id, { onDelete: "set null" }),
    nextRunAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    lastRunAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    lastStatus: text({ enum: ["running", "ok", "failed", "stopped", "skipped"] }),
    lastError: text(),
    createdAt: timestamp(),
  },
  (t) => [index("routines_next_idx").on(t.enabled, t.nextRunAt)]
)

// Every time a routine came due or was run by hand, including the times it
// was skipped. What a run cost is in the ledger: the turn it started.
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: id(),
    routineId: text()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    trigger: text({ enum: ["schedule", "manual"] }).notNull(),
    status: text({
      enum: ["queued", "running", "ok", "failed", "stopped", "skipped"],
    }).notNull(),
    requestKey: text(),
    planVersion: integer(),
    snapshot: jsonb().$type<RoutineRunSnapshot>(),
    taskId: text().references((): AnyPgColumn => tasks.id),
    // Why it was skipped, or what went wrong
    detail: text(),
    // When it was due; null for a run by hand
    dueAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    threadId: text().references(() => threads.id, { onDelete: "set null" }),
    turnId: text().references(() => turns.id, { onDelete: "set null" }),
    startedAt: timestamp(),
    finishedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("routine_runs_routine_idx").on(t.routineId, t.startedAt),
    uniqueIndex("routine_runs_request_idx").on(t.requestKey),
  ]
)

/* ───────────────────────────── vault ────────────────────────────── */

// Logins, cards, UPI IDs and personal details, encrypted with a key held by
// the operating system's keychain (lib/vault.ts). Agents only ever see the
// label and the hint; the values are typed into pages by OwnDesk itself.
export const vaultItems = pgTable(
  "vault_items",
  {
    id: id(),
    kind: text({ enum: ["card", "upi", "login", "identity", "code"] }).notNull(),
    label: text().notNull(),
    // Safe to show anyone, agents included: "Visa ···· 4242 · 08/29"
    hint: text().notNull(),
    // Legacy site metadata. Automatic use requires a separately confirmed exact origin.
    site: text(),
    origin: text(),
    revision: integer().notNull().default(1),
    scopeTaskId: text().references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    expiresAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    consumedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    // AES-256-GCM: base64 of iv, tag and ciphertext
    secret: text().notNull(),
    // One-time entries (a code, a card used once) are removed after use
    ephemeral: boolean().notNull().default(false),
    lastUsedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  (t) => [index("vault_items_kind_idx").on(t.kind)]
)

// A payment an agent asked to make, and what the person decided
export const vaultApprovals = pgTable(
  "vault_approvals",
  {
    id: id(),
    threadId: text()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // The agent that asked, whose desktop has the checkout open
    agentId: text().references(() => agents.id, { onDelete: "cascade" }),
    // The saved card or UPI ID the person chose
    itemId: text().references(() => vaultItems.id, { onDelete: "cascade" }),
    merchant: text().notNull(),
    amount: text().notNull(),
    purpose: text(),
    // The site the checkout was on when the agent asked; payment details only
    // fill there
    host: text(),
    status: text({ enum: ["pending", "approved", "declined", "taken-over"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp(),
    decidedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    expiresAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [index("vault_approvals_thread_idx").on(t.threadId)]
)

/* ──────────────────────────── settings ──────────────────────────── */

// Values saved from the Settings screen. They take precedence over .env.
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp(),
})

/* ──────────────────────────── relations ─────────────────────────── */

export const agentsRelations = relations(agents, ({ many }) => ({
  squads: many(squadMembers),
  threads: many(threads),
  memories: many(memories),
}))

export const squadsRelations = relations(squads, ({ many }) => ({
  members: many(squadMembers),
  threads: many(threads),
}))

export const squadMembersRelations = relations(squadMembers, ({ one }) => ({
  squad: one(squads, { fields: [squadMembers.squadId], references: [squads.id] }),
  agent: one(agents, { fields: [squadMembers.agentId], references: [agents.id] }),
}))

export const threadsRelations = relations(threads, ({ one, many }) => ({
  agent: one(agents, { fields: [threads.agentId], references: [agents.id] }),
  squad: one(squads, { fields: [threads.squadId], references: [squads.id] }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, { fields: [messages.threadId], references: [threads.id] }),
}))

export const memoriesRelations = relations(memories, ({ one }) => ({
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
}))

/* ──────────────────────────── validation ────────────────────────── */

// "provider/model-id", e.g. "openai/gpt-6-luna" or "ollama/qwen3:8b"
export const modelSpecSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+\/\S+$/, "Use the form provider/model, e.g. openai/gpt-6-luna.")

export const agentInputSchema = createInsertSchema(agents, {
  name: (s) =>
    s.trim().min(1, "Give the agent a name.").max(40, "Keep it under 40 characters."),
  role: (s) =>
    s
      .trim()
      .min(1, "Describe what the agent is for.")
      .max(120, "Keep it under 120 characters."),
  instructions: (s) => s.trim().max(6000, "Keep it under 6000 characters."),
  model: () => z.union([modelSpecSchema, z.literal("")]),
}).omit({ id: true, workstationId: true, createdAt: true, updatedAt: true })

export const squadInputSchema = createInsertSchema(squads, {
  name: (s) => s.trim().min(1, "Name the squad.").max(40, "Keep it under 40 characters."),
})
  .omit({ id: true, createdAt: true })
  .extend({
    agentIds: z.array(z.string()).min(2, "A squad needs at least two agents."),
  })

// US dollars per million tokens, for a model OwnDesk has no price for
export const modelPriceSchema = z.object({
  spec: modelSpecSchema,
  input: z.number().min(0, "Prices can't be negative.").max(10_000),
  output: z.number().min(0, "Prices can't be negative.").max(10_000),
  cached: z.number().min(0).max(10_000).optional(),
})

// Dollars a month; empty removes the local override, 0 pauses paid requests.
export const monthlyBudgetSchema = z
  .string()
  .trim()
  .regex(/^(\d{1,6}(\.\d{1,2})?)?$/, "Use a dollar amount, e.g. 20 or 7.50.")

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:30.")

export const routineScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["daily", "weekdays"]), time: clock }),
  z.object({
    kind: z.literal("weekly"),
    time: clock,
    day: z.number().int().min(0).max(6),
  }),
  z.object({ kind: z.literal("hourly"), every: z.number().int().min(1).max(24) }),
  z.object({
    kind: z.literal("once"),
    at: z.iso.datetime({ local: true, precision: -1 }),
  }),
])

export const routineInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name the routine.")
      .max(60, "Keep it under 60 characters."),
    agentId: z.string().nullish(),
    squadId: z.string().nullish(),
    prompt: z
      .string()
      .trim()
      .min(1, "Say what to do each time.")
      .max(4000, "Keep it under 4000 characters."),
    schedule: routineScheduleSchema,
    enabled: z.boolean().default(true),
  })
  .refine((value) => !!value.agentId !== !!value.squadId, {
    message: "Pick one agent or one squad.",
    path: ["agentId"],
  })

export const memoryInputSchema = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(2000),
})

export type Agent = typeof agents.$inferSelect
export type AgentInput = z.infer<typeof agentInputSchema>
export type Squad = typeof squads.$inferSelect
export type SquadInput = z.infer<typeof squadInputSchema>
export type Thread = typeof threads.$inferSelect
export type Memory = typeof memories.$inferSelect
export type Turn = typeof turns.$inferSelect
export type Routine = typeof routines.$inferSelect
export type RoutineRun = typeof routineRuns.$inferSelect
export type RoutineInput = z.infer<typeof routineInputSchema>
export type MessageRow = typeof messages.$inferSelect

/* ───────────── durable task control (new implementation) ───────────── */

export const owners = pgTable(
  "owners",
  {
    id: integer().primaryKey().default(1),
    userId: text().notNull().unique(),
    timeZone: text().notNull().default("UTC"),
    createdAt: timestamp(),
  },
  (t) => [check("single_owner", sql`${t.id} = 1`)]
)

const taskStatuses = [
  "queued",
  "running",
  "waiting_user",
  "verifying",
  "needs_review",
  "completed",
  "failed",
  "cancelled",
] as const
export const taskStatusSchema = z.enum(taskStatuses)
export type TaskStatus = z.infer<typeof taskStatusSchema>
export const csvArtifactSchema = z.object({
  path: z.string().min(1),
  requiredColumns: z.array(z.string()).default([]),
  minRows: z.number().int().min(0).default(1),
  dateColumn: z.string().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
})
export const comparisonSchema = z.object({
  baseline: csvArtifactSchema,
  valueColumn: z.string().trim().min(1).max(100),
  kind: z.enum(["absolute", "percent"]),
  threshold: z
    .string()
    .trim()
    .regex(
      /^\d{1,15}(?:\.\d{1,6})?$/,
      "Use a nonnegative decimal with at most six fractional digits"
    ),
  direction: z.enum(["any", "increase", "decrease"]),
  notify: z.enum(["always", "on_change"]),
})
export type ReportComparison = z.infer<typeof comparisonSchema>
const relativeTreePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a relative path with ordinary nonempty segments"
  )
export const directoryTreeSchema = z.object({
  root: z
    .string()
    .min(13)
    .max(1000)
    .refine(
      (value) =>
        value.startsWith("/home/agent/") &&
        relativeTreePath.safeParse(value.slice(12)).success,
      "Use an absolute directory below /home/agent"
    ),
  directories: z.array(relativeTreePath).min(1).max(50),
  absent: z.array(relativeTreePath).max(50).default([]),
})
export const completionContractSchema = z
  .object({
    artifact: csvArtifactSchema.optional(),
    comparison: comparisonSchema.optional(),
    directoryTree: directoryTreeSchema.optional(),
    requireHumanReview: z.boolean().default(false),
  })
  .refine((contract) => !contract.comparison || !!contract.artifact, {
    message: "A comparison requires a current CSV artifact",
    path: ["artifact"],
  })
export type CompletionContract = z.infer<typeof completionContractSchema>

export const taskInputSchema = z.object({
  agentId: z.string().min(1).max(100),
  manualCompilation: manualCompilationInputSchema.optional(),
  manualId: z.uuid().optional(),
  workflowCompilation: workflowCompilationInputSchema.optional(),
  workflowExecution: workflowExecutionInputSchema.optional(),
  workstationChannel: z.literal("desktop").optional(),
  lifeSession: z
    .object({
      prompt: z.string().min(1).max(8000),
      // A co-viewing session opens one link the person sent
      coview: z
        .object({ requestId: z.string().min(1).max(100), url: z.url() })
        .optional(),
    })
    .optional(),
  desktopCoordinateMode: z.enum(["pixels", "normalized_1000"]).optional(),
  delegateAgentIds: z.array(z.string().min(1).max(100)).max(32).optional(),
  threadId: z.string().min(1).max(100).optional(),
  goal: z.string().trim().min(1).max(16000),
  clientRequestId: z.string().min(1).max(200),
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, "Use a valid IANA time zone")
    .optional(),
  completionContract: completionContractSchema.default({ requireHumanReview: false }),
  budget: z
    .object({
      maxSteps: z.number().int().min(1).max(200).default(40),
      maxCostMicros: z.number().int().min(0).max(100_000_000).optional(),
    })
    .default({ maxSteps: 40 }),
})
export type TaskInput = z.infer<typeof taskInputSchema>

export type SegmentSnapshot = {
  config: Task["configSnapshot"]
  handoff?: {
    fromSegment: number
    fromAgentId: string
    actionNo: number
    input: {
      agentId: string
      brief: string
      files: { path: string; name?: string; mediaType: string }[]
    }
    files: {
      id: string
      name: string
      path: string
      verification: Record<string, unknown>
    }[]
    answers: { question: string; answer: string }[]
  }
}

export type RoutineRunSnapshot = {
  ownerId: string
  input: TaskInput
  timeZone: string
  range: { from: string; to: string; startsAt: string; endsAt: string } | null
  coalesced?: { from: string; before: string }
}

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    ownerId: text().notNull(),
    agentId: text()
      .notNull()
      .references(() => agents.id),
    threadId: text().references(() => threads.id),
    threadTurn: integer(),
    source: text().notNull(),
    requestKey: text().notNull(),
    requestPayload: jsonb().notNull().$type<Omit<TaskInput, "clientRequestId">>(),
    goal: text().notNull(),
    status: text({ enum: taskStatuses }).notNull().default("queued"),
    activeSegment: integer().notNull().default(1),
    completionContract: jsonb().notNull().$type<CompletionContract>(),
    configSnapshot: jsonb().notNull().$type<{
      model: string
      instructions: string
      memories: string[]
      name?: string
      role?: string
      timeZone?: string
      conversation?: { role: "user" | "assistant"; content: string }[]
      omittedConversationTurns?: number
      contextWindowTokens?: number
      agentZeroPlugins?: AgentZeroPluginReference[]
      manuals?: ManualReference[]
      manualCompilation?: ManualCompilation
      manualId?: string
      desktopCoordinateMode?: "pixels" | "normalized_1000"
      workflowCompilation?: WorkflowCompilation
      workflowExecution?: WorkflowExecution
      workstationChannel?: "desktop"
      // A companion's daily-life session: restricted tools, own prompt
      lifeSession?: { prompt: string; coview?: { requestId: string; url: string } }
      runtime: "fixture" | "agent"
    }>(),
    budget: jsonb().notNull().$type<TaskInput["budget"]>(),
    result: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    cancelRequestedAt: pgTimestamp({ withTimezone: true }),
    cancelWorkflowPending: boolean().notNull().default(false),
    nextEventSeq: integer().notNull().default(0),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  (t) => [
    uniqueIndex("tasks_source_request_idx").on(t.ownerId, t.source, t.requestKey),
    index("tasks_agent_created_idx").on(t.agentId, t.createdAt),
    uniqueIndex("tasks_thread_turn_idx").on(t.threadId, t.threadTurn),
  ]
)

export const taskSegments = pgTable(
  "task_segments",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    segmentNo: integer().notNull(),
    agentId: text()
      .notNull()
      .references(() => agents.id),
    workflowId: text().notNull().unique(),
    snapshot: jsonb().notNull().$type<SegmentSnapshot>(),
    createdAt: timestamp(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.segmentNo] })]
)

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text().primaryKey(),
    workflowId: text().notNull(),
    revision: integer().notNull(),
    ownerId: text().notNull(),
    name: text().notNull(),
    sourceTaskId: text().references(() => tasks.id),
    compilationTaskId: text()
      .unique()
      .references(() => tasks.id),
    importedPackage: jsonb().$type<WorkflowPackage>(),
    importRequestId: text(),
    status: text({
      enum: ["draft", "verifying", "ready", "retired", "rejected"],
    }).notNull(),
    environment: jsonb().$type<WorkflowEnvironment>(),
    validatedEnvironment: jsonb().$type<WorkflowEnvironment>(),
    plan: jsonb().$type<WorkflowPlan>(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  (t) => [
    uniqueIndex("workflow_versions_revision_idx").on(t.workflowId, t.revision),
    index("workflow_versions_owner_idx").on(t.ownerId, t.createdAt),
    uniqueIndex("workflow_versions_import_request_idx").on(t.ownerId, t.importRequestId),
    check(
      "workflow_versions_origin_check",
      sql`((${t.sourceTaskId} IS NOT NULL AND ${t.compilationTaskId} IS NOT NULL) OR ${t.importedPackage} IS NOT NULL) AND (${t.importRequestId} IS NULL OR ${t.importedPackage} IS NOT NULL)`
    ),
    check(
      "workflow_versions_status_check",
      sql`${t.status} in ('draft','verifying','ready','retired','rejected')`
    ),
  ]
)

export const taskWorkflowRuns = pgTable(
  "task_workflow_runs",
  {
    taskId: text()
      .primaryKey()
      .references(() => tasks.id),
    versionId: text()
      .notNull()
      .references(() => workflowVersions.id),
    purpose: text({ enum: ["verify", "run"] }).notNull(),
    parameters: jsonb().notNull().$type<Record<string, string>>(),
    checkpoint: jsonb().notNull().$type<WorkflowCheckpoint>(),
    environment: jsonb().$type<WorkflowEnvironment>(),
    startedAt: pgTimestamp({ withTimezone: true }),
    completedAt: pgTimestamp({ withTimezone: true }),
    createdAt: timestamp(),
  },
  (t) => [index("task_workflow_runs_version_idx").on(t.versionId, t.createdAt)]
)

export const taskEvents = pgTable(
  "task_events",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    key: text().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    uniqueIndex("task_event_key_idx").on(t.taskId, t.key),
  ]
)

export const taskActions = pgTable(
  "task_actions",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    segmentNo: integer().notNull(),
    actionNo: integer().notNull(),
    dispatchId: text().notNull(),
    epoch: integer().notNull(),
    bootId: text().notNull(),
    kind: text().notNull(),
    input: jsonb().notNull().$type<Record<string, unknown>>(),
    effectClass: text({ enum: ["read", "verifiable", "ambiguous"] }).notNull(),
    status: text({ enum: ["intent", "succeeded", "failed", "unknown"] }).notNull(),
    receipt: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp(),
    finishedAt: pgTimestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.segmentNo, t.actionNo] })]
)

export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text().notNull(),
    storagePath: text().notNull(),
    mediaType: text().notNull(),
    size: integer().notNull(),
    verification: jsonb().notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp(),
  },
  (t) => [uniqueIndex("artifact_task_path_idx").on(t.taskId, t.storagePath)]
)

export const taskActionAttempts = pgTable(
  "task_action_attempts",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    segmentNo: integer().notNull(),
    actionNo: integer().notNull(),
    attemptNo: integer().notNull(),
    dispatchId: text().notNull().unique(),
    epoch: integer().notNull(),
    bootId: text().notNull(),
    status: text({ enum: ["intent", "succeeded", "rejected", "unknown"] }).notNull(),
    receipt: jsonb().$type<Record<string, unknown>>(),
    secretReleasedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    dispatchStartedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp(),
    finishedAt: pgTimestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.segmentNo, t.actionNo, t.attemptNo] })]
)

export type Task = typeof tasks.$inferSelect

/* ───────────── workstation ownership and human decisions ───────────── */

export const controlModes = [
  "idle",
  "agent",
  "quiescing",
  "human",
  "quarantined",
] as const
export type ControlMode = (typeof controlModes)[number]
export const workstationControl = pgTable("workstation_control", {
  agentId: text()
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  containerName: text().notNull().unique(),
  connectionSecret: text().notNull(),
  mode: text({ enum: controlModes }).notNull().default("idle"),
  epoch: integer().notNull().default(0),
  bootId: text(),
  activeTaskId: text().references(() => tasks.id),
  activeSegment: integer(),
  activeActionId: text(),
  desiredMode: text({ enum: ["human", "agent", "cancelled"] }),
  requestId: text(),
  lastError: text(),
  updatedAt: timestamp(),
})

export const taskRequests = pgTable(
  "task_requests",
  {
    id: text().primaryKey(),
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: text()
      .notNull()
      .references(() => agents.id),
    segmentNo: integer().notNull(),
    actionNo: integer(),
    kind: text({ enum: ["takeover", "approval", "review", "budget"] }).notNull(),
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    payloadVersion: integer().notNull().default(1),
    decision: text(),
    response: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: ["pending", "decided", "resolved", "cancelled"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp(),
    resolvedAt: pgTimestamp({ withTimezone: true }),
  },
  (t) => [index("task_requests_pending_idx").on(t.status)]
)

export const desktopTickets = pgTable("desktop_tickets", {
  token: text().primaryKey(),
  ownerId: text().notNull(),
  sessionId: text().notNull(),
  agentId: text()
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  mode: text({ enum: ["watch", "control"] }).notNull(),
  epoch: integer().notNull(),
  expiresAt: pgTimestamp({ withTimezone: true }).notNull(),
  usedAt: pgTimestamp({ withTimezone: true }),
  // A timed peek: the gateway closes the connection at this moment
  watchUntil: pgTimestamp({ withTimezone: true }),
})

/* Model responses are journaled independently of action receipts. API keys never enter this table. */
export const taskModelDecisions = pgTable(
  "task_model_decisions",
  {
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    segmentNo: integer().notNull(),
    decisionNo: integer().notNull(),
    epoch: integer().notNull(),
    status: text({ enum: ["pending", "retryable", "succeeded", "failed"] }).notNull(),
    attempts: integer().notNull().default(1),
    uncertainAttempts: integer().notNull().default(0),
    result: jsonb().$type<Record<string, unknown>>(),
    costMicros: bigint({ mode: "number" }),
    error: text(),
    createdAt: timestamp(),
    finishedAt: pgTimestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.segmentNo, t.decisionNo] })]
)

export const taskModelAttempts = pgTable(
  "task_model_attempts",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: text()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    segmentNo: integer().notNull(),
    decisionNo: integer().notNull(),
    attemptNo: integer().notNull(),
    model: text().notNull(),
    status: text({ enum: ["pending", "succeeded", "unknown"] }).notNull(),
    priceSnapshot: jsonb().$type<import("@/lib/providers/pricing").Price>(),
    usage: jsonb().$type<{
      input: number
      output: number
      cached: number
      reasoning: number
      missing: boolean
    }>(),
    costMicros: bigint({ mode: "number" }),
    reconciledCostMicros: bigint({ mode: "number" }),
    reconciliationNote: text(),
    reconciledAt: pgTimestamp({ withTimezone: true }),
    legacy: boolean().notNull().default(false),
    error: text(),
    startedAt: timestamp(),
    finishedAt: pgTimestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("model_attempt_key_idx").on(
      t.taskId,
      t.segmentNo,
      t.decisionNo,
      t.attemptNo
    ),
    index("model_attempt_started_idx").on(t.startedAt),
  ]
)

export const budgetChangesSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(200).optional(),
    maxCostMicros: z.number().int().min(0).max(100000000).nullable().optional(),
  })
  .refine(
    (value) => value.maxSteps !== undefined || value.maxCostMicros !== undefined,
    "Specify the new step or cost allowance"
  )

/* Telegram transport journals. Tokens remain encrypted in settings. */
export const telegramConnection = pgTable(
  "telegram_connection",
  {
    id: integer().primaryKey().default(1),
    ownerId: text()
      .notNull()
      .references(() => owners.userId),
    generation: text().notNull(),
    botId: text(),
    botUsername: text(),
    cursor: integer().notNull().default(0),
    pairCode: text(),
    pairExpiresAt: pgTimestamp({ withTimezone: true }),
    userId: text(),
    chatId: text(),
    ownerName: text(),
    pairedAt: pgTimestamp({ withTimezone: true }),
    agentId: text().references(() => agents.id, { onDelete: "set null" }),
    delegateAgentIds: jsonb().notNull().$type<string[]>().default([]),
    threadId: text().references(() => threads.id, { onDelete: "set null" }),
    taskId: text().references(() => tasks.id, { onDelete: "set null" }),
    lastPollAt: pgTimestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [check("single_telegram_connection", sql`${t.id} = 1`)]
)

export const telegramUpdates = pgTable(
  "telegram_updates",
  {
    generation: text().notNull(),
    updateId: integer().notNull(),
    senderId: text(),
    command: jsonb().notNull().$type<Record<string, unknown>>(),
    processedAt: pgTimestamp({ withTimezone: true }),
    createdAt: timestamp(),
  },
  (t) => [primaryKey({ columns: [t.generation, t.updateId] })]
)

export const telegramOutbox = pgTable(
  "telegram_outbox",
  {
    id: text().primaryKey(),
    generation: text().notNull(),
    key: text().notNull(),
    chatId: text().notNull(),
    method: text({ enum: ["sendMessage", "answerCallbackQuery"] })
      .notNull()
      .default("sendMessage"),
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    context: jsonb().$type<{
      taskId: string
      requestId: string
      payloadVersion: number
      kind: string
      purpose?: string
    }>(),
    status: text({ enum: ["pending", "sending", "sent", "unknown", "failed"] })
      .notNull()
      .default("pending"),
    messageId: integer(),
    attempts: integer().notNull().default(0),
    uncertainAttempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: timestamp(),
    nextAttemptAt: timestamp(),
  },
  (t) => [
    uniqueIndex("telegram_outbox_key_idx").on(t.generation, t.key),
    index("telegram_outbox_pending_idx").on(t.status, t.createdAt),
  ]
)

/* ─────────────────────────── companion ──────────────────────────── */

// Daily rhythm in the companion's time zone ("HH:MM"); a block may wrap midnight
export type RhythmBlock = { start: string; end: string; label?: string }
export type CompanionRhythm = {
  sleep: RhythmBlock
  nap: RhythmBlock | null
  away: RhythmBlock[]
}
export const defaultRhythm: CompanionRhythm = {
  sleep: { start: "23:30", end: "07:30" },
  nap: null,
  away: [],
}

export type CompanionPersona = {
  personality: string
  speakingStyle: string
  background: string
  // How she addresses the person
  callsYou: string
  interests: string
}

// One persona, one chat and one daily life per agent. Chat memory is the
// shared `memories` table. Design reference for the split between persona,
// memory and activity: SillyTavern character cards, Letta memory blocks.
export const companions = pgTable("companions", {
  agentId: text()
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  ownerId: text().notNull(),
  persona: jsonb().notNull().$type<CompanionPersona>(),
  mode: text({ enum: ["friend", "partner"] })
    .notNull()
    .default("friend"),
  // Set only when the person confirmed being 18 or older; partner mode needs it
  adultConfirmedAt: pgTimestamp({ withTimezone: true }),
  timeZone: text().notNull().default("UTC"),
  sharesPaused: boolean().notNull().default(false),
  maxSharesPerDay: integer().notNull().default(2),
  quietStart: text().notNull().default("23:00"),
  quietEnd: text().notNull().default("08:00"),
  lifeEnabled: boolean().notNull().default(false),
  lifeTimes: jsonb().notNull().$type<string[]>().default(["10:30", "20:30"]),
  lifeDailyBudgetMicros: integer().notNull().default(100_000),
  lifeSessionMaxSteps: integer().notNull().default(25),
  rhythm: jsonb().notNull().$type<CompanionRhythm>().default(defaultRhythm),
  // How long she "types" before each bubble (lib/companion/pacing.ts)
  typingPace: text({ enum: ["natural", "fast", "off"] })
    .notNull()
    .default("natural"),
  // When she last organized her notes into topic summaries, and whether she asked for another pass
  // (lib/companion/consolidate.ts)
  memoryOrganizedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  memoryOrganizeRequested: boolean().notNull().default(false),
  // Phone/browser notifications (lib/companion/push.ts): show a line of her message, or only
  // "she sent you a message"
  pushPreview: boolean().notNull().default(true),
  // Last time a visible chat page said it was open; no notification while the person is looking
  webSeenAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
})

// One row per browser/phone that allowed notifications. The endpoint belongs to the browser's
// push service (FCM, Mozilla autopush, Apple); p256dh/auth encrypt the payload for that browser only.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    createdAt: timestamp(),
    lastSentAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    failures: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
    index("push_subscriptions_agent_idx").on(t.agentId),
  ]
)

// What happened to each of her messages that could have become a notification (sent, or why not)
export const pushDeliveries = pgTable("push_deliveries", {
  messageId: text()
    .primaryKey()
    .references(() => companionMessages.id, { onDelete: "cascade" }),
  agentId: text()
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  status: text({ enum: ["sent", "skipped", "failed"] }).notNull(),
  reason: text(),
  devices: integer().notNull().default(0),
  createdAt: timestamp(),
})

export const companionMessages = pgTable(
  "companion_messages",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: text({ enum: ["user", "assistant"] }).notNull(),
    kind: text({
      enum: [
        "chat",
        "share",
        "errand_proposal",
        "errand_update",
        "crisis",
        "memory_candidate",
        "memory_merge",
        "coview",
      ],
    })
      .notNull()
      .default("chat"),
    content: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    channel: text().notNull().default("web"),
    createdAt: pgTimestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // Later bubbles of one reply are saved at once but shown one by one; null = shown immediately
    revealAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    // Replaced by "redo" / "edit" of the latest turn: kept for audit, hidden everywhere
    supersededAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [index("companion_messages_agent_idx").on(t.agentId, t.createdAt)]
)

// A picture the person sent her. The file lives under the artifact directory, is readable only by
// the owner and is deleted when `expiresAt` passes; the row keeps her one-line description.
export const companionImages = pgTable(
  "companion_images",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Relative to the artifact directory; null once the file has been deleted
    path: text(),
    bytes: integer().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    source: text().notNull().default("web"),
    // What she saw, in one sentence: the only trace of the picture in later turns
    description: text(),
    // A face or an ID document was seen, or we could not tell: never kept in long-term memory
    // unless the person asks for it
    sensitive: boolean().notNull().default(true),
    createdAt: timestamp(),
    expiresAt: pgTimestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("companion_images_agent_idx").on(t.agentId, t.createdAt),
    index("companion_images_expiry_idx").on(t.expiresAt),
  ]
)

// Spend of the light chat path; tasks are in task_model_attempts
export const companionUsage = pgTable(
  "companion_usage",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cachedTokens: integer().notNull().default(0),
    costMicros: integer(),
    durationMs: integer().notNull().default(0),
    createdAt: timestamp(),
  },
  (t) => [index("companion_usage_agent_idx").on(t.agentId, t.createdAt)]
)

export const lifeActivities = pgTable(
  "life_activities",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: text().references(() => tasks.id, { onDelete: "set null" }),
    kind: text({ enum: ["read", "watch", "diary", "save", "coview", "other"] }).notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    url: text(),
    // Diary text, and a page screenshot kept under the artifact directory
    body: text(),
    imagePath: text(),
    // The person's own favorites; her saved items are favorites too
    starred: boolean().notNull().default(false),
    createdAt: timestamp(),
  },
  (t) => [index("life_activities_agent_idx").on(t.agentId, t.createdAt)]
)

export const lifeShares = pgTable(
  "life_shares",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    activityId: text()
      .notNull()
      .references(() => lifeActivities.id, { onDelete: "cascade" }),
    text: text().notNull(),
    status: text({ enum: ["pending", "sent", "skipped"] })
      .notNull()
      .default("pending"),
    skipReason: text(),
    createdAt: timestamp(),
    sentAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [index("life_shares_status_idx").on(t.agentId, t.status, t.createdAt)]
)

export type Companion = typeof companions.$inferSelect
export type CompanionMessage = typeof companionMessages.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type CompanionImage = typeof companionImages.$inferSelect
export type MemorySuggestion = typeof memorySuggestions.$inferSelect
export type MemoryChange = typeof memoryChanges.$inferSelect
export type LifeActivity = typeof lifeActivities.$inferSelect
export type LifeShare = typeof lifeShares.$inferSelect

// A link the person sent: the companion opens it on her own computer and comments.
// It waits here while she is asleep or away, or while the desktop is busy.
export const coviewRequests = pgTable(
  "coview_requests",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    url: text().notNull(),
    status: text({ enum: ["pending", "started", "done", "skipped"] })
      .notNull()
      .default("pending"),
    taskId: text().references(() => tasks.id, { onDelete: "set null" }),
    createdAt: timestamp(),
  },
  (t) => [index("coview_requests_agent_idx").on(t.agentId, t.status, t.createdAt)]
)

/* ─────────────────────── companion channels ─────────────────────── */

export const channelIds = ["telegram", "qq", "wechat", "wechat_oa"] as const
export type ChannelId = (typeof channelIds)[number]

// What the adapter needs to remember about one person's chat on one channel,
// for example the last QQ msg_id or the WeChat context_token
export type ChannelLinkState = Record<string, unknown>

// One person (one openid / chat id) on one channel, bound to one companion.
// Every channel reads and writes the same companion_messages and memories.
export const channelLinks = pgTable(
  "channel_links",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerId: text().notNull(),
    channel: text({ enum: channelIds }).notNull(),
    externalId: text().notNull(),
    state: jsonb().notNull().$type<ChannelLinkState>().default({}),
    lastInboundAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp(),
  },
  (t) => [
    uniqueIndex("channel_links_external_idx").on(t.channel, t.externalId),
    uniqueIndex("channel_links_agent_idx").on(t.agentId, t.channel),
  ]
)

// One-time codes the person sends to the bot to bind an account (stored hashed)
export const channelPairCodes = pgTable(
  "channel_pair_codes",
  {
    id: id(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerId: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: pgTimestamp({ withTimezone: true, mode: "date" }).notNull(),
    usedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp(),
  },
  (t) => [uniqueIndex("channel_pair_codes_hash_idx").on(t.codeHash)]
)

// Messages received from channels, saved before anything slow happens so a
// redelivered event is never answered twice
export const channelInbound = pgTable(
  "channel_inbound",
  {
    id: id(),
    channel: text({ enum: channelIds }).notNull(),
    eventKey: text().notNull(),
    externalId: text().notNull(),
    text: text().notNull(),
    context: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    status: text({ enum: ["pending", "processing", "done", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: timestamp(),
    processedAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("channel_inbound_event_idx").on(t.channel, t.eventKey),
    index("channel_inbound_status_idx").on(t.status, t.createdAt),
  ]
)

// Outgoing messages. `held` ones cannot be sent now (the platform only allows replies)
// and are folded into her next reply on that channel.
export const channelOutbox = pgTable(
  "channel_outbox",
  {
    id: id(),
    linkId: text()
      .notNull()
      .references(() => channelLinks.id, { onDelete: "cascade" }),
    // The companion_messages row this was made from; makes fan-out idempotent
    messageId: text().references(() => companionMessages.id, { onDelete: "set null" }),
    kind: text({ enum: ["reply", "share", "update"] }).notNull(),
    text: text().notNull(),
    // Reply context captured when it was queued (QQ msg_id, WeChat context_token)
    context: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: ["pending", "held", "sent", "bundled", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    notBefore: pgTimestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp(),
    sentAt: pgTimestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("channel_outbox_message_idx").on(t.linkId, t.messageId),
    index("channel_outbox_status_idx").on(t.status, t.createdAt),
  ]
)

export type ChannelLink = typeof channelLinks.$inferSelect
export type ChannelInbound = typeof channelInbound.$inferSelect
export type ChannelOutbox = typeof channelOutbox.$inferSelect
