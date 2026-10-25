---
"@ynab/ui": patch
---

## Fix Cash Flow bars vanishing on narrow month ranges (task-6)

Selecting a narrow range such as June–October 2026 on the Reports Cash Flow tab could render no visible bars (with no console errors), while widening the selection showed the same months fine. The Tukey outlier axis break placed the zero line with an inverted fraction, parking zero at the chart's top edge for all-surplus months and squeezing every bar into a 1px sliver. Zero-line placement now mirrors Spending Trends, giving each side vertical space proportional to its data extent, so bars keep full height whenever the break fires.

Notes: regression tests cover all-surplus + outlier, all-loss + outlier, and the exact reported Jun–Oct scenario at the ReportsView level (all failed pre-fix with 1px bars). Follow-up: `NetWorthReport.tsx` still uses the same inverted `fracZero` formula and can collapse the same way when an asset break fires on asymmetric data — left untouched as out of scope. `yarn build`, `yarn test`, and `yarn typecheck` pass; `yarn e2e` could not run in the sandboxed agent session (the sandbox denies `listen()`, so `next start` fails with `EPERM` on port 3100) and no e2e spec covers the Cash Flow tab — run `yarn e2e` in a normal terminal to confirm.
