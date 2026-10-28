---
"@ynab/logic": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Spending Sankey visual fixes (task-22)

Income bars are no longer flat gray: each one fills with a gradient of its
outgoing ribbons' colors from the first paint, with no glassy hover
overlay. All Sankey bars and hatches paint with square corners.

Category and merchant bars now share their incoming ribbons' exact fill at
the same rest/bright/dim brightness steps, so every line into a bar
matches the bar in every spotlight state. The rest step is lighter
overall, and parent-group labels carry a fully opaque halo so ribbon
colors can't bleed through and tint them.

The How-to-read explainer is plain hint text instead of a button, since
there is nothing to click (the explainer still shows on hover and
keyboard focus).

The Sort control's Group mode now orders categories within their parent
group by Budget category order, not just the groups by Budget group
order; merchants keep value-descending within a group since they have no
Budget position.

Notes: `yarn typecheck` and the logic/ui unit suites pass; `yarn e2e`
needs a normal terminal (sandboxed Chromium cannot launch in agent
sessions — the known environment block in `AGENTS.md`).
