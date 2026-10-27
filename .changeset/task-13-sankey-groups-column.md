---
"@ynab/logic": minor
"@ynab/ui": minor
"@ynab/web": patch
---

## Sankey category-groups middle column (task-13)

The Spending report's Sankey diagram now routes money through category
groups: income sources on the left flow into category groups in the middle,
which flow into categories or merchants on the right. Each group bar shows
its amount and share of the flow, and hovering it reports how many
categories or merchants it feeds.

How the column behaves:

- In Categories mode every category rolls up into exactly one group, so
  group ribbons are exact. In Merchants mode a merchant splits across the
  groups its transactions belong to; uncategorized spending routes through
  an "Uncategorized" pseudo-group.
- The shared Under slider merges small rows on all three columns (income,
  groups, spending) and the header counts every merged row. A kept row
  whose group merged still routes — through the middle "Other" bucket.
- The Remaining plug stays on the right: unspent money bypasses groups, so
  its ribbons run full-width from the incomes behind the middle column.
  Shortfalls still render as neutral segments, now on both middle and
  right bars.
- Middle labels sit in the ribbon zone with a light halo; there is no
  legend (inline labels carry names, amounts, and shares, as before).
- Hovering any bar or ribbon spotlights its whole flow path: a category
  lights its group, the group ribbon, and the income ribbons feeding that
  group.

Notes: new pure logic in `@ynab/logic` — `computeSpendingGroupFlow`
(`computeSpendingBreakdown` now delegates to it, so both stay identical by
construction), `mergeGroupFlow` (threshold merge that re-aggregates links
exactly), and `layoutGroupedIncomeSankey` (three-column geometry; the right
column keeps owning the pixel scale so the long tail holds its label
pitch). `SpendingReport` props changed from `categories`/`merchants` item
arrays to `categoryFlow`/`merchantFlow` flows. Merged "Other" rows now carry
an explicit `bucket` flag instead of being detected by name and count, so a
bucket holding a single row renders correctly; "Other" tooltips use proper
singular/plural nouns on all three columns.
