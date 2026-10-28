---
"@ynab/ui": patch
---

## Stack Bars rows with no gaps (task-32)

Bars rows in Spending by Category now stack directly one after another with no vertical gaps: each row's bottom edge touches the next row's top edge.

Notes: removed the inter-row `gap-[6px]` (few-rows branch) and `space-y-[6px]` (many-rows branch) from the Bars list in `ui/SpendingReport.tsx`. Rows keep their own heights and colors (task-31 palette untouched); nothing compresses, shrinks, or truncates to fit the viewport. A long list scrolls via the existing `overflow-y-auto` container — the vertical scrollbar is the expected behavior. Sankey view, Bars hover, and Other-bucket styling are untouched (sibling tasks own hover and hatching).
