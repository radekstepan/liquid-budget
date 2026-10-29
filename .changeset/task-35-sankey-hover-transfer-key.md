---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey hover, transfer, and key fixes (task-35)

Three Spending by Category Sankey issues fixed:

- Hovering a right-column category or merchant now spotlights its full ribbon
  path, including ribbons arriving from non-dominant parent groups. Each target
  also keeps its own stable color on every leg — the category determines the
  color and it flows backwards, no matter which parent group a ribbon comes
  from; the parent group never tints it.
- Internal on-budget transfers (for example round-trips through an on-budget
  savings account) no longer show as spending. Each transfer leg names the
  other account, so the two sides could never net under one payee and the
  gross inflow piled up as a giant "Transfer: <account>" merchant. Both legs
  are movement now, matching the cash-flow report's boundary semantics — only
  money that actually leaves the budget counts, and the terminal purchase
  (wherever its account sits) is the one spending record.
- The Bars view no longer logs a duplicate React key warning when a literal
  "Other" row sits beside the merged "Other" bucket; rows are keyed by
  position, so both render.

Notes: categorized internal transfers no longer count as category spending
(this reverses the old legacy behavior the previous test pinned). Sankey
target bars now use the same stable per-name colors as the Bars rows instead
of darkened parent-group family shades.
