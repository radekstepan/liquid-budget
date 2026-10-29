---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey income bars nest downstream category colors (task-38)

Story: in the Spending by Category Sankey view grouped by Categories,
income bars once again break down by category color. Each income→group
band nests its downstream categories in exact proportion, so you can
trace each income dollar from the bar to its categories. Grouping by
Merchants is unchanged: each band stays one group-colored segment.

Notes: task-35 gave right-column categories fully independent hues
while income bars kept showing group hues, disconnecting the two sides
by color. New pure helper `subdivideBandByValues` (logic/sankey.ts)
splits an income band into proportional spans; SpendingReport uses it
only for Categories grouping (each category has exactly one group, so
the split is exact), resolving each span to its target's color with a
group-color fallback. Ribbons, geometry, hover, and tooltips are
untouched — pure fill change. The old UI test pinned the buggy
group-colored Categories gradient, so its expectation was updated
explicitly and a Merchants grouping test was added.
