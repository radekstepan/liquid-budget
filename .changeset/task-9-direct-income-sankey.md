---
"@ynab/logic": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## Direct income-to-expense Sankey without Total bar (task-9)

The Spending report's Sankey diagram no longer routes everything through a
middle "Total flow" bar. Ribbons now run directly from each income source on
the left to each spending group on the right, so every expense visibly draws
from the incomes that fund it. The In / Out / Left header summary is
unchanged.

Money is fungible, so the split is proportional: every expense draws from
every income source in proportion to that source's share of total income
(e.g. an income that is 80% of all income funds 80% of each expense). This
assumption is documented in `computeDirectFlowLinks` and surfaced in the
ribbon tooltip ("Proportional split — money is fungible").

Imbalance is handled honestly without inventing money:

- Income exceeds spending: the surplus lands in an unspent **Remaining**
  target on the right, fed proportionally like any other expense.
- Spending exceeds income: there is no phantom "Overspent" income source.
  Each expense bar is only partly funded (pro-rata at the uniform coverage
  ratio income/spending) and its shortfall renders as a distinct neutral
  **Unfunded** segment at the bar's bottom; hovering the bar explains that
  spending exceeded income and the gap was covered from savings or debt.
  "Unfunded" wording is provisional.

Notes: `computeDirectFlowLinks` (pure value model: proportional links,
per-source/per-target conservation, Remaining plug, per-target funded /
unfunded amounts) and `layoutDirectIncomeSankey` (two-column geometry: the
expense column owns the pixel scale, income bars wrap their bands, ribbons
have equal height at both ends) replace `buildFlowColumns` /
`layoutIncomeSankey`, which are removed along with `OVERSPENT_LABEL`.
Ribbons take their expense's color; `UNFUNDED_LABEL` / `UNFUNDED_COLOR` live
in `@ynab/logic` / `chartUtils` so views and tests agree. Unit suites
(`sankey`, `SpendingReport`, `ReportsView`, `chartUtils`) and the e2e
`reports` spec were updated for the direct layout.

Follow-ups left for later tasks: apply the "Under $X" slider to incomes;
refine the Unfunded/shortfall wording; fix the left legend cutoff on narrow
widths; rework transfer handling (flow-through instead of "Transfer", plus
the save-then-withdraw account question).

Verification: `yarn typecheck` (9/9) and `yarn test` (8/8, 2174 tests)
pass; `yarn check:artifacts` is clean. `yarn e2e` could not run in the
sandboxed agent session (`listen EPERM` on port 3100, same known blocker as
task-2/task-7/task-8) — run `yarn e2e` in a normal terminal to confirm the
updated reports spec.
