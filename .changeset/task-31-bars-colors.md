---
"@ynab/ui": patch
---

## Restore lighter Bars colors (task-31)

Bars rows in Spending by Category are light again: each row is back to its own full-brightness stable color instead of the darkened Sankey family shade.

Notes: task-19 shared the Sankey `sankeyTargetColors` family with Bars so colors would match across views, and task-23's darkest-first flip made the largest rows darkest. Those shades darken toward black to stay readable at translucent ribbon opacity (rest 0.25), but at the Bars' full opacity they read too dark. Restored the pre-task-19 palette (`colorForName` per row; the merged Other bucket still renders slate). Sankey geometry, colors, hover, and tooltips are untouched — exact cross-view color matching does not survive, which is acceptable because Bars and Sankey are alternate toggle views and within-view row distinctness matters more.
