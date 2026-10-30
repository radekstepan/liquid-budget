---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Merchant Sankey carries through-color all the way to income (task-46)

Story: in the Spending by Category Sankey, the Categories view draws every
flow in its final destination color from the right column all the way back
to the income bars — but switching to Merchants broke the spell: the
merchant→group arms carried merchant colors while the income→group arms
stayed group-colored, so the line into each income bar did not match the
line out to the merchant. Merchants grouping now subdivides each
income→group band into one sub-ribbon per downstream merchant cell, in the
same merchant colors, landing in contiguous per-color blocks — the exact
treatment Categories already had. Hovering a merchant bar spotlights its
color flowing all the way to income (only its slices out of shared bands)
while its parent group bars brighten, just like hovering a category.

Notes: one behavior line — the view now always requests `leftDetail:
"cells"`; the math-first layout already subdivided bands generically, so no
layout math changed. A merchant split across groups repeats its color down
an income bar, once per band it funds. The Categories view is locked in as
a golden image (committed layout-JSON snapshot plus explicit through-color
pins) so regressions are caught. Two tests pinning the old group-colored
Merchants behavior were updated to the new contract (not weakened). E2E
browser specs could not run in this sandbox (documented Chromium SIGSEGV at
launch; all 37 API specs pass) — confirm `yarn e2e` in a normal terminal.
