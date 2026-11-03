---
"@ynab/logic": minor
"@ynab/server": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## YNAB4-style uncategorized imports with mandatory categorization

CSV imports no longer default positive rows to income and no longer
auto-categorize from payee defaults or history: imported rows stay
uncategorized (blank category cell, bold needs-review row) until the user
categorizes them. The only exceptions are an explicit category column in
the file and a rename rule that corrects the payee — that path populates
the clean name's payee default (or last use), mirroring a manual rename.

Supporting changes:

- The transaction modal's category picker opens blank and blocks save
  until a real category or explicit Income is picked (Income hidden on
  credit accounts and rejected for outflows). Typing a known payee into
  a blank category auto-fills its last-used category.
- Single-transaction payloads, API contracts, and routes carry an
  explicit `isIncome` flag so Income and Uncategorized are distinct
  when the category is null.
- Editing a transaction's payee server-side auto-fills the category
  from last use when the row is uncategorized, and unrelated edits
  (approve, memo, flag) preserve `isIncome` instead of flipping
  uncategorized inflows to income.
- The register shows "Income" for true income rows and leaves
  uncategorized cells blank; category sorting is unchanged.
