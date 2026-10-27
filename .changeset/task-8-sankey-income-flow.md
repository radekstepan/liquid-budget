---
"@ynab/logic": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## Sankey income-flow with Total node (task-8)

The Spending report's Sankey diagram is now a three-column income→Total→spending
flow: income sources on the left flow into a central Total node, which then
flows out through one ribbon per group into labeled spending nodes on the right.

New report header shows **In / Out / Left** totals for the selected range, and
the flow always balances via plug nodes: unspent income lands in a **Remaining**
plug, and overspending beyond income is supplied by an **Overspent** plug, so
Total in always equals Total out.

Notes: income aggregation (`computeIncomeBreakdown`), column assignment
(`buildFlowColumns`), and the three-column SVG layout (`layoutIncomeSankey`)
are pure functions in `@ynab/logic` with unit tests, including readability
geometry constants (minimum ribbon widths, node spacing) so small flows stay
legible. Plug colors come from `chartUtils`, `ExpenseBreakdownReport` takes an
`income` prop, and `ReportsView` wires `computeIncomeBreakdown` into the
Spending report. Unit suites (`sankey`, `SpendingReport`, `ReportsView`,
`chartUtils`) and the e2e `reports` spec were updated for the income flow.

Known follow-ups (from review feedback, not in this commit): direct
income→expense links are wanted instead of routing everything through Total;
the "Under $X" slider should also merge small incomes; Overspent plug clarity
needs work; the legend can get cut off on narrow widths; transfer handling in
the flow needs a second look.

Verification: `yarn typecheck` (9/9) and `yarn test` (8/8) pass;
`yarn check:artifacts` is clean; `yarn e2e` could not run in the sandboxed
agent session (`listen EPERM` on port 3100, same diagnosis as task-2/task-7) —
run `yarn e2e` in a normal terminal to confirm the updated reports spec.
