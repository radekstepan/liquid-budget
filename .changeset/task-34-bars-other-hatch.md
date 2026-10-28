---
"@ynab/ui": patch
---

## Bars Other buckets share the Sankey hatch (task-34)

In the Spending by Category Bars view, merged "Other" bucket bars now carry the same diagonal hatch the Sankey paints on its render-only rows, so computed rows read as computed in both views. Bars render no Remaining plug, so only rows with the explicit `bucket` flag qualify.

Notes: no lookalike — the Bars branch renders the identical `SankeyBucketHatchPattern` pattern def (same id, angles, spacing, colors) once in a zero-size out-of-flow SVG, and each bucket bar overlays a pointer-transparent SVG rect filled from it, clipped to the bar's rounded corners. The row hover highlight paints the row behind the bar, so the hatch reads in rest and hover alike. Non-bucket rows render byte-identical DOM (no overlay, no extra classes). Sankey, Bars colors (task-31), gapless stacking (task-32), and hover tooltips (task-33) untouched.
