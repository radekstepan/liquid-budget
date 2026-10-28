---
"@ynab/ui": patch
"@ynab/web": patch
---

## Remove Sankey how-to-read explainer (task-28)

The "How to read" hint text is gone from the Spending Sankey header, along
with its hover tooltip ("How to read this chart", income-flow / Remaining /
Over income / Other / investment / Uncategorized explainers). The header now
holds only the controls (dimension, view, sort, Under threshold).

Notes: the explainer was hover-only plain hint text — no toggle state,
handlers, props, or styles survived it, so removal is just the tooltip block
(all other header Tooltips stay). Bars view rendering is untouched.
ARCHITECTURE.md §5 drops the How-to-read sentence.
