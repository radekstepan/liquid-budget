---
"@ynab/logic": patch
"@ynab/server": patch
---

## g-status: Pin transfer-leg reconciled status semantics

Pins the intended per-side status semantics for single-row transfers instead of changing them.

- Source `r` + legacy NULL dest leg counts as reconciled on dest (legacy fallback from pre-migration 0020, `coalesce(transfer_status, status, 'c')`). Documents the YNAB4 divergence (YNAB4 keeps independent `cleared` per side; ours inherits without independent dest review).
- Source `c` + dest `r` counts cleared on source, reconciled on dest.
- Split parents already excluded / children counted, and uncleared rows already excluded from `workingBalance` (G1) — verified, no new tests needed.
