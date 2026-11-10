"""Unit tests for table summarization and descendant focus helpers (no live AT-SPI)."""
from __future__ import annotations
import time
import types
import unittest
from unittest import mock

import atspi_core as ax


class FakeStateSet:
    def __init__(self, states):
        self._states = set(states)

    def contains(self, value):
        return value in self._states


class FakeElement:
    def __init__(self, role, *, name="", states=None, children=None, interfaces=None, text="", value=None, rows=None, cols=None):
        self._role = role
        self._name = name
        self._states = list(states or ["enabled", "showing", "visible"])
        self._children = list(children or [])
        self._interfaces = list(interfaces or ["Accessible", "Component"])
        self._text = text
        self._value = value
        self._rows = rows
        self._cols = cols
        self.app = types.SimpleNamespace(bus_name=":1.0")
        self.path = f"/fake/{id(self)}"

    def get_interfaces(self):
        return list(self._interfaces)

    def get_child_count(self):
        if self._rows is not None and self._cols is not None:
            # Spreadsheet-scale → virtual INT_MAX; small dims use real children when present.
            if self._rows >= 500 or self._rows * self._cols > 10_000:
                return 2147483647
            if self._children:
                return len(self._children)
            return int(self._rows) * int(self._cols)
        return len(self._children)

    def get_child_at_index(self, index):
        if self._rows is not None and not self._children:
            # Virtual grid not child-indexed in this fake.
            return None
        if 0 <= index < len(self._children):
            return self._children[index]
        return None

    def get_role_name(self):
        return self._role

    def get_role(self):
        return self._role

    def get_name(self):
        return self._name

    def get_description(self):
        return ""

    def get_process_id(self):
        return 42

    def get_state_set(self):
        # Map display names back through Atspi.StateType attrs used by _atspi_states.
        mapping = {
            "ACTIVE": "active",
            "CHECKED": "checked",
            "EDITABLE": "editable",
            "ENABLED": "enabled",
            "EXPANDED": "expanded",
            "FOCUSED": "focused",
            "FOCUSABLE": "focusable",
            "PRESSED": "pressed",
            "PROTECTED": "protected",
            "SELECTED": "selected",
            "SHOWING": "showing",
            "VISIBLE": "visible",
            "SENSITIVE": "sensitive",
            "READ_ONLY": "read_only",
            "REQUIRED": "required",
            "DEFUNCT": "defunct",
        }
        # _atspi_states looks up StateType.FOCUSED etc. We'll patch StateType to use strings.
        return FakeStateSet(set(self._states))

    def get_n_actions(self):
        return 0

    def get_character_count(self):
        return len(self._text)

    def get_text(self, start, end):
        return self._text[start:end]

    def get_caret_offset(self):
        return 0 if self._text else -1

    def get_current_value(self):
        return self._value

    def get_extents(self, *_args):
        return types.SimpleNamespace(x=0, y=0, width=10, height=10)

    def clear_cache(self):
        return None


class FakeTable:
    @staticmethod
    def get_n_rows(element):
        return element._rows

    @staticmethod
    def get_n_columns(element):
        return element._cols

    @staticmethod
    def get_selected_rows(element):
        return []

    @staticmethod
    def get_selected_columns(element):
        return []

    @staticmethod
    def get_accessible_at(element, row, col):
        if row == 0 and col == 0:
            return FakeElement(
                "table cell",
                name="A1",
                states=["editable", "enabled", "focused", "focusable", "showing", "visible"],
                interfaces=["Accessible", "Component", "Text", "Value", "TableCell"],
                value=1,
            )
        if row == 0 and col == 1:
            return FakeElement(
                "table cell",
                name="B1",
                states=["editable", "enabled", "focusable", "showing", "visible"],
                interfaces=["Accessible", "Component", "Text", "Value", "TableCell"],
                value=2,
            )
        return FakeElement(
            "table cell",
            name=f"R{row}C{col}",
            states=["editable", "enabled", "showing", "visible"],
            interfaces=["Accessible", "Component", "TableCell"],
        )

    @staticmethod
    def get_index_at(element, row, col):
        return row * element._cols + col


class FakeAtspi:
    Table = FakeTable
    class Role:
        PASSWORD_TEXT = "password text"
    class StateType:
        ACTIVE = "active"
        CHECKED = "checked"
        EDITABLE = "editable"
        ENABLED = "enabled"
        EXPANDED = "expanded"
        FOCUSED = "focused"
        FOCUSABLE = "focusable"
        PRESSED = "pressed"
        PROTECTED = "protected"
        SELECTED = "selected"
        SHOWING = "showing"
        VISIBLE = "visible"
        SENSITIVE = "sensitive"
        READ_ONLY = "read_only"
        REQUIRED = "required"
        DEFUNCT = "defunct"

    class CoordType:
        SCREEN = 0

    class Action:
        @staticmethod
        def get_n_actions(element):
            return 0

        @staticmethod
        def get_action_name(element, index):
            return ""

        @staticmethod
        def get_action_description(element, index):
            return ""

        @staticmethod
        def get_key_binding(element, index):
            return ""

    class Component:
        @staticmethod
        def grab_focus(element):
            return True

        @staticmethod
        def get_extents(element, *_a):
            return element.get_extents()

    class Text:
        @staticmethod
        def get_character_count(element):
            return element.get_character_count()

        @staticmethod
        def get_text(element, start, end):
            return element.get_text(start, end)

        @staticmethod
        def get_caret_offset(element):
            return element.get_caret_offset()

    class Value:
        @staticmethod
        def get_current_value(element):
            return element.get_current_value()

        @staticmethod
        def set_current_value(element, value):
            element._value = value
            return True

    class EditableText:
        @staticmethod
        def set_text_contents(element, value):
            element._text = value
            return True


class TreeFilterTests(unittest.TestCase):
    def setUp(self):
        ax.READ_ERRORS.clear()
        ax.DEADLINE = time.monotonic() + 5
        self.session = types.SimpleNamespace(width=1280, height=800)

    def test_massive_table_is_summarized_not_fully_expanded(self):
        import accessibility as acc

        table = FakeElement(
            "table",
            name="Sheet1",
            states=["editable", "enabled", "focused", "focusable", "showing", "visible"],
            interfaces=["Accessible", "Component", "Selection", "Table"],
            rows=1_048_576,
            cols=16_384,
        )
        toolbar = FakeElement("button", name="Save", states=["enabled", "showing", "visible", "sensitive"], interfaces=["Accessible", "Component"])
        root = FakeElement("frame", name="Calc", states=["active", "enabled", "showing", "visible"], children=[toolbar, table])

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi):
            # Patch _atspi_states to use our FakeStateSet directly with display names.
            def fake_states(_Atspi, element):
                return list(element._states)

            with mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
                tree, flat, truncated, omit_reasons, visits = acc.serialize(
                    root, [0], self.session, {"max_nodes": 40, "max_depth": 5}
                )

        self.assertTrue(truncated)
        self.assertLess(visits["nodes"], 80)
        self.assertLess(len(flat), 40)
        roles = [n["role"] for n in flat]
        self.assertIn("button", roles)
        self.assertIn("table", roles)
        self.assertIn("table cell", roles)
        table_nodes = [n for n in flat if n["role"] == "table"]
        self.assertEqual(len(table_nodes), 1)
        summary = table_nodes[0]["tableSummary"]
        self.assertEqual(summary["nRows"], 1_048_576)
        self.assertEqual(summary["nCols"], 16_384)
        self.assertGreater(summary["omittedCells"], 1000)
        cells = [n for n in flat if n["role"] == "table cell"]
        self.assertTrue(any(c.get("name") == "A1" for c in cells))
        self.assertTrue(any("table_summarized" in r["reason"] for r in omit_reasons))
        # Payload bound: serialized JSON should stay compact vs dumping millions of cells.
        import json
        payload = json.dumps({"elements": flat, "omitReasons": omit_reasons})
        self.assertLess(len(payload), 50_000)

    def test_descendant_focus_helper_finds_nested_paragraph(self):
        paragraph = FakeElement(
            "paragraph",
            states=["editable", "enabled", "focused", "focusable", "showing", "visible"],
            interfaces=["Accessible", "Component", "EditableText", "Text"],
            text="hello",
        )
        document = FakeElement(
            "document text",
            name="Doc",
            states=["editable", "enabled", "showing", "visible"],
            interfaces=["Accessible", "Component", "Selection"],
            children=[paragraph],
        )

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(ax, "_atspi_states", side_effect=fake_states), mock.patch.object(ax, "Atspi", FakeAtspi):
            found = ax._atspi_find_focused_under(FakeAtspi, document, [0, 1], max_nodes=50)
        self.assertIsNotNone(found)
        self.assertEqual(found[1], [0, 1, 0])
        self.assertIs(found[0], paragraph)



    def test_focus_helper_ignores_focus_outside_subtree(self):
        """Focused node outside the requested subtree must not count as success."""
        other = FakeElement(
            "paragraph",
            states=["editable", "enabled", "focused", "focusable", "showing", "visible"],
            interfaces=["Accessible", "Component", "EditableText", "Text"],
            text="elsewhere",
        )
        document = FakeElement(
            "document text",
            name="Doc",
            states=["editable", "enabled", "showing", "visible"],
            interfaces=["Accessible", "Component", "Selection"],
            children=[],
        )
        # sibling tree has the actual focus
        frame = FakeElement("frame", name="Win", states=["active", "enabled", "showing", "visible"], children=[document, other])

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(ax, "_atspi_states", side_effect=fake_states), mock.patch.object(ax, "Atspi", FakeAtspi):
            found = ax._atspi_find_focused_under(FakeAtspi, document, [0, 0], max_nodes=50)
        self.assertIsNone(found)

    def test_table_summary_keeps_non_table_controls(self):
        import accessibility as acc
        import json

        table = FakeElement(
            "table",
            name="Sheet1",
            states=["editable", "enabled", "focused", "focusable", "showing", "visible"],
            interfaces=["Accessible", "Component", "Selection", "Table"],
            rows=5000,
            cols=5000,
        )
        status = FakeElement("status bar", name="Ready", states=["enabled", "showing", "visible"], interfaces=["Accessible", "Component"])
        save = FakeElement("button", name="Save", states=["enabled", "showing", "visible", "sensitive"], interfaces=["Accessible", "Component"])
        root = FakeElement("frame", name="Calc", states=["active", "enabled", "showing", "visible"], children=[save, status, table])

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
            _tree, flat, truncated, omit_reasons, visits = acc.serialize(
                root, [0], self.session, {"max_nodes": 30, "max_depth": 5}
            )
        roles = {n["role"] for n in flat}
        self.assertIn("button", roles)
        self.assertIn("status bar", roles)
        self.assertIn("table", roles)
        self.assertTrue(truncated)
        self.assertLess(len(json.dumps(flat)), 40_000)
        self.assertTrue(any(r["reason"] == "table_summarized" for r in omit_reasons))
        self.assertLess(visits["nodes"], 80)


    def test_small_deep_dialog_exposes_target_in_one_observe(self):
        """Wrappers + depth: OK button appears in one serialize without subtree drill."""
        import accessibility as acc
        import json

        ok = FakeElement(
            "push button",
            name="OK",
            states=["enabled", "showing", "visible", "sensitive"],
            interfaces=["Accessible", "Component", "Action"],
        )
        # Deep nameless wrapper chain (should be compacted)
        inner = FakeElement("panel", states=["enabled", "showing", "visible"], children=[ok])
        mid = FakeElement("scroll pane", states=["enabled", "showing", "visible"], children=[inner])
        outer = FakeElement("filler", states=["enabled", "showing", "visible"], children=[mid])
        dialog = FakeElement(
            "dialog",
            name="Confirm",
            states=["active", "enabled", "showing", "visible"],
            children=[outer],
        )
        # Extra nesting under frame
        layer = FakeElement("layered pane", states=["enabled", "showing", "visible"], children=[dialog])
        root = FakeElement("frame", name="App", states=["active", "enabled", "showing", "visible"], children=[layer])

        def fake_states(_Atspi, element):
            return list(element._states)

        # Give Action interface a press name for realism
        ok.get_n_actions = lambda: 1
        ok.get_action_name = lambda i: "click"

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
            _tree, flat, truncated, omit_reasons, visits = acc.serialize(
                root, [0], self.session, {"max_nodes": 40, "max_depth": 8, "compact_structure": True}
            )
        names = [n.get("name") for n in flat]
        self.assertIn("OK", names, msg=f"flat names={names} visits={visits}")
        ok_nodes = [n for n in flat if n.get("name") == "OK"]
        self.assertTrue(ok_nodes[0].get("path"), "actionable path must remain valid")
        self.assertGreaterEqual(visits.get("skipped_wrappers", 0), 1)
        self.assertLess(len(json.dumps(flat)), 20_000)
        # No forced drill: one observe suffices
        self.assertFalse(any(r["reason"] == "max_depth" and "OK" in str(r) for r in omit_reasons))

    def test_small_table_expands_cells_directly(self):
        import accessibility as acc
        import json

        cells = []
        for r in range(3):
            for c in range(4):
                cells.append(
                    FakeElement(
                        "table cell",
                        name=f"R{r}C{c}",
                        states=["enabled", "showing", "visible"],
                        interfaces=["Accessible", "Component", "Text"],
                        text=f"{r},{c}",
                    )
                )
        table = FakeElement(
            "table",
            name="Tiny",
            states=["enabled", "showing", "visible"],
            interfaces=["Accessible", "Component", "Selection", "Table"],
            rows=3,
            cols=4,
            children=cells,
        )
        root = FakeElement("frame", name="Win", states=["active", "enabled", "showing", "visible"], children=[table])

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
            _tree, flat, truncated, omit_reasons, visits = acc.serialize(
                root, [0], self.session, {"max_nodes": 40, "max_depth": 8}
            )
        self.assertFalse(any(r["reason"] == "table_summarized" for r in omit_reasons), omit_reasons)
        cell_names = [n.get("name") for n in flat if n.get("role") == "table cell"]
        self.assertIn("R0C0", cell_names)
        self.assertIn("R2C3", cell_names)
        self.assertGreaterEqual(len(cell_names), 12)
        self.assertLess(len(json.dumps(flat)), 40_000)

    def test_large_non_table_list_is_child_capped(self):
        import accessibility as acc
        import json

        items = [
            FakeElement("list item", name=f"Item {i}", states=["enabled", "showing", "visible"])
            for i in range(200)
        ]
        listing = FakeElement("list", name="BigList", states=["enabled", "showing", "visible"], children=items)
        root = FakeElement("frame", name="Win", states=["active", "enabled", "showing", "visible"], children=[listing])

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
            _tree, flat, truncated, omit_reasons, visits = acc.serialize(
                root, [0], self.session, {"max_nodes": 80, "max_depth": 8, "child_expand_cap": 40}
            )
        self.assertTrue(truncated)
        self.assertTrue(any(r["reason"] == "child_cap" for r in omit_reasons), omit_reasons)
        item_nodes = [n for n in flat if n.get("role") == "list item"]
        self.assertLessEqual(len(item_nodes), 40)
        self.assertLess(len(json.dumps(flat)), 50_000)
        self.assertLessEqual(visits["nodes"], 90)

    def test_requested_depth_reported_in_visits(self):
        import accessibility as acc

        leaf = FakeElement("label", name="Hi", states=["enabled", "showing", "visible"])
        root = FakeElement("frame", name="Win", states=["active", "enabled", "showing", "visible"], children=[leaf])

        def fake_states(_Atspi, element):
            return list(element._states)

        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=fake_states):
            _tree, flat, truncated, omit_reasons, visits = acc.serialize(
                root, [0], self.session, {"max_nodes": 20, "max_depth": 8}
            )
        self.assertEqual(visits["requested_depth"], 8)
        self.assertEqual(visits["requested_nodes"], 20)


    def serialize_fake(self, root, **options):
        import accessibility as acc
        with mock.patch.object(acc, "Atspi", FakeAtspi), mock.patch.object(ax, "Atspi", FakeAtspi), mock.patch.object(ax, "_atspi_states", side_effect=lambda _, e: list(e._states)):
            return acc.serialize(root, [0], self.session, options)

    def test_small_table_summarized_when_remaining_budget_too_small(self):
        table = FakeElement("table", rows=5, cols=10, interfaces=["Accessible", "Table"])
        self.assertFalse(ax._atspi_table_should_summarize(FakeAtspi, table, remaining_nodes=80))
        self.assertTrue(ax._atspi_table_should_summarize(FakeAtspi, table, remaining_nodes=20))
        self.assertTrue(ax._atspi_table_should_summarize(FakeAtspi, table), "focus search retains conservative PR12 threshold")

    def test_protected_and_meaningful_wrappers_never_compacted(self):
        for extra in [{"redacted": True}, {"description": "Meaning"}, {"states": ["focusable"]}]:
            record = {"role": "panel", "states": [], **extra}
            self.assertFalse(ax._atspi_is_redundant_structure(record, 1))

    def test_compacted_chain_has_hard_path_limit(self):
        leaf = FakeElement("push button", name="Deep")
        for _ in range(120):
            leaf = FakeElement("panel", children=[leaf])
        root = FakeElement("frame", children=[leaf])
        _, flat, truncated, reasons, visits = self.serialize_fake(root)
        self.assertTrue(truncated)
        self.assertTrue(any(r["reason"] == "traversal_budget" for r in reasons))
        self.assertLess(visits["nodes"], 50)
        self.assertTrue(all(len(n["path"]) <= 40 for n in flat))

    def test_character_budget_omits_oversized_record_but_keeps_later_button(self):
        from unittest import mock
        import accessibility as acc
        original = ax._atspi_node_metadata
        def metadata(*args, **kwargs):
            record = original(*args, **kwargs)
            if record.get("name") == "Oversized":
                record["text"] = "x" * 10000
            return record
        root = FakeElement("frame", children=[FakeElement("label", name="Oversized"), FakeElement("push button", name="Save")])
        with mock.patch.object(ax, "_atspi_node_metadata", side_effect=metadata):
            _, flat, truncated, reasons, visits = self.serialize_fake(root, max_chars=2000)
        self.assertTrue(truncated)
        self.assertTrue(any(r["reason"] == "char_budget" for r in reasons))
        self.assertIn("Save", [n.get("name") for n in flat])
        self.assertLessEqual(visits["record_chars"], 2000)
        self.assertEqual([n["element_index"] for n in flat], list(range(len(flat))))

    def test_depth_zero_does_not_traverse_wrapper(self):
        root = FakeElement("frame", children=[FakeElement("panel", children=[FakeElement("push button", name="Save")])])
        _, flat, truncated, reasons, visits = self.serialize_fake(root, max_depth=0)
        self.assertEqual(len(flat), 1)
        self.assertTrue(truncated)
        self.assertEqual(visits["nodes"], 1)

    def test_default_depth_reduces_observes_for_small_named_tree(self):
        root = FakeElement("push button", name="Save")
        for i in range(7):
            root = FakeElement("panel", name=f"Section {i}", children=[root])
        _, before, _, _, _ = self.serialize_fake(root, max_depth=5, max_nodes=120, compact_structure=False)
        _, after, truncated, _, _ = self.serialize_fake(root)
        self.assertNotIn("Save", [n.get("name") for n in before])
        self.assertIn("Save", [n.get("name") for n in after])
        self.assertFalse(truncated)

    def test_hidden_menus_do_not_starve_visible_document(self):
        menus = [FakeElement("menu", name=f"Menu{i}", children=[FakeElement("menu item", name="Hidden", states=["enabled"]) for _ in range(70)]) for i in range(10)]
        root = FakeElement("frame", children=[*menus, FakeElement("push button", name="Document")])
        _, flat, truncated, _, visits = self.serialize_fake(root)
        self.assertIn("Document", [n.get("name") for n in flat])
        self.assertFalse(truncated)
        self.assertLess(visits["nodes"], 20)
        self.assertLessEqual(visits["child_probes"], 2560)


if __name__ == "__main__":
    unittest.main()
