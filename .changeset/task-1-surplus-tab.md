---
"@ynab/logic": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## Monthly surplus/loss report tab (task-1)

Reports has a new **Surplus** tab, immediately to the right of Net Worth. It
charts monthly surplus (income minus outflow) as green bars above the zero
line and monthly loss as red bars below it, with hover tooltips showing
income / outflow / surplus per month, an average line, and a Linear/Log
scale toggle shared with the other reports.

Surplus reuses the existing cash-flow semantics (split parents, off-budget
activity, and internal transfers excluded), and extreme months are capped
with the same Tukey-fence axis-break mechanism as Spending Trends, so one
huge month can't squash the rest of the chart.

Notes: also fixed pre-existing type errors in
`apps/web/tests/e2e/transactions-merge.spec.ts`, which used Testing Library
queries (`getByDisplayValue`, `Locator.getByPlaceholderText`) that don't
exist in Playwright — replaced with `getByLabel` + `toHaveValue` /
`getByPlaceholder`. `yarn build`, `yarn test`, and `yarn typecheck` pass;
`yarn e2e` could not run in the sandboxed agent session (the sandbox denies
`listen()`, so `next start` fails with `EPERM`) and was waived for this
commit — run `yarn e2e` in a normal terminal to confirm.
