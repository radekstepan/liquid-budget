---
"@ynab/ui": patch
---

## Sankey right-column rows are one hover target (task-37)

Story: in the Spending by Category Sankey view, each right-column
(category/merchant) row now behaves as a single hover target. Hovering
anywhere on a row — bar, title, or amount — spotlights the same flow path,
and moving between the parts no longer fires leave+enter, so the spotlight
no longer flickers. Leaving the row still clears the spotlight.

Notes: the row's hover handlers moved from the separate bar/title/amount
elements to the wrapping row `<g>`, and a transparent hit band now bridges
the dead space between the parts (the bar→label gap and the space between
the two label lines) so the whole row band holds the hover. Spotlight
semantics are unchanged (path brightens + renders above, rest dims,
rAF-throttled hover incl. leave-clears, no CSS transition on brightness
steps). Follow-up: the left (income) and middle (group) columns still use
per-part hover registrations with the same inter-part gaps, so they can
flicker the same way — intentionally out of scope here.
