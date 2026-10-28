---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Fix Sankey left legend cutoff and amount spacing (task-11)

The Spending flow chart's left-column income labels could clip past the
SVG's left edge: long names like "Canada Revenue Agency" truncated with an
ellipsis that still touched (or crossed) x=0, and the $ amount lines sat
dangerously close to the edge.

The left gutter is now wide enough for two-line income labels, and name
truncation budgets against the actual pixel zone between the label anchor
and a minimum 8px left inset — so the ellipsis always lands inside the
visible area and amounts keep a safe inset at any chart width.

Notes: geometry only, no visual restyle (same palette, fonts, radii).
Follow-up (Task D): rework transfers so money flows through (e.g. income
paying a credit card) instead of rendering as a "Transfer" node.
