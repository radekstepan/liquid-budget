---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey renders verbatim from math-first layout objects (task-44)

Story: the Spending Sankey had three related complaints — a category line
(Housing → Mortgage Interest) rendering thicker than the same-colored
income line (SAP Concur → Housing), messy lines into the Other bucket with
a parent Other bar that looked line-less, and geometry logic split between
the layout and the renderer so no single object described the picture.
The Sankey is now math-first: `layoutGroupedIncomeSankey` computes every
node, ribbon, sub-ribbon, gradient stop, fill, and label anchor as plain
reproducible objects, and the view draws them verbatim with no geometry,
subdivision, path, color, or label math of its own. Each color now crosses
the middle as one contiguous block at exactly its cell's thickness.

Notes: task-43's per-color fix only held for a single income — with several
incomes each income's slice stayed a fraction of the full cell, which is
what the report showed (verified against the real database: a 5.43px
income slice entering vs the 7.07px cell leaving). The renderer now
consumes the layout's leftCells
(cell-major contiguous blocks; same-income braiding on the left hop is the
topological price and is minimal). Also fixed in passing: (1) the SVG sized
itself from a row-count heuristic and clipped fat bars (e.g. a tall
Remaining plug) — it now fits the layout's contentHeight; (2) hairline
middle bars sat under their own labels' halos, hiding their ribbons —
labels anchor at the layout's labelY; (3) chartUtils duplicated the palette
with a divergent by-name bucket branch (a literal "Other" row rendered
slate and collided with the bucket) — @ynab/logic is the single home now,
buckets resolve by flag. Amounts, hover/spotlight, tooltips, hatching, bar
positions, and the Remaining lane are unchanged; Merchants grouping keeps
whole bands. Tests: leftCells conservation/tiling/determinism in logic, a
two-income contiguous-block component test, and updates to the 13
expectations pinning the retired minimum-lifting design (6 logic + 7 UI).
E2E browser
specs could not run in this sandbox (documented Chromium SIGSEGV at
launch; all 37 API specs pass) — confirm `yarn e2e` in a normal terminal.
