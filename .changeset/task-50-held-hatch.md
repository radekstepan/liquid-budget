---
"@ynab/ui": patch
---

## Spending by Category hatches still-held money, ribbons included (task-50)

Story: held money now wears the same stripey pattern as Other/Remaining
everywhere it appears. A Wealthsimple RRSP that still holds $400 of
salary shows hatched: its Sankey and Bars rows, the Still-held group bar,
the ribbon feeding the row, and the income slices funding it — so
derived money (buckets, surplus, retained balances) reads at a glance
against terminal purchase flows, which stay solid.

Notes: view-only (logic geometry untouched). Whole-held elements hatch;
mixed elements never do: income bars and bar segments funding held money
stay solid, and a merged bucket stays bucket-hatched even when it folded
held rows. Overlays reuse the shared `sankey-bucket-hatch` pattern def,
ride the same spotlight rest/bright/dim steps with the same 120ms
cross-fade (zero under prefers-reduced-motion), sit in static DOM order
(no z-reorder), and never capture pointer events. Tooltips and column
headers unchanged.
