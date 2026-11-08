---
"@ynab/logic": patch
"@ynab/server": patch
---

## Clarify workingBalance vs clearedBalance (g01)

Story: our `ReconcileState.workingBalance` (cleared + reconciled only, the
number you compare against a bank statement) shares a name with YNAB4's
`workingBalance` (cleared + uncleared projection) while actually being
YNAB4's `clearedBalance`. Our stored `accounts.balance` (every row applied
regardless of status) is the true YNAB4 `workingBalance` analog. The field
keeps its name for API/UI backwards compatibility, but `reconcile.ts` now
documents the collision explicitly so no future consumer adds uncleared to
it or compares it against `accounts.balance`. The register header now also
states its backward-from-stored-balance anchor (vs YNAB4's
forward-accumulation), the date-desc/id-desc vs YNAB4 amount/check/payee
tiebreak difference, and the constant-offset drift risk when the stored
balance is wrong.

Notes: no behavior change. New unit tests pin that `computeReconcileState`
excludes uncleared (even very large uncleared amounts) and returns zero
when only uncleared rows exist.
