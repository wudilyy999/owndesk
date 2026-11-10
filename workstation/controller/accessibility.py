"""AT-SPI desktop bridge; observations and native input share the controller journal."""
from __future__ import annotations
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from types import SimpleNamespace
import atspi_core as ax

Atspi, GLib = ax.Atspi, ax.GLib
EFFECT = False


def now():
    return datetime.now(timezone.utc).isoformat()


def reject(code, message):
    raise ax.PortalError(code, message)


def command(args, text=None, timeout=5):
    result = subprocess.run(args, input=text, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        reject("X11_COMMAND_FAILED", "Native desktop command failed: " + args[0])
    return result.stdout.strip()


def active_xid():
    import re
    value = command(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    match = re.search(r"# (0x[0-9a-f]+)", value, re.I)
    return int(match[1], 16) if match else None


def windows(desktop, session, options):
    records = []
    truncated = False
    for i in range(ax._atspi_child_count(desktop)):
        app = ax._atspi_child_at(desktop, i)
        if app is None:
            continue
        app_name = ax._atspi_name(app)
        queue = [(app, [i], 0)]
        visited = 0
        while queue and visited < 800:
            element, path, depth = queue.pop(0)
            visited += 1
            role = ax._atspi_role(element)
            if role in ax._AT_SPI_WINDOW_ROLES:
                node = ax._atspi_node_metadata(Atspi, element, path=path, session=session)
                if not options.get("include_hidden", False) and not ax._atspi_node_is_visible(node):
                    continue
                if not options.get("include_offscreen", False) and ax._atspi_node_is_offscreen(node):
                    continue
                node.update(window_id=ax._atspi_window_id(node, path=path),
                            app_name=app_name, title=node.get("title") or node.get("name") or app_name,
                            visible=ax._atspi_node_is_visible(node),
                            active="active" in node["states"], focused="focused" in node["states"])
                records.append((element, node))
                if len(records) >= options.get("max_windows", 80):
                    return records, True
            elif depth < 3:
                for j in range(ax._atspi_child_count(element)):
                    child = ax._atspi_child_at(element, j)
                    if child is not None:
                        queue.append((child, path + [j], depth + 1))
        truncated = truncated or bool(queue)
    return records, truncated


def select_window(records, state, options):
    requested_id, pid = options.get("window_id"), options.get("pid")
    if requested_id:
        parsed_pid, path = ax._parse_atspi_window_id(requested_id)
        element = ax._atspi_element_for_path(Atspi.get_desktop(0), path) if path is not None else None
        if element is None:
            reject("WINDOW_NOT_EXPOSED", "No matching native window was exposed by AT-SPI")
        node = ax._atspi_node_metadata(Atspi, element, path=path,
                                       session=SimpleNamespace(width=state["width"], height=state["height"]))
        if node["role"] not in ax._AT_SPI_WINDOW_ROLES or (parsed_pid is not None and node.get("pid") != parsed_pid) or (pid is not None and node.get("pid") != pid):
            reject("WINDOW_NOT_EXPOSED", "Native window path or process identity does not match")
        node.update(window_id=ax._atspi_window_id(node, path=path),
                    app_name=ax._atspi_name(ax._atspi_element_for_path(Atspi.get_desktop(0), path[:1])),
                    visible=ax._atspi_node_is_visible(node),
                    active="active" in node["states"], focused="focused" in node["states"])
        return element, node
    if pid is not None:
        candidates = [(element, node) for element, node in records
                      if node.get("pid") == pid]
    else:
        window = state.get("window")
        if window is None:
            reject("NO_ACTIVE_WINDOW", "No active native window")
        output = command(["xprop", "-id", window["id"], "_NET_WM_PID"])
        import re
        match = re.search(r"=\s*(\d+)", output)
        if not match:
            reject("WINDOW_PID_UNAVAILABLE", "The active X11 window exposes no process ID")
        pid = int(match[1])
        candidates = []
        for element, node in records:
            if node.get("pid") != pid:
                continue
            frame = node.get("frame", {})
            exact = all(abs(frame.get(k, -100000) - window[k]) <= 4 for k in ("x", "y", "width", "height"))
            name = node.get("name", "")
            if name == window["title"] or (not name and exact):
                candidates.append((element, node))
    if not candidates:
        reject("WINDOW_NOT_EXPOSED", "No matching native window was exposed by AT-SPI")
    if len(candidates) != 1:
        reject("WINDOW_AMBIGUOUS", "Several native windows match; select an exact window_id")
    return candidates[0]


def serialize(element, path, session, options):
    """Adaptive multi-level observe: expand ordinary small/moderate trees in one shot.

    Huge/virtual tables stay summarized. Redundant single-child wrappers can be
    skipped in the flat payload (still traversed) so budgets reach actionable refs.
    Never walks a huge tree just to decide size — uses O(1) child_count / table dims.
    """
    flat = []
    truncated = False
    omit_reasons = []
    max_nodes = options.get("max_nodes", 160)
    max_depth = options.get("max_depth", 8)
    table_region = options.get("table_region")
    expand_tables = bool(options.get("expand_tables", False))
    compact_structure = bool(options.get("compact_structure", True))
    child_cap = int(options.get("child_expand_cap", ax._AT_SPI_CHILD_EXPAND_CAP))
    visits = {"nodes": 0, "table_probes": 0, "skipped_wrappers": 0, "max_depth_seen": 0}
    visits["requested_depth"] = max_depth
    visits["requested_nodes"] = max_nodes

    def remember_omit(reason, **detail):
        if len(omit_reasons) < 12:
            omit_reasons.append({"reason": reason, **detail})

    def visit(node, node_path, depth):
        nonlocal truncated
        visits["nodes"] += 1
        visits["max_depth_seen"] = max(visits["max_depth_seen"], depth)
        if len(flat) >= max_nodes or time.monotonic() > ax.DEADLINE:
            truncated = True
            remember_omit("budget", max_nodes=max_nodes)
            return None
        record = ax._atspi_node_metadata(Atspi, node, path=node_path, session=session)
        if "defunct" in record["states"]:
            ax.READ_ERRORS.append({"error": "defunct_node"})
            return None
        if depth and record["role"] != "application" and not options.get("include_hidden", False) and "showing" not in record["states"]:
            return None
        count = ax._atspi_child_count(node)
        # Skip nameless single-child wrappers from the flat list so depth/budget
        # reach buttons/fields; AT-SPI paths for descendants stay valid.
        if (
            compact_structure
            and depth > 0
            and ax._atspi_is_redundant_structure(record, count)
        ):
            visits["skipped_wrappers"] += 1
            child = ax._atspi_child_at(node, 0)
            if child is None:
                return None
            try:
                return visit(child, node_path + [0], depth)  # same depth budget
            except ax.PortalError as error:
                if error.code != "AT_SPI_READ_LIMIT":
                    raise
                truncated = True
                remember_omit("deadline")
                return None

        record["element_index"] = len(flat)
        record["parentPath"] = node_path[:-1]
        flat.append(record)
        tree_node = dict(record)
        if record.get("redacted"):
            return tree_node
        if depth >= max_depth:
            truncated = truncated or count > 0
            if count > 0:
                remember_omit("max_depth", path=list(node_path), childCount=count, requestedDepth=max_depth)
            return tree_node
        children = []
        role = record["role"]
        remaining = max_nodes - len(flat)
        summarize_table = (not expand_tables) and ax._atspi_table_should_summarize(
            Atspi, node, role=role, remaining_nodes=remaining
        )
        if summarize_table:
            cells, summary = ax._atspi_table_priority_cells(
                Atspi,
                node,
                path=node_path,
                region=table_region if (
                    not options.get("subtree_path")
                    or list(options.get("subtree_path")) == list(node_path)
                ) else table_region,
                max_cells=min(40, max(8, remaining)),
            )
            visits["table_probes"] += int(summary.get("probes") or 0)
            record["tableSummary"] = summary
            tree_node["tableSummary"] = summary
            truncated = True
            remember_omit(
                "table_summarized",
                path=list(node_path),
                omittedCells=summary.get("omittedCells"),
                nRows=summary.get("nRows"),
                nCols=summary.get("nCols"),
            )
            for child, child_path, meta in cells:
                if len(flat) >= max_nodes or time.monotonic() > ax.DEADLINE:
                    truncated = True
                    break
                try:
                    child_node = visit(child, child_path, depth + 1)
                except ax.PortalError as error:
                    if error.code != "AT_SPI_READ_LIMIT":
                        raise
                    truncated = True
                    remember_omit("deadline")
                    break
                if child_node is not None:
                    child_node = dict(child_node)
                    child_node["tableCell"] = meta
                    if flat and flat[-1].get("path") == child_path:
                        flat[-1]["tableCell"] = meta
                    children.append(child_node)
            if children:
                tree_node["children"] = children
            return tree_node

        # Ordinary expansion: multi-level in one observe, capped fan-out per parent.
        expand_count = count
        if count > child_cap:
            expand_count = child_cap
            truncated = True
            remember_omit("child_cap", path=list(node_path), childCount=count, cap=child_cap)
        for index in range(expand_count):
            if len(flat) >= max_nodes or time.monotonic() > ax.DEADLINE:
                truncated = True
                remember_omit("budget", max_nodes=max_nodes)
                break
            child = ax._atspi_child_at(node, index)
            if child is not None:
                try:
                    child_node = visit(child, node_path + [index], depth + 1)
                except ax.PortalError as error:
                    if error.code != "AT_SPI_READ_LIMIT":
                        raise
                    truncated = True
                    remember_omit("deadline")
                    break
                if child_node is not None:
                    children.append(child_node)
            else:
                ax.READ_ERRORS.append({"error": "empty_child"})
        if children:
            tree_node["children"] = children
        return tree_node

    tree = visit(element, path, 0)
    return tree, flat, truncated, omit_reasons, visits



def snapshot(request):
    state, options = request["state"], request.get("options", {})
    session = SimpleNamespace(width=state["width"], height=state["height"])
    desktop = Atspi.get_desktop(0)
    metadata = dict(source="atspi2", status="ok", capturedAt=now(), scope="active_window",
                    coordinateSpace="screenshot_pixels", truncated=False)
    result = dict(accessibility=metadata, elements=[])
    try:
        records, windows_truncated = ([], False) if options.get("window_id") and options.get("action") != "list_windows" else windows(desktop, session, {"include_hidden": True, "include_offscreen": True, "max_windows": 500})
        if options.get("action") == "list_windows":
            filtered = [node for _, node in records
                        if (options.get("include_hidden") or ax._atspi_node_is_visible(node))
                        and (options.get("include_offscreen") or not ax._atspi_node_is_offscreen(node))]
            selected = filtered[:options.get("max_windows", 80)]
            return {"backend": "at-spi", "windows": selected, "count":len(selected),
                    "truncated": windows_truncated or len(filtered) > options.get("max_windows", 80), "capturedAt": now()}
        if windows_truncated:
            metadata["windowsTruncated"] = True
        whole_desktop = options.get("action") == "ax_snapshot" and not options.get("window_id") and options.get("pid") is None
        if whole_desktop:
            root, window, root_path = desktop, None, []
            metadata["scope"] = "desktop"
        else:
            root, window = select_window(records, state, options)
            root_path = window["path"]
            metadata.update(scope="target_window" if options.get("window_id") or options.get("pid") else "active_window",
                            pid=window.get("pid"), window=window)
        subtree = options.get("subtree_path")
        if subtree is not None:
            subtree_path = ax._parse_ax_path(subtree)
            if subtree_path is None:
                reject("INVALID_SUBTREE_PATH", "subtree_path must be a non-negative integer path")
            if root_path and subtree_path[:len(root_path)] != root_path:
                reject("SUBTREE_OUTSIDE_WINDOW", "subtree_path must stay inside the observed window")
            subtree_element = ax._atspi_element_for_path(desktop, subtree_path)
            if subtree_element is None:
                reject("SUBTREE_NOT_FOUND", "subtree_path no longer exists")
            root, root_path = subtree_element, subtree_path
            metadata["scope"] = "subtree"
            metadata["subtree_path"] = subtree_path
        tree, flat, truncated, omit_reasons, visits = serialize(root, root_path, session, options)
        metadata.update(
            truncated=truncated,
            visited=visits["nodes"],
            nodeVisits=visits["nodes"],
            tableProbes=visits.get("table_probes", 0),
            requestedDepth=visits.get("requested_depth", options.get("max_depth", 8)),
            maxDepthSeen=visits.get("max_depth_seen", 0),
            requestedNodes=visits.get("requested_nodes", options.get("max_nodes", 160)),
            skippedWrappers=visits.get("skipped_wrappers", 0),
            policy="adaptive",
        )
        if omit_reasons:
            metadata["omitReasons"] = omit_reasons
        if truncated or windows_truncated or ax.READ_ERRORS or omit_reasons:
            metadata["status"] = "partial"
        if ax.READ_ERRORS:
            metadata["warnings"] = ax.READ_ERRORS[:3]
        # Prefer actionable/focused controls; keep table summaries even without text.
        elements = [node for node in flat if node.get("name") or node.get("text") or "value" in node
                    or node.get("actions") or "editable" in node["states"]
                    or node.get("tableSummary") or node.get("tableCell")
                    or "focused" in node["states"] or "selected" in node["states"]]
        result.update(window_id=window["window_id"] if window else None,
                      app_name=window["app_name"] if window else "Linux desktop", elements=elements[:options.get("max_elements", 500)],
                      node_count=len(flat), omittedElements=max(0, len(elements)-options.get("max_elements", 500)))
        if options.get("include_tree", True):
            result["tree"] = tree
        result["_nativeSnapshot"] = {"window": window, "windows": [node for _, node in records], "nodes": flat,
                                     "options": options, "truncated": truncated, "omitReasons": omit_reasons,
                                     "visits": visits}
    except ax.PortalError as error:
        if options.get("action") == "list_windows":
            return {"error":str(error),"code":error.code,"effect":"none","backend":"at-spi","windows":[],"truncated":True}
        metadata.update(status="unavailable", reason=error.code, error=str(error))
    metadata["completedAt"] = now()
    return result


def same_identity(old, current):
    return old.get("objectId") == current.get("objectId") and old.get("pid") == current.get("pid")


def semantic_target(nodes, options):
    matches = [(ax._atspi_match_score(node, options.get("operation", "press")), node)
               for node in nodes if not node.get("redacted") and ax._atspi_node_matches_target(node, options["target"])]
    if not matches:
        reject("TARGET_NOT_FOUND", "No native control matches the semantic target")
    matches.sort(key=lambda pair: pair[0], reverse=True)
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        reject("TARGET_AMBIGUOUS", "Several controls match the semantic target; narrow it or use a fresh index")
    return matches[0][1]


def guarded_window(request, desktop, session):
    expected = request["expected"]["window"]
    if expected is None:
        options, observed = request["options"], request["expected"]
        candidates = observed["windows"]
        if options.get("window_id"):
            candidates = [w for w in candidates if w["window_id"] == options["window_id"]]
        elif options.get("pid") is not None:
            candidates = [w for w in candidates if w.get("pid") == options["pid"]]
        else:
            node = None
            if options.get("element_index") is not None:
                node = next((n for n in observed["nodes"] if n["element_index"] == options["element_index"]), None)
            elif options.get("path") is not None:
                node = next((n for n in observed["nodes"] if n["path"] == options["path"]), None)
            elif options.get("target"):
                if observed["truncated"]:
                    reject("TARGET_SEARCH_TRUNCATED", "Desktop snapshot is partial; observe a specific window before semantic targeting")
                node = semantic_target(observed["nodes"], options)
            if node is None:
                reject("WINDOW_REQUIRED", "Provide an observed native window or a target from the current desktop snapshot")
            candidates = [w for w in candidates if node["path"][:len(w["path"])] == w["path"]]
        if len(candidates) != 1:
            reject("WINDOW_AMBIGUOUS", "The desktop target does not identify one observed native window")
        expected = candidates[0]
    root, window = select_window([], request["state"], {"window_id": expected["window_id"]})
    if not same_identity(expected, window):
        reject("STALE_WINDOW", "Native window identity changed; observe again")
    requested_id = request["options"].get("window_id")
    if requested_id and requested_id != window["window_id"]:
        reject("WINDOW_MISMATCH", "Action window_id differs from the observed native window")
    requested_pid = request["options"].get("pid")
    if requested_pid is not None and requested_pid != window.get("pid"):
        reject("WINDOW_MISMATCH", "Action PID differs from the observed native window")
    return root, window


def target_element(request, root, window, session):
    options = request["options"]
    desktop = Atspi.get_desktop(0)
    expected_nodes = request["expected"]["nodes"]
    old = None
    if options.get("element_index") is not None:
        old = next((node for node in expected_nodes if node["element_index"] == options["element_index"]), None)
        if old is None:
            reject("STALE_ELEMENT_INDEX", "Index is absent from this observation")
        path = old["path"]
    elif options.get("path") is not None:
        path = ax._parse_ax_path(options["path"])
        old = next((node for node in expected_nodes if node["path"] == path), None)
        if old is None:
            reject("STALE_ELEMENT_PATH", "Path is absent from this observation")
    elif options.get("target"):
        tree, flat, truncated, _omit_reasons, _visits = serialize(
            root,
            window["path"],
            session,
            {**request["expected"]["options"], "max_nodes": 800, "max_depth": 40, "expand_tables": True},
        )
        if truncated:
            reject("TARGET_SEARCH_TRUNCATED", "Target search was incomplete; narrow the window or use a fresh index")
        fresh = semantic_target(flat, options)
        old = next((node for node in expected_nodes if node["path"] == fresh["path"]), fresh)
        path = fresh["path"]
    elif options.get("operation") == "focus":
        path, old = window["path"], window
    else:
        reject("TARGET_REQUIRED", "Provide a fresh element_index, path or semantic target")
    if path[:len(window["path"])] != window["path"]:
        reject("TARGET_OUTSIDE_WINDOW", "Control is outside the observed window")
    element = ax._atspi_element_for_path(desktop, path)
    if element is None:
        reject("TARGET_NOT_FOUND", "Native control no longer exists")
    current = ax._atspi_node_metadata(Atspi, element, path=path, session=session)
    if not same_identity(old, current):
        reject("STALE_ELEMENT_IDENTITY", "The child path now names a different control; observe again")
    # Focus/selection may change during observation. Labels, content, value and geometry identify the target intent.
    for key in ("role", "name", "description", "text", "value", "bounds"):
        if old.get(key) != current.get(key):
            reject("STALE_ELEMENT_STATE", "Native control properties changed; observe again")
    if current.get("redacted"):
        reject("PROTECTED_CONTROL", "Protected fields require the existing secret/takeover flow")
    return element, current


def x11_window(node):
    if node.get("pid") is None:
        reject("WINDOW_PID_UNAVAILABLE", "Native foreground input requires a verified process ID")
    ids = command(["xdotool", "search", "--pid", str(node["pid"])]).splitlines()
    exact = [xid for xid in ids if command(["xdotool", "getwindowname", xid]) == node.get("name")]
    if len(exact) != 1:
        reject("X11_WINDOW_AMBIGUOUS", "Native window cannot be uniquely mapped to X11")
    return exact[0]


def verify_focus(root, window):
    root.clear_cache()
    states = ax._atspi_states(Atspi, root)
    xid = x11_window(window)
    if "active" not in states or active_xid() != int(xid):
        reject("TARGET_NOT_FOCUSED", "The requested window is not the verified active X11/AT-SPI window")
    return xid


def focus_element(element, path=None, window_path=None):
    """Grab focus and accept the target or a focused descendant under it.

    LibreOffice Writer often moves focus from document text onto a child paragraph.
    Fail closed if focus leaves the observed window or never appears under the target.
    """
    global EFFECT
    if "Component" not in element.get_interfaces():
        reject("FOCUS_UNAVAILABLE", "Control exposes no Component focus interface")
    EFFECT = True
    if not Atspi.Component.grab_focus(element):
        reject("FOCUS_UNVERIFIED", "Native control rejected focus")
    deadline = time.monotonic() + 0.8
    desktop = Atspi.get_desktop(0)
    while True:
        try:
            element.clear_cache()
        except Exception:
            pass
        if "focused" in ax._atspi_states(Atspi, element):
            return {"element": element, "path": path, "mode": "exact"}
        if path is not None:
            focused = ax._atspi_find_focused_under(Atspi, element, path, max_nodes=240)
            if focused is not None:
                focused_element, focused_path = focused
                if window_path is not None and focused_path[:len(window_path)] != window_path:
                    reject("FOCUS_UNVERIFIED", "Focus moved outside the observed window")
                if focused_path[:len(path)] != path:
                    reject("FOCUS_UNVERIFIED", "Focus moved outside the requested control")
                return {"element": focused_element, "path": focused_path, "mode": "descendant"}
        # Fail fast if some other window stole focus.
        if window_path is not None:
            global_focused = ax._atspi_find_focused(Atspi, desktop, max_nodes=320)
            if global_focused is not None and global_focused[1][:len(window_path)] != window_path:
                reject("FOCUS_UNVERIFIED", "Another window stole focus before typing")
        if time.monotonic() >= deadline:
            reject("FOCUS_UNVERIFIED", "Native control did not report focus")
        time.sleep(0.05)


def perform(request):
    global EFFECT
    state, options = request["state"], request["options"]
    session = SimpleNamespace(width=state["width"], height=state["height"])
    desktop = Atspi.get_desktop(0)
    root, window = guarded_window(request, desktop, session)
    operation = options.get("operation", "press")
    if options.get("action") in ("tag_context", "tag_replace"):
        return tag_operation(request, root, window, desktop, session)
    if options.get("action") == "type":
        # Keep the read budget alive for focus search, especially over summarized tables.
        ax.DEADLINE = time.monotonic() + 6
        focused = ax._atspi_find_focused(Atspi, desktop)
        if focused is None or focused[1][:len(window["path"])] != window["path"]:
            reject("FOCUS_UNVERIFIED", "No focused field was found in the target window")
        if ax.protected(focused[0]):
            reject("PROTECTED_CONTROL", "Protected fields require the existing secret/takeover flow")
        xid = verify_focus(root, window)
        focused_meta = ax._atspi_node_metadata(Atspi, focused[0], path=focused[1], session=session)
        # Typing time is input work, distinct from the bounded native-read budget.
        typing_timeout = 5 + len(options["text"]) * 0.02
        ax.DEADLINE = time.monotonic() + typing_timeout + 4
        EFFECT = True
        command(["xdotool", "type", "--clearmodifiers", "--delay", "8", "--file", "-"], options["text"], timeout=typing_timeout)
        verify_focus(root, window)
        # Ensure focus did not jump to another window mid-type.
        still = ax._atspi_find_focused(Atspi, desktop, max_nodes=320)
        if still is None or still[1][:len(window["path"])] != window["path"]:
            reject("FOCUS_UNVERIFIED", "Focus left the target window while typing")
        if options.get("submit"):
            command(["xdotool", "key", "--clearmodifiers", "Return"])
        return {"effect": "dispatched", "window_id": window["window_id"], "focus_verified": True,
                "submitted": options.get("submit", False), "input_scope": "verified_foreground_window",
                "focused_path": focused[1], "focused_role": focused_meta.get("role")}
    element, target = target_element(request, root, window, session)
    value_target, value_meta = element, target
    dispatch = options.get("dispatch", "background")
    if operation == "focus" or (operation == "set_value" and options.get("submit")):
        if dispatch == "background":
            return {"effect": "none", "background_unavailable": True, "reason": "This operation requires foreground focus",
                    "requested_dispatch": dispatch, "actual_dispatch": "none", "target": target}
    if "disabled" in target["states"]:
        reject("TARGET_DISABLED", "Native control is disabled")
    actual = "foreground" if dispatch == "foreground" or operation == "focus" or options.get("submit") else "background"
    if operation == "press":
        if target["role"] in ax._AT_SPI_WINDOW_ACTIVATION_ROLES:
            reject("WINDOW_ACTIVATION_REQUIRED", "Use foreground focus to activate a window")
        count = ax._safe_call(element, "get_n_actions") if "Action" in element.get_interfaces() else 0
        if count is None:
            reject("ACTION_READ_FAILED", "Native press actions could not be read before dispatch")
        names = []
        for i in range(count):
            name = ax._safe_call(element, "get_action_name", i)
            if name is None:
                reject("ACTION_READ_FAILED", "Native press action name could not be read before dispatch")
            names.append(name.casefold())
        requested = options.get("action_name")
        preferred = [requested.casefold()] if requested else ax._AT_SPI_PRESS_ACTION_NAMES
        chosen = next((names.index(name) for name in preferred if name in names), None)
        if chosen is None:
            if dispatch in ("background", "auto"):
                return {"effect": "none", "background_unavailable": True, "reason": "Control exposes no requested native press action",
                        "requested_dispatch": dispatch, "actual_dispatch": "none", "target": target}
            reject("ACTION_UNAVAILABLE", "Control exposes no native press action; use the current screenshot for coordinates")
    elif operation == "set_value":
        value = options.get("value", options.get("text"))
        interfaces = element.get_interfaces()
        if value is None:
            reject("VALUE_REQUIRED", "set_value requires value or text")
        setter = None
        prepared = None
        value_target = element
        value_meta = target
        if "EditableText" in interfaces and "editable" in target["states"]:
            setter, prepared = Atspi.EditableText.set_text_contents, str(value)
        elif "Value" in interfaces:
            try:
                prepared = float(value)
            except (TypeError, ValueError):
                reject("INVALID_NUMERIC_VALUE", "Numeric control requires a finite number")
            if not ax.math.isfinite(prepared):
                reject("INVALID_NUMERIC_VALUE", "Numeric control requires a finite number")
            setter = Atspi.Value.set_current_value
        elif "editable" in target["states"]:
            # Document containers (Writer) often mark editable without EditableText; resolve after focus.
            setter = "resolve_editable_descendant"
            prepared = str(value)
        else:
            return {"effect": "none", "background_unavailable": True, "reason": "Control has no supported native value setter",
                    "requested_dispatch": dispatch, "actual_dispatch": "none", "target": target}
    elif operation != "focus":
        reject("INVALID_OPERATION", "Native operation must be press, focus or set_value")
    focus_info = None
    if actual == "foreground":
        xid = x11_window(window)
        EFFECT = True
        command(["xdotool", "windowactivate", "--sync", xid])
        verify_focus(root, window)
    if operation == "focus":
        if target["role"] not in ax._AT_SPI_WINDOW_ACTIVATION_ROLES:
            focus_info = focus_element(element, path=target.get("path"), window_path=window["path"])
    elif operation == "press":
        EFFECT = True
        if not Atspi.Action.do_action(element, chosen):
            reject("ACTION_FAILED", "Native press did not return a successful dispatch")
    else:
        if options.get("submit") or setter == "resolve_editable_descendant":
            focus_info = focus_element(element, path=target.get("path"), window_path=window["path"])
            verify_focus(root, window)
            if setter == "resolve_editable_descendant":
                focused_element = focus_info["element"]
                focused_path = focus_info["path"] or target.get("path")
                if ax.protected(focused_element):
                    reject("PROTECTED_CONTROL", "Protected fields require the existing secret/takeover flow")
                if "EditableText" not in focused_element.get_interfaces():
                    return {"effect": "none", "background_unavailable": True,
                            "reason": "Focused descendant exposes no EditableText setter",
                            "requested_dispatch": dispatch, "actual_dispatch": "none", "target": target,
                            "focused_path": focused_path}
                value_target = focused_element
                value_meta = ax._atspi_node_metadata(Atspi, focused_element, path=focused_path, session=session)
                setter = Atspi.EditableText.set_text_contents
        EFFECT = True
        if not setter(value_target, prepared):
            reject("VALUE_DISPATCH_FAILED", "Native value assignment was rejected or is uncertain")
        if options.get("submit"):
            verify_focus(root, window)
            try:
                value_target.clear_cache()
            except Exception:
                pass
            focused_ok = "focused" in ax._atspi_states(Atspi, value_target)
            if not focused_ok and focus_info and focus_info.get("mode") == "descendant":
                # Writer-style containers: submit uses the focused descendant verified earlier.
                focused_ok = True
            if not focused_ok:
                reject("FOCUS_UNVERIFIED", "Value changed but submit was withheld because the field is not focused")
            command(["xdotool", "key", "--clearmodifiers", "Return"])
    result = {"effect": "dispatched", "operation": operation, "target": target, "window_id": window["window_id"],
              "requested_dispatch": dispatch, "actual_dispatch": actual,
              "foreground_fallback_used": dispatch == "auto" and actual == "foreground",
              "focus_verified": operation == "focus" or options.get("submit", False) or bool(focus_info),
              "submitted": options.get("submit", False)}
    if focus_info is not None:
        result["focus_mode"] = focus_info.get("mode")
        if focus_info.get("path") is not None:
            result["focused_path"] = focus_info["path"]
    if operation == "set_value" and value_meta is not target:
        result["value_target"] = {k: value_meta.get(k) for k in ("path", "role", "name", "states", "objectId") if k in value_meta}
    return result


def tag_operation(request, root, window, desktop, session):
    global EFFECT
    verify_focus(root, window)
    focused = ax._atspi_find_focused(Atspi, desktop)
    if focused is None or focused[1][:len(window["path"])] != window["path"]:
        reject("TAG_FOCUS_UNAVAILABLE", "No focused field exists in the observed window")
    element, path = focused
    if ax.protected(element):
        reject("PROTECTED_CONTROL", "Inline requests are unavailable in protected fields")
    options = request["options"]
    if options["action"] == "tag_context":
        start, end, original, query, profile, context = ax._parse_tag_invocation(Atspi, element)
        identity = ax.object_identity(element)
        editable = "editable" in ax._atspi_states(Atspi, element) and "EditableText" in element.get_interfaces()
        return {"query":query,"profile_override":profile,"focused_text":context,
                "tag_text":original,"app_name":ax._atspi_name(ax._atspi_element_for_path(desktop, path[:1])),
                "window_title":window.get("name", ""),"window_id":window["window_id"],"replace_supported":editable,
                "_tagTarget":{"window_id":window["window_id"],"objectId":identity,"path":path,
                              "window_title":window.get("name", ""),"start":start,"end":end,"original":original}}
    tag = options["tag"]
    if tag["path"] != path or tag["objectId"] != ax.object_identity(element):
        reject("TAG_TARGET_CHANGED", "The inline request field identity or focus changed")
    if tag["window_title"] != window.get("name", ""):
        reject("TAG_TARGET_CHANGED", "The tagged window title changed while the request was pending")
    if "editable" not in ax._atspi_states(Atspi, element) or "EditableText" not in element.get_interfaces():
        reject("TAG_REPLACE_UNAVAILABLE", "Focused field exposes no editable text interface")
    if ax._atspi_text_range(Atspi, element, tag["start"], tag["end"]) != tag["original"]:
        reject("TAG_RANGE_CHANGED", "The original inline request range changed")
    replacement = options["replacement"]
    initial_count = ax._atspi_text_count(Atspi, element)
    EFFECT = True
    if not Atspi.EditableText.delete_text(element, tag["start"], tag["end"]):
        reject("TAG_DELETE_UNCERTAIN", "Inline range deletion was rejected or is uncertain")
    if replacement and not Atspi.EditableText.insert_text(element, tag["start"], replacement, len(replacement.encode("utf-8"))):
        reject("TAG_INSERT_UNCERTAIN", "Range deletion occurred but replacement insertion is uncertain; inspect before continuing")
    actual = ax._atspi_text_range(Atspi, element, tag["start"], tag["start"] + len(replacement))
    count = ax._atspi_text_count(Atspi, element)
    if actual != replacement or count != initial_count - (tag["end"]-tag["start"]) + len(replacement):
        reject("TAG_VERIFICATION_FAILED", "Inline replacement did not match its exact content/length; inspect without repeating")
    return {"effect":"dispatched","replaced":True,"window_id":window["window_id"],"characters":len(replacement),"verification":"exact_text_range"}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    # Backward-compatible read-only caller during the migration; no action may use this path.
    if "state" not in request:
        request = {"state": request, "options": {"max_nodes": 500, "max_depth": 12, "max_elements": 60, "include_tree": False}}
    ax.DEADLINE = time.monotonic() + 4
    try:
        output = snapshot(request) if request.get("action", "snapshot") == "snapshot" else perform(request)
        output.setdefault("effect", "none")
    except (ax.PortalError, GLib.Error, RuntimeError, subprocess.TimeoutExpired) as error:
        output = {"error": str(error), "code": error.code if isinstance(error, ax.PortalError) else type(error).__name__,
                  "effect": "unknown" if EFFECT else "none"}
    print(json.dumps(output, ensure_ascii=True, allow_nan=False))
