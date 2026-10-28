---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Spending Sankey fixes (task-20)

The Spending by Category Sankey draws one ribbon per group-to-category
cell now — the per-income subdivision that split every cell into visible
horizontal lines is gone from the layout, so hovering a parent group bar
spotlights every line leading into and out of it in full, whole ribbons.

Hover feedback is a real spotlight: the hovered path's ribbons brighten
and render above the other legs while everything outside the path dims.
Income bars on the left are one neutral gray with no series colors, and
parent group bars share their ribbons' exact color with no brighter
highlight variant.

The grey shortfall segments are removed from every bar — when spending
exceeds income the gap shows in tooltips and the header instead, since
every bar shares the same unfunded fraction. Render-only rows are now
visually distinct: the Under-threshold Other buckets and the Remaining
surplus plug carry a dashed border plus hatch, and their tooltips say
outright that they are computed rows, not real categories or merchants.

Notes: `yarn build`, `yarn test`, and `yarn typecheck` pass; `yarn e2e`
could not fully run in the sandboxed agent session (the sandboxed
Chromium headless shell SIGSEGVs at `browserType.launch`, the known
environment block in `AGENTS.md`) — run `yarn e2e` in a normal terminal
to confirm.
