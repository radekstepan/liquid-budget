---
"@ynab/server": patch
---

## YNAB4 overspend mapping (g-overspend-map)

Story: importing a YNAB4 backup no longer loses the red-arrow setting, and
exporting no longer writes values YNAB4 does not understand. A category
with any monthly budget carrying `overspendingHandling: "Confined"` now
imports as `overspendCarriesOver: true` (previously the importer only
looked for the string on the SubCategory itself, which stock YNAB4 files
never set, so the flag was always false). Export now writes the stock
YNAB4 enum — `true` to `"Confined"`, `false` to `"AffectsBuffer"` —
instead of the inverted pair (`"OverspendCarriedForward"`/`"Confined"`).

Notes: the per-category flag stays static (no schema migration); a
category is marked carry-over if any of its monthly budgets says
Confined. The importer still accepts `"OverspendCarriedForward"` for
backups written by the pre-fix exporter. No UI changes.
