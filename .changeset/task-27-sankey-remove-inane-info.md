---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Remove inane Sankey info lines (task-27)

Sankey tooltips and the header readout now carry only factual data (names,
amounts, pure-data percentages). Removed the "The merchant's exact share in
this group" / "Rolls up into its group — no splitting" ribbon lines, the
"Spending exceeded income by … — covered from savings or debt" lines (group,
target, and header tooltips), the "Includes money moved …" / "Includes
withdrawals …" lines, the "Render-only …" explainer lines, and the column-
header hover explainers (headers are plain labels now; the Left/Over header
readout keeps its factual amount with no tooltip).

Notes: the vestigial `transfer` item flag is gone from the Sankey types,
merging, and layout (flow-through attribution never sets it). The "Over
income" amount lines stay — they are data, not editorializing. Bars view and
the "How to read" explainer are untouched (sibling task owns the latter).
