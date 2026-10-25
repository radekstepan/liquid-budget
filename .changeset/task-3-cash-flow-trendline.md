---
"@ynab/logic": minor
"@ynab/ui": minor
---

## Rename Surplus report to Cash Flow, add toggleable trendline (task-3)

Reports' **Surplus** tab is now **Cash Flow** ("Monthly Cash Flow" panel
title). The old name was misleading: the chart shows monthly net cash flow,
which is a loss in months where outflow exceeds income. The new name matches
the Inspector, which already calls the same income-minus-outflow value "Net
Cash Flow". The green/red per-month Surplus/Loss labels are unchanged — they
describe each bar's sign, not the report.

The chart also gains an optional **trend line**, off by default and toggled
from the new Trend control in the chart header. It is an ordinary
least-squares linear regression over the visible monthly values (see
`computeTrendline` in `@ynab/logic`), drawn as a per-month polyline so it
stays correct under the Log scale and the Tukey-fence axis break; the line
is masked by the break band exactly like the bars. The toggle persists in
localStorage like the sibling report toggles, and is disabled with fewer
than 2 months of data (a line needs at least two points).

Notes: internal identifiers (`SurplusReport`, `SurplusMonthPoint`,
`computeMonthlySurplus`, the `"surplus"` tab key) are intentionally
unchanged. `yarn build`, `yarn test`, and `yarn typecheck` pass; `yarn e2e`
could not run in the sandboxed agent session (the sandbox denies `listen()`,
so `next start` fails with `EPERM`) and was waived for this change — run
`yarn e2e` in a normal terminal to confirm.
