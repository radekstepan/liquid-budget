---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey income attribution respects timelines (task-47)

Story: hovering a merchant in the Spending Sankey could spotlight income
that could never have funded it — e.g. merchant "Realstar" (rent paid
2020+, group Needs) highlighted income "Redman Technology" (payroll
received 2014–2015 and fully spent by early 2016). The left hop spread
every income across the whole report range, ignoring time. Spending cells
are now funded chronologically: each month's income joins a per-source
pool that funds that month's and later cell demands (unfunded demands wait
as backlog for later income), so a fully-spent early income never funds
late spending — while genuine savings still carry forward and arrears
still resolve. Hovering a merchant (or category) now spotlights only the
income slices that actually fund it; an income bar lights only when one
of its slices into the hovered target lights.

Notes: root cause was the report-wide fungible pro-rata cross-product in
`computeDirectFlowLinks`/`layoutGroupedIncomeSankey` (task-46 only fixed
the colors on top of it). Cell-level — not group-level — attribution was
required, because Realstar's group Needs spans both eras: group-level
time-awareness cannot sever the link. New logic API:
`computeMonthlySankeySeries` (per-month income/cell series, same row
semantics as the range flows via shared collectors),
`allocateCellFunding` (pool+backlog chronological funding with
conservation pins and float-dust pruning below 1e-6 cents),
`computeSankeyViewModel` (merge+sort identical to the Bars path plus the
funding, carried across sorts by endpoint identity). The layout accepts
explicit funding via `opts.leftHop` (bands aggregate it, sub-ribbons draw
it slice-for-slice with no taper); without it the legacy proportional
path is byte-identical (Categories golden snapshot still passes
unchanged). Refund TIMING is washed out of the monthly shape (refunds net
at range level; surviving spending keeps its months). Two ReportsView
tests pinning the old full-cross-product ribbon counts were updated to
the time-aware counts (June Bonus no longer slices April Rent) — the
expectations encoded the bug, not a regression. Verified on the real dev
database: Redman Technology funds $51,649.10 across era-appropriate
targets and exactly $0.00 to Realstar, with funding+surplus equal to
income to the cent.

Verification: `yarn test` (logic 812, server 647, ui 780 pass; web has
only the known timing-sensitive BUG-15 shell test, green on rerun with
`--testTimeout=60000` per TESTING.md) and `yarn typecheck` (9/9) pass;
`yarn check:artifacts` is clean. `yarn e2e` is environment-blocked in
this session (documented Chromium SIGSEGV at `browserType.launch` — all
150 browser specs fail identically at launch, all 37 API specs pass) —
confirm `yarn e2e` in a normal terminal.
