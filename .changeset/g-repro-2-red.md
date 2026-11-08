---
"@ynab/logic": patch
"@ynab/server": patch
---

## New YNAB4 repro tests, currently failing (g-tests-2)

Thirteen `repro-*` files (seven in `@ynab/logic`, six in
`@ynab/server`) pinning the next round of YNAB4-parity gaps: fuzzy OFX
match, merge cleared-max, rename operator parity, schedule calendar
edges, split-parent income multijump, CC-buffer self-overspend, malformed
CSV, account mappings, autofill seeding, scheduled zero legs,
reconciled-row mutation, snapshot-restore versioning, LLM failure modes.
All fail on current code by design; src fixes to follow, one task each.
