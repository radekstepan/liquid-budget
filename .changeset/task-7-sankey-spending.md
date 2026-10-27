---
"@ynab/logic": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## Sankey spending flow report (task-7)

The Spending by Category donut chart is now a Sankey flow diagram: a Total
source node on the left flows through one ribbon per group into labeled
target nodes on the right, with hover tooltips showing the amount, share of
total, and (for the merged bucket) how many smaller groups it contains.

New controls in the report header:

- **Categories / Merchants toggle** — group outflows by category or by
  merchant (payee). Merchant mode includes uncategorized rows but still
  excludes income payees.
- **"Under $X" slider** — merges every group below the threshold into a
  single trailing "Other" bucket in both Sankey and Bars views. The total
  never changes when merging.
- **Sankey / Bars toggle** — replaces the old Bars / Donut toggle; Sankey
  is the new default. Stored legacy `donut` view preferences fall back to
  Sankey.

Notes: aggregation (`computeSpendingBreakdown`), threshold merging
(`mergeBelowThreshold`), and the dependency-free SVG layout (`layoutSankey`)
are pure functions in `@ynab/logic` with unit tests; colors are stable per
name via a palette hash (`colorForName`) with slate reserved for Other, and
tooltips reuse the viewport-clamped `ChartTip`. The e2e `reports` spec and
the `SpendingReport` / `ReportsView` suites were updated for the new views
(the old donut-arc assertions are gone with the donut).

Verification: `yarn build`, `yarn test` (8/8), and `yarn typecheck` (9/9)
pass; `yarn e2e` could not run in the sandboxed agent session (`listen
EPERM` on port 3100, same diagnosis as task-2) — run `yarn e2e` in a
normal terminal to confirm the rewritten reports spec (Sankey default,
view/dimension toggles, slider merge).
