---
"@ynab/logic": patch
---

## Strict money parsing on ingest (g-money-strict)

Story: `num()` silently coerced corrupt money to 0 (`num("abc")` → 0,
`num(NaN)` → 0), so a corrupt amount could flow through income checks,
budget math, and reports as if it were zero. It now throws `TypeError`
on NaN, empty/whitespace-only strings, and strings with no parseable
number — matching YNAB4, whose `MonthlySubCategoryBudget` setters throw
`ArgumentError("NaN passed in")` on corrupt money
(`MonthlySubCategoryBudget.as:202-256`). `isIncomeTransaction` surfaces
the throw instead of silently returning false for a NaN amount.

Notes: `null`/`undefined` (missing value) still coerce to 0, and the
non-finite/overflow silent clamp plus `strict`-mode `RangeError`s are
unchanged (still pinned by `format.test.ts`). Locale-separator behavior
from g-money-parse is untouched — en-US/de-DE parsing, rounding, and
the `(…)`/`$`-prefix handling all behave as before. `dollarsToCents`
(the CSV/YNAB4 ingest helper) likewise throws `TypeError` on NaN rather
than returning 0; its `null`/`undefined` → 0 contract is unchanged. The
stale `num("abc") → 0` assertion in the sibling rounding
characterization now expects the throw. No UI changes.
