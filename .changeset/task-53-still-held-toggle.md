---
"@ynab/logic": minor
"@ynab/ui": minor
---

## Spending Sankey gains a Still-held toggle (task-53)

Story: the Spending report's Sankey chart now has a Held toggle (On/Off, next
to the Sort control, Sankey view only) that shows or hides the still-held
flows in both Categories and Merchants dimensions. Hiding removes the
Still-held middle-group bar, the held target rows, and their right-hop
ribbons plus left-hop funding sub-ribbons — and the hidden held total folds
back into the Remaining surplus plug through the existing allocator, so
income = spending + remaining still reconciles and the header Left stays $0.
The choice persists across sessions (shown by default); Bars rows and the
shared In/Out/Left header always read the full flow either way.

Notes: math-first per convention — the exclusion is `excludeHeldCells`, a
pure transform of the flow+series pair in `@ynab/logic` (kept rows hold
their positions, shared-name targets shrink instead of dropping, no-held
input returns its own references), consumed as Sankey-scoped memos in
`SpendingReport`; no render-side filtering. Held rows keep routing through
the Still-held pseudo-group when shown. The single-button toggle matches the
Cash Flow Trend precedent (same Button/toolbar styling, no new design
language, no motion of its own). Covered by 6 new logic tests (strip shape
and series alignment, shared-name shrink, identity fast path, plug refold
with Left at $0 on both paths, shown behavior pinned) and 6 new component
tests (hide + refold on both funding paths, Merchants dimension, remount
persistence, Bars/header untouched, only-held empty state).
