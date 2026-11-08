---
"@ynab/logic": patch
---

## Split penny leg (g-split-penny)

Split-template penny remainders now go to the largest leg (ties keep the first), matching YNAB4 `RegisterGrid.distributeAmountsToSubTransactions` — e.g. 100c in 3 equal shares applies as [34, 33, 33] instead of [33, 33, 34].

Notes: every leg is rounded to the cent first, then the whole leftover (positive or negative) is added to the largest leg, so children still always sum to the parent exactly. No migration or follow-up needed.
