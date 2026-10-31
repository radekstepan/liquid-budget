---
"@ynab/logic": minor
"@ynab/ui": minor
---

## Spending report shows on-budget savings as still-held rows (task-52)

On-budget accounts (EQ Bank, chequing, savings, cash…) now draw still-held rows just like off-budget RRSP/TFSA accounts: same "Still held" group, same hatch, same chronological funding.

Notes: the held collection now covers all accounts (positive range net and positive range-end balance); credit cards carrying a balance stay excluded, and internal on-budget moves net across accounts so round-trips create no rows. With full partitioning the Remaining plug normally dissolves into per-account cash rows and survives only as a safety net on positive breaks; the header clamps allocator-epsilon Left dust to $0 and keeps real shortfalls on the existing Over path.
