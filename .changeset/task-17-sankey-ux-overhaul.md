---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey UX overhaul (task-17)

The Spending by Category chart is now self-explanatory: every column is
labeled (Income / Groups / Categories or Merchants), hovering any header
explains what that column holds, and a "How to read" button in the header
summarizes the whole chart — where income flows, what Remaining and Over
income mean, how investment transfers count, and what Uncategorized is.
Hover tooltips now work on node labels too, not just bars and ribbons.

The "Under" merge slider walks stepped stops instead of raw dollars: small
increments at the start ($10, $25, $50…) where rows are dense, larger jumps
later (thousands) where only the long tail is left, with the ceiling
covering the largest row (no more $2,000 cap — a $60k dataset gets $100k
stops). Previously saved dollar thresholds snap to their nearest stop.

Ribbons are now colored by their destination instead of their income
source: each flow takes the color of the node it runs into, so a ribbon
reads as its final category or merchant. Hovering an income on the left
spotlights its share of every downstream ribbon — all benefiting groups
and categories stay lit while the rest dims — and hovering any right-side
row still highlights its contributing incomes.

"Shortfall" is renamed to "Over income" (matching the header's "Over: $X"
readout), and its tooltips now state the total gap: "Spending exceeded
income by $550.00 — covered from savings or debt". Transfer money is
flagged on both sides: income tooltips note withdrawals from off-budget
accounts, spending tooltips note money moved out to them, and the
Uncategorized group explains itself as spending with no category set.

Notes: deliberately reverses task-15's income through-color decision (user
found income-colored ribbons confusing); the per-income sub-ribbon split is
kept for hover attribution. Report-side semantics only — the budget engine
is untouched. E2E `reports.spec.ts` updated for the stepped slider.
