---
"@ynab/logic": patch
---

## Payee amount/memo autofill recall (g-autofill)

Typing a known payee on a blank register row can now propose the
payee's most recent amount and memo, matching YNAB4's per-payee
`AutoFillData` (last saved transaction wins). New pure helper
`suggestAutofillForPayee(history, payeeName, opts)` generalizes the
server's `lastCategoryForPayee`: the most recent exact-name match
(date-descending, id tiebreak) supplies amount + memo, while the
category prefers the payee entity default (`defaultCategoryId`) and
falls back to the most recent non-null history category.

Notes: no persistence change — proposals derive from history on demand,
so no amount/memo columns are added to the payee store. Rename-rule
priority (#2) and rename normalization (#7) are untouched: payee memory
matches on exact trimmed names, never `normalizeRenameText`. Server
create/rename paths are unchanged — YNAB4 only autofills blank new rows
and never overwrites an existing row's amount/memo. The repro test's
second case was test-is-wrong (it hardcoded a `null` proposal, which
could never pass) and now exercises the helper.
