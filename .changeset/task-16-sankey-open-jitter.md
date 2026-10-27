---
"@ynab/ui": patch
---

## Stable Spending chart on open (task-16)

Opening the Spending by Category chart no longer jitters. The chart now
paints its final geometry on the first frame and stays put: hovering
sweeps coalesce to one update per animation frame (latest wins) instead
of queuing a full re-render per mousemove event, duplicate size
notifications no longer force redundant re-renders and layout recomputes,
and scrollbars can no longer shift the chart (horizontal overflow is
clipped since the chart is sized exactly to its box, and the vertical
scrollbar gutter is reserved so a scrollbar appearing mid-session never
steps the width).

Notes: task-14/task-15 behavior is unchanged (small-source label hiding,
solid income through-color ribbons, hover through-line highlight — the
highlight sets and tooltip contents are identical, only their commit
timing is throttled). Also fixed `useRafThrottledSet` wedging off all
later pushes when `requestAnimationFrame` invokes synchronously. `yarn
typecheck` and the full `@ynab/ui` suite (716 tests) pass; `yarn e2e` was
not run in the sandboxed agent session (Chromium SIGSEGVs at launch
there — see AGENTS.md) — run `yarn e2e` in a normal terminal to confirm.
