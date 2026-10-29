---
"@ynab/ui": patch
---

## Sankey middle bars segment by their outgoing cells (task-41)

Story: in the Spending by Category Sankey view, the middle-column group
bars sat flat in the group hue while category-colored arms left them to
the right, so bars and ribbons never matched the way the income bars do.
Each middle bar now fills with a hard-edged gradient of its outgoing
cells' target colors — one gradient per bar, the same construction as
the income bars — so every segment meets its ribbon exactly, in both
Categories and Merchants groupings.

Notes: render-only fill change — layout, geometry, hover/spotlight,
tooltips, labels, hatching, and ribbon paths are untouched. Option (a)
over hiding: the outgoing bands already tile each bar from its top edge
(pinned in logic), so matching needed no geometry change, while hiding
the bars would leave the right-hop ribbons starting mid-air and kill
group labels, hover, and tooltips. Verified against the render code
(not the claim) that the middle column renders in BOTH groupings — the
`middles` map carries no dimension guard — so one construction serves
both with no dimension split (one ribbon per cell holds in both). No
single color stands for a segmented bar: the group hue survives on the
tooltip dot, the Merchants left-hop ribbons, and the no-income fallback
(a bar with no outgoing bands renders solid in its group color via the
new `sankeyIncomeGradientStops` fallback parameter). When the minimum
label height lifts a bar past its band stack the gradient clamps to the
last segment's color below the bands — the same slack income bars have.
Tests: middle-gradient fills plus segment/ribbon pixel tiling in both
groupings and the no-income fallback in the component suite, the
bands-from-bar-top render contract (slack only at the bottom) in logic,
and the fallback parameter in chartUtils. Existing tests that pinned
the flat group-hued middle bars were updated explicitly.
