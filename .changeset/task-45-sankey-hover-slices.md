---
"@ynab/ui": patch
---

## Sankey target hover lights only the hovered cell's slices (task-45)

Story: hovering a category like Rent in the Spending Sankey lit the correct
grey path through its parent group (Needs) but also lit Household, Groceries,
and every other category nested in the same bands to the left. Each
income→group band subdivides into one sub-ribbon per downstream category,
but all subs shared the band's single spotlight key, so a target hover lit
the whole band. Each sub-ribbon now carries its own spotlight key (its band
AND its downstream cell): hovering a category or its ribbon lights only that
category's slices, and unrelated arms stay dimmed.

Notes: income, group, and left-ribbon hovers light every downstream cell of
their bands, so all subs of a lit band still light there — unchanged. The
old shared-key behavior was documented as intentional in the task-39
changeset; it was wrong for target/ribbon hovers. Tests: two regression
tests pinning per-slice spotlight on target hover and on group→category
ribbon hover (both failed before, lighting the sibling slice). E2E browser
specs could not run in this sandbox (documented Chromium SIGSEGV at
launch; all 37 API specs pass) — confirm `yarn e2e` in a normal terminal.
