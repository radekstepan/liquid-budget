---
"@ynab/ui": patch
---

## Sankey hover node/bar size mismatch (task-24)

Hovering a category/merchant bar no longer makes it look ~1px bigger than the ribbon stack feeding it. The bar kept a same-color 2px SVG stroke on hover, and SVG strokes center on the shape edge — half the stroke painted outside the bar bounds. The stroke is gone; the existing spotlight brightness (shared with the bar's ribbons) now carries the hover highlight alone, so the bar matches its incoming ribbons exactly in rest and hover states.

Notes: removes the `SANKEY_NODE_HOVER_STROKE_OPACITY` export and the `isTgtHover` helper from `SpendingReport.tsx`. Two component tests that pinned the old hover-stroke behavior were rewritten to the new contract (strokeless, pixel-identical geometry, brightness-only highlight) — the old expectations encoded the bug, not a regression guard.
