---
"@ynab/ui": minor
---

## Make Bars hover useful (task-33)

Hovering a row in the Spending by Category Bars view now shows a tooltip worth reading. Before, it only restated what the row already displayed (exact amount and share of spending) plus the header total — zero new information. Now the tooltip keeps the factual Spent line and adds the row's group attribution, which the row cannot show: a category names its parent group ("65% of $1,550.00 spending · in Bills"), and a merchant spanning several groups lists each group's amount and share, largest first. Merged Other buckets keep their merged-count line ("2 smaller categories under $500.00") with the row total.

Notes: group attribution comes from the already-merged `groupLinks` cells (`merged.links` + `merged.groups` in `ui/SpendingReport.tsx`) — no logic changes; transaction counts are deliberately not shown because the spending-flow contracts (`SpendingBreakdownItem`) carry only name + value and plumbing counts through was out of scope. Tooltip content stays factual and compact per task-27 (no explainer lines). Also routed Bars mouse-leave through the shared rAF hover throttle (`pushHover(null)`, the task-30 pattern) so a direct row-to-row switch lands in one commit instead of blinking the tooltip off for a frame. Bars colors (task-31), gapless stacking (task-32), Sankey, and Other-bucket hatching (task-34) are untouched.
