---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Remaining surplus routes through a dedicated lane (task-40)

Story: in the Spending by Category Sankey view, the green Remaining
surplus ribbon used to slash diagonally from each income across the
middle bars and category ribbons, making a mess of the chart. It now
drops from each income into a dedicated lane below the middle column,
bridges under the group bars, and traverses into the Remaining plug —
crossing no bar and no category/merchant ribbon, in both groupings.

Notes: geometry-only fix — amounts, surplus accounting, tooltips,
hover/spotlight, colors, hatching, and bar positions are unchanged (the
plug bar keeps its stacked trailing spot; the lane is transit-only).
The traverse shares the right-hop x-range and curve family, so the
crossing-freedom is exact; the drop still crosses income→group ribbons
in the left half (topologically unavoidable — the same dense-bipartite
crossings group ribbons make with each other). When the middle column
hangs below the last spending target the lane pokes past the plot
bottom by `remainingLaneOverflow` and the canvas extends to fit it
(the plot is absolute-scale and already full, so growing the layout
height would only scale every bar with it). With no middles the plug
ribbon stays straight. Tests: lane placement/tiling/overflow and a
sampled no-crossing proof in logic, lane shape in both groupings plus
plug spotlight in the component suite; the sub-ribbon tiling test now
parses the plug's lane path.
