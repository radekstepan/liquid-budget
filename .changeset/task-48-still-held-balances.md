---
"@ynab/logic": minor
"@ynab/ui": minor
---

## Spending report shows money still held in investment accounts (task-48)

Story: the Spending by Category report already flowed money through
off-budget investment accounts — salary deposited into Questrade, moved to
Wealthsimple Trade, then withdrawn for a house downpayment reads as
SAP Concur → Downpayment, with each account a source only for its own
appreciation — but money that never left those accounts simply vanished
from the report. A new Still-held strip under the header now names every
off-budget account (RRSP, TFSA, …) that still holds money over the
selected range, with its balance, distinct from money used on purchases.

Notes: new logic API `computeRetainedBalances` (report-side only — the
budget engine is untouched): each off-budget account's range net change
(contributions + profit in, withdrawals + direct spending out), positive
balances only, sorted descending. Accounts that fully cycled or drew
down earlier savings in-range are omitted by the same clamp-at-zero
philosophy as off-budget profit. Identity: header Left equals signed
off-budget nets plus the on-budget leftover, so every unspent dollar is
either still held below or still in the budget. ReportsView computes and
passes the list; SpendingReport renders the strip in both Sankey and Bars
modes and hides it when empty (embeds without the prop see no change).
The Sankey geometry itself is untouched.
