---
"@ynab/ui": patch
---

## Cash Flow tooltip spacing, dots, and trendline markers (task-5)

The Cash Flow report's hover tooltip now separates the Income / Outflow rows
from the Surplus (or Loss) / Trend rows with a hairline divider and extra
spacing, so the two groups read as distinct sections. The colored dots were
removed from the Income and Outflow rows — only the Surplus/Loss and Trend
rows keep dots — while a transparent spacer preserves the text and amount
alignment across all rows. The trendline itself now renders a small dot per
month, matching the Net Worth line markers, so each fitted point is visible.

Notes: UI-only change in `SurplusReport` plus a shared `TipLabel` `dot`
opt-out in `chartUtils` (default keeps dots, so other reports are unchanged).
Covered by 4 new component tests (one trendline dot per month, divider
present, dot counts with the trendline on and off). `yarn build` and
`yarn typecheck` pass; all ui/logic/server tests pass. Two gates could not
go green in the sandboxed agent session, both verified unrelated to this
change: (1) `yarn e2e` is blocked — the sandbox denies `listen()`, so
`next start` fails with `EPERM` on port 3100 (same as task-4); run `yarn e2e`
in a normal terminal to confirm. (2) `apps/web` `BudgetAppShell.test.tsx`
BUG-15 tests intermittently exceed the 5s default timeout on this slow
machine — they fail identically on the untouched base (base source + base
dist) and all pass with `--testTimeout=60000`, so no regression from this
change.
