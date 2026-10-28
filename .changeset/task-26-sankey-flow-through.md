---
"@ynab/logic": minor
"@ynab/ui": patch
---

## Sankey flow-through attribution (task-26)

The Spending Sankey now traces money THROUGH intermediate off-budget
accounts instead of stopping at the transfer legs. If salary funded the
investment account and the investment account later funded vacation
spending, the chart shows salary → vacation (attributed to the original
income source) — not a contribution allocation on the way in plus
unattributed investment-account income on the way back.

An off-budget account still appears as an income source, but only for its
own profit over the period: external growth recorded directly in the
account (dividends, interest, deposits), grouped under the account's name.
Pass-through principal never appears as income, and contributions never
appear as spending, so the same dollar is counted exactly once.

Notes: report-side change only — the budget engine, cash-flow, and trends
reports are untouched, and credit-card-payoff exclusion semantics are
unchanged. Money is fungible: every outflow is funded pro-rata by its
traced inflow sources, which is exactly the report-wide proportional
allocation the income→groups left hop already computes, so chains of
arbitrary depth (A→B→C→spending) collapse with no new geometry. An
account with no external inflows contributes no income source at all
(clamped at zero — there is no mark-to-market in transaction data, so a
"loss" is just outflows exceeding period inflows, funded from pre-period
balances); the shortfall surfaces through the existing uniform-coverage
shortfall (unfunded/Over-income), reducing every attributed source
proportionally instead of inventing a negative income node.
Categorized on-budget internal transfers still count as spending (legacy);
the `transfer` item flag is now vestigial (never set — tooltips pending
cleanup) and the Income column header reads "Off-budget accounts add
profit only." Tests: new `isOffBudgetTransfer` unit tests plus a
`sankey flow-through attribution` suite (pass-through via withdrawal and
via direct spend, partial profit, break-even, loss, multi-hop, mixed
sources, conservation invariants); five existing sankey expectations and
one ReportsView expectation that pinned the old terminal-allocation
behavior were rewritten and each is marked as having encoded the bug.
`yarn test` (2340 tests) and `yarn typecheck` pass; `yarn e2e` hit the
known sandbox block (Chromium headless shell SIGSEGV at
`browserType.launch` on all 150 browser specs, 37 API-contract specs
pass) — confirm `yarn e2e` in a normal terminal.
