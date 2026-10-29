import type { z } from "zod"
export const nativeSchemas: Record<
  | "desktop_list_windows"
  | "desktop_get_window_state"
  | "desktop_ax_snapshot"
  | "desktop_element_action"
  | "desktop_ax_action"
  | "desktop_type"
  | "desktop_tag_context"
  | "desktop_tag_replace"
  | "desktop_tag_release",
  z.ZodObject<any>
>
