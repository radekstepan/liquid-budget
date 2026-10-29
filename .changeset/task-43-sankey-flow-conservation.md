---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey ribbons conserve flow through the middle column (task-43)

Story: in the Spending by Category Sankey view grouped by Categories, a
category-colored ribbon could enter its group bar at one thickness and
leave it at another — e.g. the Housing → Mortgage Interest line rendering
thicker than the same-colored SAP Concur → Housing sub-ribbon. Every color
now crosses the middle column at one thickness: each income's share of a
category nests inside its band in exact proportion to the drawn
group → category ribbon, so the eye can trace one width end to end.

Notes: two compounding causes, fixed separately. (1) Layout: left-hop
income → group bands used to subdivide the middle bar, stretching to fill
it when the minimum label height lifted the bar past its outgoing stack —
they now tile the middle's drawn outgoing stack from the bar's top edge,
keeping the same slack below that the outgoing side already had (no-op
when the bar is not lifted). (2) Render: the left-hop subdivision weighed
cells by raw value, blind to minimum-lift inflation on the target side —
cells now weigh in at their drawn heights (identical when undistorted, and
the shared memo keeps income-gradient segments pixel-aligned with the
sub-ribbons). Amounts, colors, hover/spotlight, tooltips, hatching, bar
positions, and the Remaining lane are unchanged; Merchants grouping keeps
one ribbon per band. Tests: incoming-bands-tile-the-drawn-stack in logic
plus a per-color thickness-conservation component test.
