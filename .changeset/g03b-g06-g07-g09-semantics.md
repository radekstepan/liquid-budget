---
"@ynab/server": patch
---

## YNAB4 import semantics: raw account types, verbatim splits, budget notes, no phantom reconciliations (g03b/g06/g07/g09)

Story: importing a `.y4backup` used to silently collapse data four
ways — the 11 YNAB4 account types became 3, zero-amount split legs
vanished, explicit-zero budgets and budget notes were dropped, and
stock files gained reconciliation rounds YNAB4 never recorded. All
four now import faithfully: `accounts.account_type_raw` preserves
the verbatim YNAB4 type (`kind` still drives app logic; the exporter
prefers the raw value when present), zero legs and zero-sum parents
import verbatim, explicit-zero budgets and per-category notes persist
on assignments, and stock files create no reconciliation rows.

Notes: `lastEnteredCheckNumber` is intentionally dropped (no column;
a single aggregated warning counts affected accounts — check-number
tracking is not modeled) and the exporter writes YNAB4's default
`-1` so our backups stay stock-shaped. The `transactions.amount != 0`
DB CHECK is removed so zero rows can persist; user-facing creation
still rejects zero via `assertValidAmount` (only the direct-SQL
CHECK test changed). Balance math needed no fix — split parents are
excluded from sums and zero legs contribute 0. Month-level
`MonthlyBudget.note` is intentionally dropped (one aggregated
warning); `reconciliations[]` input is documented in code as our own
extension (stock YNAB4 never writes it). Behavior changes: stock
imports keep per-row `cleared: "Reconciled"` as status `r` (real lock
data) with `reconciledAt` but no linked round, so `unreconcile`
only reverses in-app rounds — the old BUG-14/BUG-08 tests encoded
the synthesis behavior and were updated to assert the new semantics
explicitly. Migration `0029` adds the two columns and rebuilds
`transactions` without the amount CHECK.
