---
"@ynab/logic": patch
---

## Search status is account-scoped (g-search-status)

`is:cleared` / `is:uncleared` now consider both legs of a transfer: a row
counts as cleared when either the source (`status`) or the destination
(`transferStatus`) leg is cleared/reconciled, and as uncleared only when
neither leg has cleared. A NULL dest status (legacy pre-migration rows)
falls back to the source status, matching `reconcile.ts`.

Transfer save payloads now carry `transferStatus` (new leg defaults from
the source status, mirroring the server default; existing transfers keep
their dest status), so the edit modal can show/submit the dest leg's
state. Bulk-edit status filtering and Inspector TBB rendering remain
DOM/e2e concerns (documented skips in the repro test).
