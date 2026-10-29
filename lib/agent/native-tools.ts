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
      "Observe a native window by window_id/PID (current active window if omitted). Returns its bounded AT-SPI hierarchy, read-only properties, fresh observationId and original desktop screenshot. Element indices/paths belong to this observation only; increase max_depth/max_nodes within their limits when omitted controls are needed. A scoped tree may describe a background window; foreground-focus it and use the fresh screenshot before coordinate fallback.",
  }),
  desktop_ax_snapshot: tool({
    inputSchema: nativeSchemas.desktop_ax_snapshot,
    description:
      "Read an AT-SPI snapshot scoped to window_id/PID, or the desktop tree if neither is supplied. Returns an original screenshot and fresh observationId. Prefer a specific window to avoid unrelated applications consuming the node budget.",
  }),
  desktop_element_action: tool({
    inputSchema: nativeSchemas.desktop_element_action,
    description:
      "Operate a fresh native AT-SPI element by element_index, path or unique semantic target. Supports press/focus/set_value; background is default, auto permits an explicit foreground fallback, foreground may change focus. Use foreground focus for windows. A dispatch is an attempt; inspect returned fresh screenshot/tree and explicit effect/verification status. Protected fields use the existing secret/takeover flow. Unknown effects must never be repeated.",
  }),
  desktop_ax_action: tool({
    inputSchema: nativeSchemas.desktop_ax_action,
    description:
      "Perform AT-SPI press/focus/set_value using a path or semantic role/name/text/states/actions target (element_index also accepted). Requires latest observationId; a whole-desktop snapshot can identify the target window through a unique observed target. Narrow to an explicit window when partial or ambiguous. Same dispatch, approval, protected-field and unknown-effect rules as desktop_element_action.",
  }),
  desktop_type: tool({
    inputSchema: nativeSchemas.desktop_type,
    description:
      "Type through the existing X11 keyboard path only after verifying the exact observed native window is active and focused. Requires latest observationId and window_id; optional submit presses Enter. Returns a fresh screenshot/tree. Password/protected fields are refused.",
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
