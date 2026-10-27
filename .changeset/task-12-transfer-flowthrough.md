---
"@ynab/logic": minor
---

## Transfers flow through, investment withdrawals count as income (task-12)

The Spending flow (Sankey) report reworks how transfers are handled, so
money flows through instead of being marked as a "Transfer" expense.

**Credit-card payoffs flow through.** Paying a credit card from income used
to show up as a second "Transfer" expense alongside the original card
purchases. Payoff transfers (internal moves touching an on-budget credit
account) are now excluded from spending in both category and merchant
views — the spending is already captured once by the original categorized
card purchases.

**Investment accounts answered: withdrawals are income.** Money moved INTO
an off-budget/tracking/investment account (e.g. Wealthsimple Trade) counts
once as an outflow allocation under its category. Money withdrawn back INTO
an on-budget account now counts as income in the Sankey income column —
yes, liquidating the account is income when the money re-enters the budget.
This holds however the withdrawal was recorded (on either leg, categorized
or not) and it never nets against spending, so contributions are not
double-counted.

Notes: report-side change only — the budget engine, cash-flow, and trends
reports are untouched, and no existing transfer-invariant or budget-math
test changed meaning (the legacy categorized-transfer spending test still
passes as-is). Payments to off-budget (tracking) credit accounts still
count as spending, since that debt's activity never hit budget categories.
`yarn typecheck`, `yarn test`, and `yarn check:artifacts` pass; `yarn e2e`
could not run in the sandboxed agent session (the sandbox denies
`listen()`, so `next start` fails with `EPERM` on port 3100) — run `yarn e2e`
in a normal terminal to confirm.
