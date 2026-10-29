---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey left-hop ribbons nest downstream categories (task-39)

Story: in the Spending by Category Sankey view grouped by Categories,
every ribbon now reads as its final category end to end. Task-38 left
the income bars subdivided by category color while the ribbons leaving
them stayed wide group-colored bands, so a blue bar segment met a
wider brown arm. Now each income→group band draws one sub-ribbon per
downstream category, in the category's color, tiling the band exactly
where the income bar nests the same segments — blue meets blue at the
same width, through the group to the category bar.

Notes: render-side subdivision only — layout, hover, spotlight, and
tooltips are unchanged. Each band stays one hover target (handlers on
the wrapping `<g>`, so moving between sub-ribbons never flickers) and
every sub shares the band's spotlight key; tooltips still read at band
level (`Payroll → Bills`, full band value). Merchants grouping keeps
one group-colored ribbon per band, and the Remaining plug stays whole
and green. `ribbonPath` is newly exported from logic so sub-ribbons
use the layout's own curve family. Tests pinning whole-band counts,
group-colored fills, and ribbon indices were updated to the subdivided
geometry; one new test pins bar-segment/sub-ribbon color and pixel
alignment plus band-level hover.
