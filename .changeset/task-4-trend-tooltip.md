---
"@ynab/ui": patch
---

## Show trendline value in Cash Flow hover tooltip (task-4)

When the Cash Flow report's Trend toggle is on, hovering a month now shows
that month's fitted trend amount in the tooltip, alongside the existing
Income / Outflow / Surplus (or Loss) rows. The Trend row uses the same
currency formatting and the trend line's color, so the tooltip matches what
the chart draws. When the toggle is off — or with fewer than 2 months, where
no fit exists — the tooltip is unchanged.

Notes: tooltip-only change in `SurplusReport`; no logic, server, or API
impact. Covered by 3 new component tests (trend row present when on, absent
when off, per-month fitted value). `yarn build`, `yarn test`, and
`yarn typecheck` pass; `yarn e2e` could not run in the sandboxed agent
session (the sandbox denies `listen()`, so `next start` fails with `EPERM`)
and was waived for this change — run `yarn e2e` in a normal terminal to
confirm.
