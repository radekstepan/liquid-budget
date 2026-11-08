---
"@ynab/logic": patch
---

## Per-month overspend handling (g-redarrow)

Story: the budget engine can now vary YNAB4 "Red Arrow to the Right"
handling per category and month. Pass `overspendOverrides` (a
`Record<categoryId, Record<monthKey, boolean>>`, or nested Maps) to
`computeBudget`/`buildBudgetIndex`, or set `BudgetData.overspendOverrides`.
A month with an explicit entry uses it; months without one inherit the
previous walked month's effective handling (matching YNAB4's
`overspendingHandling` getter, where null inherits); the static
`Category.overspendCarriesOver` flag seeds months before the first
override. Without overrides behaviour is unchanged.

Notes: pure-logic phase only — no schema migration, no persistence, no
UI. Override-specific walks bypass the shared index cache (they are only
valid for one override set), and override-built serialized indexes carry
the correct ending balances. Storing monthly flags in the database and
exposing them in the UI is follow-up work.
