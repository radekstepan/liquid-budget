---
"@ynab/web": patch
---

## Merge e2e expects the YNAB4 user-date rule (g-merge-e2e)

The `transactions-merge` e2e specs asserted the old "imported bank data wins every field" rule for the merged date (`2026-08-21`) and an uncleared status, contradicting the domain contract in `packages/logic/src/merge.ts`: `resolveMergedTransaction` keeps the user-entered date per YNAB4 `match()` and resolves cleared status as `max(bank, user)` — behavior the `@ynab/logic` unit tests already pin. The API and UI merge specs now expect the manual date (`2026-08-02`) and cleared status.

Notes: test-only change, no product behavior changed. The UI assertions in the same spec still need a browser run to confirm (sandboxed Chromium SIGSEGVs at launch; confirm `yarn e2e` in a normal terminal).
