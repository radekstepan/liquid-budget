---
"@ynab/logic": minor
"@ynab/ui": minor
---

## Spending by Category shows still-held accounts as chart rows (task-49)

Story: the Still-held strip answered "how much is parked?" but not "where
did it come from?" — each off-budget account now draws as a first-class
row in the Spending report itself, in both Sankey and Bars and in both
Categories and Merchants dimensions. A Wealthsimple RRSP that still holds
$400 of salary shows as an RRSP target row under a "Still held" group,
fed by the salary ribbon; hovering it spotlights the full funding path
like any other row. The strip is gone.

Notes: report-side only (budget engine, transfers, import, migrations
untouched). The flow gains one target row per qualifying off-budget
account (positive range net AND positive range-end balance — debt paydown
into a negative-balance account is liability reduction, never holdings),
routed through the "Still held" pseudo-group (Budget sort parks it last,
mirroring Uncategorized); held cells keep months by scaled positive parts
and compete chronologically in the same allocator, so existing ribbons
shift honestly and the Remaining plug shrinks to the on-budget leftover.
Identity everywhere: income = spending + held + remaining. Row-semantics
fixes: "Starting Balance" rows (openings, appraisals) are excluded from
income, spending, and held; off-budget profit rows flagged isIncome:false
by the YNAB4 import now count as income under the account name (the old
profit guard excluded ALL genuine imported profit). Removed
`computeRetainedBalances` and the `retained` prop; tooltips read held
rows as "Held" with no hatch (real accounts, not render artifacts).
