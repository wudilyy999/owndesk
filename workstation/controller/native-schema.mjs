import { z } from "zod"
const window = {
  window_id: z.string().min(1).max(240).optional(),
  pid: z.number().int().positive().optional(),
}
const tableRegion = z
  .object({
    row_start: z.number().int().nonnegative().max(1_048_575).default(0),
    col_start: z.number().int().nonnegative().max(16383).default(0),
    row_count: z.number().int().min(1).max(32).default(8),
    col_count: z.number().int().min(1).max(32).default(8),
  })
  .optional()
const snapshot = {
  ...window,
  // Adaptive defaults: several levels in ONE observe when the tree fits the budget.
  max_depth: z.number().int().min(0).max(12).default(8),
  max_nodes: z.number().int().min(1).max(500).default(160),
  include_hidden: z.boolean().default(false),
  // Optional drill when omitReasons show a summarized/truncated region — not a mandatory first step.
  subtree_path: z.array(z.number().int().nonnegative()).min(1).max(40).optional(),
  table_region: tableRegion,
  expand_tables: z.boolean().default(false),
  compact_structure: z.boolean().default(true),
  child_expand_cap: z.number().int().min(4).max(120).default(40),
}
const target = z
  .object({
    role: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().min(1).max(240).optional(),
    value: z.union([z.string().trim().min(1).max(240), z.number().finite()]).optional(),
    actions: z.array(z.string().trim().min(1).max(80)).min(1).max(16).optional(),
    states: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "A semantic target must include a condition"
  )
const input = {
  observationId: z.uuid(),
  ...window,
  element_index: z.number().int().nonnegative().max(500).optional(),
  path: z.array(z.number().int().nonnegative()).min(1).max(40).optional(),
  target: target.optional(),
  operation: z.enum(["press", "focus", "set_value"]).default("press"),
  dispatch: z.enum(["background", "auto", "foreground"]).default("background"),
  action_name: z.string().min(1).max(80).optional(),
  value: z.union([z.string().max(50000), z.number().finite()]).optional(),
  text: z.string().max(50000).optional(),
  submit: z.boolean().default(false),
}
export const nativeSchemas = {
  desktop_list_windows: z.object({
    include_hidden: z.boolean().default(false),
    include_offscreen: z.boolean().default(false),
    max_windows: z.number().int().min(1).max(500).default(80),
  }),
  desktop_get_window_state: z.object(snapshot),
  desktop_ax_snapshot: z.object(snapshot),
  desktop_element_action: z
    .object(input)
    .refine(
      (v) => !v.submit || v.operation === "set_value",
      "submit applies only to set_value"
    ),
  desktop_ax_action: z
    .object(input)
    .refine(
      (v) => !v.submit || v.operation === "set_value",
      "submit applies only to set_value"
    ),
  desktop_type: z.object({
    observationId: z.uuid(),
    window_id: z.string().min(1).max(240),
    text: z.string().min(1).max(50000),
    submit: z.boolean().default(false),
  }),
  desktop_tag_context: z.object(window),
  desktop_tag_replace: z.object({
    observationId: z.uuid(),
    targetToken: z.uuid(),
    replacement: z.string().min(1).max(16384),
  }),
  desktop_tag_release: z.object({ targetToken: z.uuid() }),
}
