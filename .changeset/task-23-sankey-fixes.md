---
"@ynab/ui": patch
---

## Spending Sankey readability and highlight fixes (task-23)

Ribbons and bars rest lighter overall, so the chart reads less heavy at
a glance.

Income bars now match their ribbons exactly: the feathered blend is gone
and each bar stacks its outgoing ribbons' colors with hard edges on the
ribbon boundaries, so every bar segment is the color of the ribbon
leaving it.

The amount-to-color scale now runs darker-with-more-money: the largest
sibling in a color family takes the darkest shade and smaller siblings
lighten toward the parent color (single children still keep the parent
color).

No Sankey bar carries a border anymore — incomes, groups, and
categories/merchants all paint borderless, with the hatch alone marking
the render-only Other and Remaining rows. The hover halo in the bar's
own color stays as the hover feedback.

The left-ribbon tooltip no longer carries the "Proportional split —
money is fungible" line.

Hovering a merchant split across groups no longer spotlights every
group's full funding fan: a target bar now traces only its dominant
(largest-link) parent-group path — itself, its dominant cell, its
dominant group, and that group's income fan — the same attribution rule
the family colors and Group sort already use. Categories (one group
each) behave exactly as before.

Notes: `yarn typecheck` and the focused ui suites plus the full `yarn
test` pass; `yarn e2e` needs a normal terminal (sandboxed Chromium
cannot launch in agent sessions — the known environment block in
`AGENTS.md`).
