---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Spending Sankey fixes (task-21)

Hovering a category or merchant bar no longer draws a black border — the
bar gains a soft halo in its own color instead — and hovering any node or
ribbon now spotlights the full flow path including the parent category
group, which brightens in the same bright color as its ribbons while
off-path groups dim.

Income bars keep their thin neutral stroke on hover and gain a translucent
feathered gradient built from their outgoing ribbons' colors, with soft
overlap and no hard edges.

Bars now wrap their funded flow instead of padding out to their full value:
under a shortfall a bar matches its ribbon stack (floored at the minimum
label height), and the gap still shows in tooltips and the header.

A new Sort control orders the right column by parent category group (Budget
view group order, value-descending within) or by current amount; Bars view
is unchanged.

Notes: `yarn build`, `yarn test`, and `yarn typecheck` pass; `yarn e2e`
could not fully run in the sandboxed agent session (the sandboxed Chromium
headless shell SIGSEGVs at `browserType.launch`, the known environment
block in `AGENTS.md`) — run `yarn e2e` in a normal terminal to confirm.
