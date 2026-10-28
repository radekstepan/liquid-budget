---
"@ynab/ui": patch
---

## Sankey hover highlight + color consistency (task-19)

The Spending by Category Sankey now highlights whole flow paths on hover:
hovering a category/merchant on the right lights the bar and every line
leading into it, hovering a group lights its incoming and outgoing ribbons
with the bars on both ends, and hovering an income on the left lights every
line leading from it — its full downstream contribution in full, not just a
sliver of each ribbon.

Ribbon colors are simpler too: each line carries one flat color through its
whole length — the color of the node it flows into — so the income side
never colors a ribbon. Every category/merchant belongs to its dominant
parent group's color family (largest child keeps the parent color, smaller
siblings darken by rank), and the Spending Trends bars share the same
family colors so a category keeps its color across views. Parent group bars
are now subtle borderless vertical bars with no black highlight outline.

Notes: `yarn build`, `yarn test`, and `yarn typecheck` pass; `yarn e2e`
could not fully run in the sandboxed agent session (the sandboxed Chromium
headless shell SIGSEGVs at `browserType.launch`, the known environment
block in `AGENTS.md` — all 150 browser specs fail identically there while
all 37 API-contract specs pass, and no e2e spec covers the Sankey) — run
`yarn e2e` in a normal terminal to confirm.
