---
"@ynab/logic": patch
"@ynab/ui": patch
---

## Sankey income through-color (task-15)

The Spending sankey no longer splits each flow into two colored segments at
the middle column. Every ribbon now keeps its income source's color all the
way from the left source, through the middle category group, to the right
subcategory or merchant targets: a brown SAP Concur ribbon stays brown past
the blue Wants bar instead of turning blue halfway.

Each middle-to-target ribbon is subdivided into one sub-ribbon per income
source (in income order at both ends), so the bands tile their cell exactly
and values still conserve per income through the middle. Hovering a
sub-ribbon reads as its income flowing into the target ("Payroll →
Groceries", via Bills) and spotlights the whole through-line — income bar,
left ribbon, group, sub-ribbon, and target — while the rest dims.

Notes: task-14 behavior is unchanged (tiny income bars still show the name
only below 26px; ribbons still hold the income color through the midpoint,
then settle into a darker shade of the same hue). Remaining plug, Other
buckets, and the Uncategorized pseudo-group behave as before. `yarn
typecheck` and the `@ynab/logic` / `@ynab/ui` suites pass; `yarn e2e` was
not run in the sandboxed agent session (Chromium headless shell SIGSEGVs at
launch there — see AGENTS.md) — run `yarn e2e` in a normal terminal to
confirm.
