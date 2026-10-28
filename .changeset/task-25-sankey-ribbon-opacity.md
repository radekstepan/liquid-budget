---
"@ynab/ui": patch
---

## Sankey ribbons almost as solid as hover (task-25)

Spending Sankey ribbons and bars no longer render as a faint wash at rest. The rest opacity step moved from 0.18 to 0.75 — one small step below the 0.85 hover step — so the chart reads nearly as solid with no hover as it does under the spotlight, while hovering still visibly brightens the on-path flow.

Notes: the dim (off-path) step stays at 0.12, far below rest, so the hover spotlight still reads. Pure constant tweak in `SpendingReport.tsx`: existing component tests pin the fills via the symbolic `SANKEY_RIBBON_*_OPACITY` constants, so they cover the new values unchanged; one new test pins the step relationship (rest just below hover, dim well below rest) to guard against regression.
