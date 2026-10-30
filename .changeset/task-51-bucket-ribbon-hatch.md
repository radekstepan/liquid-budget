---
"@ynab/ui": patch
---

## Spending by Category hatches Other and Remaining ribbons too (task-51)

Story: the stripey derived-money pattern now covers every ribbon that
carries Other-bucket or surplus money, not just the bars. Ribbons feeding
a merged Other row, the full-width Remaining lane ribbons, and the income
slices funding bucket rows all wear the shared hatch — while ribbons that
end as a terminal purchase stay solid even when routed through a merged
middle bucket, so solid always means "this money was spent".

Notes: view-only (logic geometry untouched). Destination-driven: a ribbon
hatches iff its money ends in (right-hop) or funds (left-hop) a bucket
target, the Remaining plug, or a held target; middle-bucket → real-target
ribbons stay solid by decision (pinned in tests — a future flip must be
deliberate). Overlays reuse the shared `sankey-bucket-hatch` pattern def
under the `sankey-bucket-hatch` testid with `data-side` (bars carry no
`data-side`), ride the same spotlight rest/bright/dim steps with the same
120ms cross-fade (zero under prefers-reduced-motion), sit in static DOM
order (no z-reorder), and never capture pointer events. Bars mode
unchanged (bucket bars already hatched; no plug rendered). Tooltips and
column headers unchanged.
