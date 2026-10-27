---
"@ynab/logic": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Under slider merges incomes, clearer shortfall wording (task-10)

The Spending report's "Under $X" slider now applies to both columns: small
income sources fold into an "Other" bucket on the left, mirroring the
expense-side merge. One shared threshold drives both sides, the slider
ceiling covers the largest group on either side, and the proportional
income→expense links run on the merged columns so flow is still conserved
(In / Out totals never change when merging).

The header "(N in Other)" note now counts merged groups on both sides, and
hovering the income Other bucket reads "N smaller incomes under $X". The
slider's accessible label is "Merge smaller groups under threshold"
(previously expenses-only).

The shortfall segment shown when spending exceeds income is renamed from
"Unfunded" to "Shortfall": it names the gap (spent more than earned, the
difference covered from savings or debt) without implying new income. The
tooltip keeps the explanatory line and the neutral gray color; no phantom
income source was reintroduced.

Notes: `SHORTFALL_LABEL` / `SHORTFALL_COLOR` replace `UNFUNDED_LABEL` /
`UNFUNDED_COLOR` in `@ynab/logic` / `chartUtils` (the internal
`unfunded`/`unfundedValue` model fields are unchanged); the
`sankey-unfunded` test id is now `sankey-shortfall`. Unit suites (`sankey`,
`SpendingReport`, `ReportsView`, `chartUtils`) cover merged-income
conservation, Other-bucket income links, combined header counts, and the new
wording; the e2e `reports` spec's slider selector was updated for the new
label.

Follow-ups left for later tasks: fix the left legend cutoff on narrow
widths; rework transfer handling (flow-through instead of "Transfer", plus
the save-then-withdraw account question).

Verification: `yarn typecheck` (9/9) and `yarn test` (8/8, 2180 tests)
pass; `yarn check:artifacts` is clean. `yarn e2e` could not run in the
sandboxed agent session (`listen EPERM` on port 3100, same known blocker as
task-2/task-7/task-8/task-9) — run `yarn e2e` in a normal terminal to
confirm the updated reports spec.
