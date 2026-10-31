---
"@ynab/ui": minor
---

## Parent-category bars hatch derived-money segments (task-55)

Story: the Spending report's Sankey chart now paints the derived-money hatch on middle (parent category) bar segments too, in both Categories and Merchants dimensions. Every outgoing cell into a held, bucket, or plug target hatches its source span on the bar, so each segment reads as its destination; whole-hatched bars (merged Other buckets, whole-held Still-held bar) keep their single end-to-end hatch, and spending segments stay solid.

Notes: view-only follow-up to task-54, same rule one column over — spans reuse the layout's own linksRight sy0/sy1 verbatim (no logic change), one overlay rect per hatched cell riding the bar's own spotlight opacity step. The mixed Still-held bar and kept bucket-feeding bars now carry segment overlays instead of staying fully solid; overlay counts updated accordingly.
