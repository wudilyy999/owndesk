import { tool } from "ai"
import { nativeSchemas } from "@/workstation/controller/native-schema.mjs"

export const nativeTools = {
  desktop_list_windows: tool({
    inputSchema: nativeSchemas.desktop_list_windows,
    description:
      "List native Linux windows with window_id, PID, title, bounds and visibility/focus. Read-only; choose an exact window before observing or acting.",
  }),
  desktop_get_window_state: tool({
    inputSchema: nativeSchemas.desktop_get_window_state,
    description:
      "Observe a native window by window_id/PID (current active window if omitted). Returns compact AT-SPI controls with element_index/path, role/name, text/value, states, action names, bounds and fresh observationId. Adaptive: ordinary small/moderate trees expand multiple levels in this one call so actionable refs are ready immediately—do not assume you must drill layer-by-layer. Huge/virtual tables/grids are summarized (row/column counts, focused/selected/region cells) while menus/toolbars stay visible; use subtree_path or table_region only when omitReasons show needed detail was omitted. Complete controls normally omit the screenshot; incomplete/unavailable controls or conflicting numeric text/value add one automatically. Use screen_capture whenever uncertain or visual verification is needed. Indices/paths belong to this observation only. Scoped controls may describe a background window; foreground-focus it and obtain a fresh screenshot before coordinate fallback.",
  }),
  desktop_ax_snapshot: tool({
    inputSchema: nativeSchemas.desktop_ax_snapshot,
    description:
      "Read compact AT-SPI controls scoped to window_id/PID, or across the desktop if neither is supplied. Adaptive multi-level expansion in one read when the tree fits; only huge/virtual tables are summarized—pass subtree_path/table_region when omitReasons show local detail was skipped, not as a mandatory first step. Complete controls normally omit the screenshot and return a fresh observationId; incomplete/unavailable or conflicting state includes a screenshot. Use screen_capture if uncertain or needing visual evidence. Prefer a specific window to avoid unrelated applications consuming the node budget.",
  }),
  desktop_element_action: tool({
    inputSchema: nativeSchemas.desktop_element_action,
    description:
      "Operate a fresh native AT-SPI element by element_index, path or unique semantic target. Supports press/focus/set_value; background is default, auto permits an explicit foreground fallback, foreground may change focus. Focusing a document/container may land on an editable descendant (reported as focus_mode=descendant); that is success when still inside the target. Use foreground focus for windows. Returns fresh controls and observationId; complete background results normally omit screenshots, while foreground dispatch, native fallback or incomplete/conflicting state includes one. Dispatch is an attempt: verify the returned state. Call screen_capture whenever uncertain or needing visual verification. Protected fields use the existing secret/takeover flow. Unknown effects must never be repeated.",
  }),
  desktop_ax_action: tool({
    inputSchema: nativeSchemas.desktop_ax_action,
    description:
      "Perform AT-SPI press/focus/set_value using a path or semantic role/name/text/states/actions target (element_index also accepted). Requires latest observationId; a whole-desktop snapshot can identify the target window through a unique observed target. Narrow to an explicit window when partial or ambiguous. Same dispatch, approval, protected-field and unknown-effect rules as desktop_element_action.",
  }),
  desktop_type: tool({
    inputSchema: nativeSchemas.desktop_type,
    description:
      "Type through the existing X11 keyboard path only after verifying the exact observed native window is active and focused. Requires latest observationId and window_id; optional submit presses Enter. Returns fresh controls and observationId, with a screenshot only when state is incomplete/conflicting. Call screen_capture whenever uncertain or needing visual verification. Password/protected fields are refused.",
  }),
  desktop_tag_context: tool({
    inputSchema: nativeSchemas.desktop_tag_context,
    description:
      "Read the focused native field's @a0[.profile] request at the caret. Returns bounded surrounding context, a one-use targetToken and fresh observation; never reads protected fields. Does not replace text or authorize external actions.",
  }),
  desktop_tag_replace: tool({
    inputSchema: nativeSchemas.desktop_tag_replace,
    description:
      "Replace the exact still-focused @a0 request range using a fresh observationId and its targetToken. Validates native object identity, window, focus and original range. Partial/unknown changes require review, never automatic repetition.",
  }),
  desktop_tag_release: tool({
    inputSchema: nativeSchemas.desktop_tag_release,
    description:
      "Release an unused native text targetToken without changing any application content.",
  }),
}
