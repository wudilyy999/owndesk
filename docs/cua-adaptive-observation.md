# Bounded multi-level native observations

A native observe is not a mandatory sequence of level-by-level reads. Small and moderate windows expose several levels with actionable paths in one call; ask for a subtree or table region only when needed detail was omitted.

## Defaults and bounds

- Semantic depth 8, 160 emitted nodes; callers may request depth 0–12 and 1–500 nodes.
- 64,000 serialized record characters (including table summaries/cell annotations); configurable 2,000–120,000. Tree and element views duplicate these records in the audit receipt. Model context separately remains bounded to 12,000 characters.
- At most four times the node allowance in visible visited nodes, 16 times the node allowance in child probes (including hidden nodes), 80 children per ordinary parent (configurable 4–120), absolute AT-SPI paths at most 40 components, and the existing four-second read deadline.
- Nameless, non-interactive single-child structural wrappers are traversed but not emitted and do not consume semantic depth. Actual AT-SPI paths are never rewritten. Protected, described, focusable, editable, selected or otherwise meaningful wrappers are retained.
- Tables expand normally only when their dimensions fit both 80 cells and the remaining node allowance. More than 256 advertised children, at least 500 rows, or larger tables use bounded focus/selection/region sampling. Calc virtual INT_MAX grids are never enumerated.
- `tableSummary`, `tableCell`, `omitReasons`, adaptive budget metadata and descendant/exact focus evidence survive the model-context projection. Omission always means partial, never proof of absence.
- `subtree_path`, `table_region`, `expand_tables` and explicit depth/node options remain available. Even explicit table expansion remains bounded.

## Compatibility and security

The response shape (`elements`, `tree`, ephemeral indices/paths, fresh observation binding) is unchanged. Cross-app workflow templates and demonstration teaching use the same controller observation contract; they do not assume fixed indices or a particular depth. Focus verification, window identity, freshness, one-input consumption and protected fields are unchanged. The focus finder retains PR #12's conservative 48-cell table threshold independently of adaptive observation.

`OWNDESK_TEST_IMAGE` lets runtime/Telegram suites exercise an isolated, exact workstation image without retagging the shared development image. It falls back to the image named by `workstation:build`.

## References and licensing

Design ideas only: [Playwright AI ARIA snapshots](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot) use scoped multi-level snapshots, depth limits and actionable references; [browser-use DOM serialization](https://deepwiki.com/browser-use/browser-use/5-dom-processing-engine) filters structural wrappers before assigning action indices. No third-party implementation was copied.
