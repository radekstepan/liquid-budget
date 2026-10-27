---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey source labels and ribbon colors (task-14)

The Spending by Category sankey is easier to read on small income sources
and easier to trace end to end. Left-column income bars too short for two
lines now show the name only (the amount line is hidden below 26px of bar
height, with the name centered on the bar); taller bars keep name + amount
as before.

Flow ribbons now carry their source bar's color instead of the downstream
target color: each ribbon holds the source color through its midpoint, then
blends into a darker shade of that same hue toward the target end (via a
shared SVG gradient per source bar). The "Flows" tooltip dot follows the
ribbon's source-side color to match.

Notes: with fungible proportional allocation each middle group is fed by
every income, so a whole path can't share one income's color — coloring is
per hop (income color on the left ribbons, middle-group color on the right
ribbons). Remaining plug, Other buckets, and the Uncategorized pseudo-group
behave as before. `yarn test` and `yarn typecheck` pass; `yarn e2e` could
not run browser specs in the sandboxed agent session (Chromium headless
shell SIGSEGVs at launch — all 150 browser-spec failures are
`browserType.launch` crashes, zero assertion failures; the 37 API-contract
specs pass) — run `yarn e2e` in a normal terminal to confirm.
