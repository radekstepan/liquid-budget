---
"@ynab/logic": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Restore Sankey with viewport auto-fit Under threshold (task-18)

Restores the Spending by Category Sankey flow report (income → groups →
categories/merchants,merge slider, Bars alternative) with one new behavior:
on initial load the "Under" slider automatically rises to the smallest stop
whose merged columns fit the current viewport, so the chart shows fully with
no amounts under the fold. When even full merging cannot fit, it settles on
the closest stop (fewest rows).

The auto-fit runs once per tab session and is raise-only: a stored threshold
that already fits stays untouched, and after the user drags the slider —
or switches report tabs and back — their choice is never overridden. Drag
back to Off at any time to see every row with scrolling as before.
