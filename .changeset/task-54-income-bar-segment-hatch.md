---
"@ynab/ui": minor
---

## Income bars hatch derived-money segments (task-54)

Story: the Spending report's Sankey chart now paints the derived-money hatch on the income bars too, completing the coverage already on the ribbons, parent group bars, and right-column rows. Each income-bar segment funding a hatched sub-ribbon (held, bucket, or plug cell) or plug band hatches with it, so every segment reads as its destination; whole-bucket income bars keep their single end-to-end hatch, and spending segments stay solid.

Notes: view-only change — the spans reuse the layout's own sub/band sy0/sy1 verbatim (no logic change), one overlay rect per hatched sub/band riding the bar's own spotlight opacity step. Spotlight-test `solidOf` helpers now walk back past consecutive segment overlays sharing one bar; bucket overlay counts updated for the two new income segments.
