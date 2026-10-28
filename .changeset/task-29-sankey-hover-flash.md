---
"@ynab/ui": patch
---

## Fix parent-category hover light flash (task-29)

Hovering a middle-column parent group no longer flashes lighter than its Sankey ribbons: the hover spotlight now lands atomically in the first painted frame.

Notes: root cause was a paint-timeline split, not state — one commit sets final brightness and swaps ribbon paint order, but the order swap paints instantly while `fill-opacity` glided over 120ms, showing final z-order at pre-transition brightness. The `fill-opacity` transitions are removed from all five Sankey spotlight element kinds (both ribbon hops, all three bar columns), so bar and ribbons always share the exact same brightness from the first frame. Hover feedback is now instant rather than faded; rest/bright/dim steps and the lit-above-dim z-order are unchanged. Covered by a new test asserting no spotlight element carries a fill-opacity transition and the hovered bar matches its lit ribbons.
