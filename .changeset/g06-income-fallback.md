---
"@ynab/logic": patch
---

## G06: income fallback on-budget check

Story: `isIncomeTransaction` without an `accountMap` used to blanket-return `false` for any transfer row and treat any positive uncategorized row as income with no on-budget check, so off-budget inflows counted as income whenever callers omitted the map.

Notes: the fallback transfer path now routes through `classifyBoundaryTransfer` with best-effort on-budget defaults (unknown accounts assumed on-budget, same as the map path), and an explicit `isIncome` flag always wins in the fallback path. Non-transfer fallback keeps positive-uncategorized-as-income but documents that callers with account data must pass the map. Audited all `isIncomeTransaction` callers in `packages/`: every production caller (`budget-engine`, `reports`, `sankey`, server `diagnostics`) already passes an `accountMap`, so no caller changes were needed.
