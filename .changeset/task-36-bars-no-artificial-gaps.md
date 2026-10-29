---
"@ynab/ui": patch
---

## Bars rows render consecutively at fixed height (task-36)

Story: In Spending by Category - Bars view, short lists used to stretch their rows apart to fill the viewport, inserting artificial gaps between the fixed-height bars. Now every row renders one after another at the same fixed height with zero artificial spacing, and long lists scroll naturally instead of being squeezed or spread to fit one page.

Notes: removed the `growRows` (≤14 rows) flex-stretch branch from the Bars list in `ui/SpendingReport.tsx` — the scroller, list, rows, and labels are now single static class strings (the previous many-rows `py-[7px]` / `w-[26%]` styling for all counts). Bar colors, h-[14px] tracks, hover, tooltips, and merged-Other hatch are untouched. The task-32 gapless test now also pins the no-stretch contract (no `flex-1`/`min-h-` on rows, no `flex`/`h-full`/`justify-center` on the list).
