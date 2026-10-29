# Adapted from agent0ai/a0-connector, MIT, Copyright (c) 2026 Agent Zero.
# Pinned source: 3741c8809f1f99b4efee2ed1a24234a98bf896d4, Wayland computer_use_helper.py.
# Pure AT-SPI readers, window IDs, semantic matching/scoring and @a0 parser are reused.
# Portal transport/input is replaced by this project's X11/action/observation contracts.
# Full license: licenses/a0-connector-LICENSE (also shipped beside this file).
from __future__ import annotations
import json
import math
import re
import time
from typing import Any
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

Atspi.set_timeout(200, 200)
_AX_TEXT_MAX_CHARS = 240
_AX_SENTINEL_COORDINATE = -2147483648
_AX_TARGET_SEARCH_MAX_NODES = 800
_AT_SPI_FOCUS_SEARCH_MAX_NODES = 500
_TAG_TEXT_WINDOW_CHARS = 4096
_TAG_QUERY_MAX_CHARS = 2048
_TAG_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_AT_SPI_STATE_NAMES = tuple((s.upper(),s) for s in (
    "active","checked","editable","enabled","expanded","focused","focusable",
    "pressed","protected","selected","showing","visible","sensitive","read_only","required","defunct"))
_AT_SPI_PRESS_ACTION_NAMES = ("press","click","activate","default","toggle","open","invoke")
_AT_SPI_WINDOW_ROLES = {"alert","dialog","file chooser","frame","window"}
_AT_SPI_WINDOW_ACTIVATION_ROLES = {"application",*_AT_SPI_WINDOW_ROLES}
READ_ERRORS = []
DEADLINE = float("inf")

class PortalError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

_INTERFACE_METHODS = {
    "get_extents":"Component", "grab_focus":"Component",
    "get_n_actions":"Action", "get_action_name":"Action", "get_action_description":"Action", "get_key_binding":"Action",
    "get_character_count":"Text", "get_text":"Text", "get_caret_offset":"Text",
    "get_current_value":"Value",
}

def _safe_call(obj, method_name, *args):
    if time.monotonic() > DEADLINE:
        raise PortalError("AT_SPI_READ_LIMIT", "AT-SPI traversal time limit reached")
    interface = _INTERFACE_METHODS.get(method_name)
    if interface and interface not in obj.get_interfaces():
        return None
    # Accessible.get_text() is an interface getter, while Text.get_text(start,end)
    # reads content. Call the actual interface to avoid GI method-name collisions.
    method = getattr(getattr(Atspi, interface), method_name, None) if interface else getattr(obj, method_name, None)
    if not callable(method):
        return None
    try:
        return method(obj, *args) if interface else method(*args)
    except (GLib.Error, RuntimeError, NotImplementedError) as error:
        READ_ERRORS.append({"method":method_name,"error":type(error).__name__})
        return None


def _atspi_interface_call(Atspi, interface_name, method_name, element, *args):
    if interface_name not in element.get_interfaces():
        return None
    return getattr(getattr(Atspi, interface_name), method_name)(element, *args)


def object_identity(element):
    # libatspi exposes the D-Bus app + object path. Numeric child paths can be rebound.
    return {"bus":element.app.bus_name, "path":element.path}


def protected(element):
    return element.get_role() == Atspi.Role.PASSWORD_TEXT or "protected" in _atspi_states(Atspi,element)


def _atspi_node_metadata(Atspi, element, *, path, session):
    role = _atspi_role(element)
    states = _atspi_states(Atspi,element)
    node={"path":list(path),"role":role,"states":states,"objectId":object_identity(element)}
    if "enabled" not in states:
        node["states"].append("disabled")
    pid=_atspi_pid(element)
    if pid is not None: node["pid"]=pid
    frame=_atspi_frame(Atspi,element,session)
    if frame is not None:
        node["frame"]=frame
        node["bounds"]={k:frame[k] for k in ("x","y","width","height")}
    if protected(element):
        node.update(name="[redacted]",title="[redacted]",redacted=True)
        return node
    name=_atspi_name(element)
    node["name"]=name
    if name: node["title"]=name
    description=_atspi_description(element)
    if description:node["description"]=description
    actions=_atspi_actions(element)
    if actions:node["actions"]=actions
    text=_atspi_text(element)
    if text and text != name:node["text"]=text
    value=_atspi_value(element)
    if value is not None and (not isinstance(value,float) or math.isfinite(value)):node["value"]=value
    return node


def _safe_int(value: object, *, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clean_text(value: object, *, limit: int = _AX_TEXT_MAX_CHARS) -> str:
    text = str(value or "").replace("\x00", "").strip()
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "..."


def _frame_value(extents: object, field: str, index: int) -> int:
    if hasattr(extents, field):
        return _safe_int(getattr(extents, field), default=_AX_SENTINEL_COORDINATE)
    if isinstance(extents, (list, tuple)) and len(extents) > index:
        return _safe_int(extents[index], default=_AX_SENTINEL_COORDINATE)
    return _AX_SENTINEL_COORDINATE


def _parse_ax_path(value: object) -> list[int] | None:
    if value is None:
        return None
    raw: object = value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            decoded = None
        raw = (
            decoded
            if isinstance(decoded, (list, tuple))
            else [part for part in text.replace("/", ".").split(".") if part.strip()]
        )
    if not isinstance(raw, (list, tuple)):
        return None
    path: list[int] = []
    for item in raw:
        try:
            index = int(item)
        except (TypeError, ValueError):
            return None
        if index < 0:
            return None
        path.append(index)
    return path


def _normalized_match_text(value: object) -> str:
    return _clean_text(value, limit=1000).casefold()


def _list_contains_action(actions: object, candidates: tuple[str, ...]) -> bool:
    if not isinstance(actions, list):
        return False
    names = {str(item.get("name") or "").strip().casefold() for item in actions if isinstance(item, dict)}
    return any(candidate in names for candidate in candidates)


def _atspi_child_count(element: object) -> int:
    count = _safe_call(element, "get_child_count")
    return max(0, _safe_int(count, default=0))


def _atspi_child_at(element: object, index: int) -> object | None:
    return _safe_call(element, "get_child_at_index", index)


def _atspi_role(element: object) -> str:
    role = _clean_text(_safe_call(element, "get_role_name"), limit=80)
    if role:
        return role
    role_obj = _safe_call(element, "get_role")
    return _clean_text(role_obj, limit=80) or "element"


def _atspi_name(element: object) -> str:
    return _clean_text(_safe_call(element, "get_name"), limit=160)


def _atspi_description(element: object) -> str:
    return _clean_text(_safe_call(element, "get_description"), limit=240)


def _atspi_pid(element: object) -> int | None:
    pid = _safe_call(element, "get_process_id")
    if pid is None:
        return None
    return _safe_int(pid, default=0) or None


def _atspi_frame(Atspi: Any, element: object, session: PortalSession) -> dict[str, Any] | None:
    coord_type = getattr(getattr(Atspi, "CoordType", object()), "SCREEN", None)
    extents = _safe_call(element, "get_extents", coord_type)
    if extents is None:
        return None
    x = _frame_value(extents, "x", 0)
    y = _frame_value(extents, "y", 1)
    width = _frame_value(extents, "width", 2)
    height = _frame_value(extents, "height", 3)
    if x <= _AX_SENTINEL_COORDINATE or y <= _AX_SENTINEL_COORDINATE or width <= 0 or height <= 0:
        return None
    frame: dict[str, Any] = {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }
    if session.width > 0 and session.height > 0:
        frame.update(
            {
                "normalized_x": x / session.width,
                "normalized_y": y / session.height,
                "normalized_width": width / session.width,
                "normalized_height": height / session.height,
            }
        )
    return frame


def _atspi_states(Atspi: Any, element: object) -> list[str]:
    state_set = _safe_call(element, "get_state_set")
    contains = getattr(state_set, "contains", None)
    state_type = getattr(Atspi, "StateType", None)
    if not callable(contains) or state_type is None:
        return []
    states: list[str] = []
    for attr_name, display_name in _AT_SPI_STATE_NAMES:
        value = getattr(state_type, attr_name, None)
        if value is None:
            continue
        if contains(value):
            states.append(display_name)
    return states


def _atspi_actions(element: object) -> list[dict[str, str]]:
    count = max(0, _safe_int(_safe_call(element, "get_n_actions"), default=0))
    actions: list[dict[str, str]] = []
    for index in range(min(count, 16)):
        name = _clean_text(_safe_call(element, "get_action_name", index), limit=80)
        if not name:
            continue
        action: dict[str, str] = {"name": name}
        description = _clean_text(_safe_call(element, "get_action_description", index), limit=160)
        key_binding = _clean_text(_safe_call(element, "get_key_binding", index), limit=80)
        if description:
            action["description"] = description
        if key_binding:
            action["key_binding"] = key_binding
        actions.append(action)
    return actions


def _atspi_text(element: object) -> str:
    character_count = _safe_call(element, "get_character_count")
    count = _safe_int(character_count, default=0)
    if count <= 0:
        return ""
    text = _safe_call(element, "get_text", 0, min(count, _AX_TEXT_MAX_CHARS + 1))
    return _clean_text(text)


def _atspi_value(element: object) -> object | None:
    value = _safe_call(element, "get_current_value")
    if value is None:
        return None
    if isinstance(value, float):
        return round(value, 4)
    return value


def _atspi_element_for_path(desktop: object, path: list[int]) -> object | None:
    element = desktop
    for index in path:
        if index >= _atspi_child_count(element):
            return None
        element = _atspi_child_at(element, index)
        if element is None:
            return None
    return element


def _atspi_text_count(Atspi: Any, element: object) -> int:
    return max(
        0,
        _safe_int(
            _atspi_interface_call(Atspi, "Text", "get_character_count", element),
            default=0,
        ),
    )


def _atspi_text_range(Atspi: Any, element: object, start: int, end: int) -> str:
    value = _atspi_interface_call(Atspi, "Text", "get_text", element, start, end)
    return str(value or "").replace("\x00", "")


def _atspi_caret_offset(Atspi: Any, element: object) -> int:
    value = _atspi_interface_call(Atspi, "Text", "get_caret_offset", element)
    if value is None:
        value = _safe_call(element, "get_caret_offset")
    return _safe_int(value, default=-1)


def _atspi_find_focused(
    Atspi: Any,
    root: object,
    *,
    max_nodes: int = _AX_TARGET_SEARCH_MAX_NODES,
) -> tuple[object, list[int]] | None:
    active_roots: list[tuple[object, list[int]]] = []
    for app_index in range(_atspi_child_count(root)):
        app = _atspi_child_at(root, app_index)
        if app is None:
            continue
        app_active = "active" in _atspi_states(Atspi, app)
        active_window_found = False
        for window_index in range(_atspi_child_count(app)):
            window = _atspi_child_at(app, window_index)
            if window is not None and "active" in _atspi_states(Atspi, window):
                active_roots.append((window, [app_index, window_index]))
                active_window_found = True
        if app_active and not active_window_found:
            active_roots.append((app, [app_index]))

    search_roots = active_roots or [(root, [])]
    candidates: list[tuple[object, list[int]]] = []
    for search_root, search_path in search_roots:
        stack: list[tuple[object, list[int]]] = [(search_root, search_path)]
        visited = 0
        while stack and visited < max_nodes:
            element, path = stack.pop()
            visited += 1
            if "focused" in _atspi_states(Atspi, element):
                candidates.append((element, path))
            for index in range(_atspi_child_count(element)):
                child = _atspi_child_at(element, index)
                if child is not None:
                    stack.append((child, [*path, index]))
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            _atspi_text_count(Atspi, item[0]) > 0 and _atspi_caret_offset(Atspi, item[0]) >= 0,
            len(item[1]),
        ),
    )


def _parse_tag_invocation(
    Atspi: Any,
    element: object,
) -> tuple[int, int, str, str, str, str]:
    character_count = _atspi_text_count(Atspi, element)
    caret = _atspi_caret_offset(Atspi, element)
    if character_count <= 0 or caret < 0 or caret > character_count:
        raise PortalError("A0_TAG_TEXT_UNAVAILABLE", "The focused field has no readable caret text.")

    before_start = max(0, caret - _TAG_TEXT_WINDOW_CHARS)
    before = _atspi_text_range(Atspi, element, before_start, caret)
    newline = max(before.rfind("\n"), before.rfind("\r"))
    if newline < 0 and before_start > 0:
        raise PortalError("A0_TAG_QUERY_TOO_LONG", "The A0 Tag line is too long.")
    line_start = before_start + newline + 1
    line = before[newline + 1 :]

    after_end = min(character_count, caret + _TAG_TEXT_WINDOW_CHARS)
    after = _atspi_text_range(Atspi, element, caret, after_end)
    after_line = re.split(r"[\r\n]", after, maxsplit=1)[0]
    after_line_bounded = "\n" in after or "\r" in after or after_end == character_count
    if not after_line_bounded or after_line.strip():
        raise PortalError("A0_TAG_CARET_POSITION", "Place the caret at the end of the A0 Tag request.")

    match = re.fullmatch(
        r"(?P<indent>[ \t]*)(?P<tag>@a0(?:\.(?P<profile>[A-Za-z0-9][A-Za-z0-9_-]{0,63}))?[ \t]+(?P<query>.*?))(?P<trailing>[ \t]*)",
        line,
        flags=re.IGNORECASE,
    )
    if match is None:
        raise PortalError("A0_TAG_NOT_FOUND", "The focused line does not contain a valid @a0 request.")
    query = str(match.group("query") or "").strip()
    if not query:
        raise PortalError("A0_TAG_EMPTY_QUERY", "A0 Tag requires a request after the tag.")
    if len(query) > _TAG_QUERY_MAX_CHARS:
        raise PortalError("A0_TAG_QUERY_TOO_LONG", "A0 Tag requests are limited to 2048 characters.")
    profile = str(match.group("profile") or "")
    if profile and not _TAG_PROFILE_RE.fullmatch(profile):
        raise PortalError("A0_TAG_INVALID_PROFILE", "The A0 Tag profile key is invalid.")
    original = str(match.group("tag") or "")
    start = line_start + len(str(match.group("indent") or ""))
    end = start + len(original)
    focused_context = _atspi_text_range(
        Atspi,
        element,
        max(0, start - _TAG_TEXT_WINDOW_CHARS),
        min(character_count, end + _TAG_TEXT_WINDOW_CHARS),
    )
    return start, end, original, query, profile, focused_context


def _atspi_window_id(node: dict[str, Any], *, path: list[int]) -> str:
    path_text = ".".join(str(item) for item in path)
    pid = node.get("pid")
    if pid not in (None, ""):
        return f"atspi-pid:{pid}:path:{path_text}"
    return f"atspi-path:{path_text}"


def _parse_atspi_window_id(window_id: str) -> tuple[int | None, list[int] | None]:
    value = str(window_id or "").strip()
    if not value:
        return None, None
    pid: int | None = None
    path_text = ""
    if value.startswith("atspi-pid:") and ":path:" in value:
        pid_text, path_text = value.removeprefix("atspi-pid:").split(":path:", 1)
        try:
            pid = int(pid_text)
        except ValueError:
            pid = None
    elif value.startswith("atspi-path:"):
        path_text = value.removeprefix("atspi-path:")
    else:
        return None, None
    return pid, _parse_ax_path(path_text) or []


def _atspi_node_is_visible(node: dict[str, Any]) -> bool:
    states = {str(item).strip().casefold() for item in node.get("states", [])}
    if states:
        return "visible" in states or "showing" in states
    return True


def _atspi_node_is_offscreen(node: dict[str, Any]) -> bool:
    frame = node.get("frame")
    if not isinstance(frame, dict):
        return False
    try:
        x = float(frame.get("normalized_x"))
        y = float(frame.get("normalized_y"))
        width = float(frame.get("normalized_width"))
        height = float(frame.get("normalized_height"))
    except (TypeError, ValueError):
        return False
    return x + width <= 0 or y + height <= 0 or x >= 1 or y >= 1


def _node_text_fields(node: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
    values: list[str] = []
    for key in keys:
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value)
    return values


def _atspi_node_matches_target(node: dict[str, Any], target: dict[str, Any]) -> bool:
    comparable = {
        "role": ("role",),
        "title": ("title", "name", "text", "description"),
        "name": ("name", "title", "text", "description"),
        "description": ("description",),
        "text": ("text", "title", "name", "description"),
        "value": ("value",),
    }
    for target_key, node_keys in comparable.items():
        if target.get(target_key) is None:
            continue
        wanted = _normalized_match_text(target.get(target_key))
        if not wanted:
            continue
        haystacks = [_normalized_match_text(value) for value in _node_text_fields(node, node_keys)]
        if target_key == "value" and node.get("value") is not None:
            haystacks.append(_normalized_match_text(node.get("value")))
        if target_key == "role":
            if not any(wanted == haystack or wanted in haystack for haystack in haystacks):
                return False
            continue
        if not any(wanted == haystack or wanted in haystack for haystack in haystacks):
            return False
    target_actions = target.get("actions")
    if isinstance(target_actions, str):
        wanted_actions = {target_actions.strip().casefold()}
    elif isinstance(target_actions, (list, tuple, set)):
        wanted_actions = {str(item).strip().casefold() for item in target_actions if str(item).strip()}
    else:
        wanted_actions = set()
    if wanted_actions:
        node_actions = {
            str(item.get("name") or "").strip().casefold()
            for item in node.get("actions", [])
            if isinstance(item, dict)
        }
        if not wanted_actions & node_actions:
            return False
    target_states = target.get("states")
    if isinstance(target_states, str):
        wanted_states = {target_states.strip().casefold()}
    elif isinstance(target_states, (list, tuple, set)):
        wanted_states = {str(item).strip().casefold() for item in target_states if str(item).strip()}
    else:
        wanted_states = set()
    if wanted_states:
        node_states = {str(item).strip().casefold() for item in node.get("states", [])}
        if not wanted_states <= node_states:
            return False
    return True


def _atspi_match_score(node: dict[str, Any], operation: str) -> int:
    score = 0
    states = {str(item).casefold() for item in node.get("states", [])}
    if "showing" in states:
        score += 4
    if "visible" in states:
        score += 2
    if "enabled" in states:
        score += 2
    if operation == "press" and _list_contains_action(node.get("actions"), _AT_SPI_PRESS_ACTION_NAMES):
        score += 8
    if operation == "focus" and ("focusable" in states or "focused" in states):
        score += 4
    if operation == "set_value" and ("editable" in states or "text" in str(node.get("role", "")).casefold()):
        score += 6
    if node.get("frame"):
        score += 1
    return score


def _target_summary(targets: list[dict[str, Any]]) -> str:
    summaries: list[str] = []
    for node in targets[:5]:
        role = str(node.get("role") or "element")
        title = str(node.get("title") or node.get("name") or node.get("text") or "").strip()
        path = node.get("path", [])
        if title:
            summaries.append(f"{role} {title!r} path={path}")
        else:
            summaries.append(f"{role} path={path}")
    return "; ".join(summaries)

