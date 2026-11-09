---
"@ynab/web": patch
---

## Fix virtualized-row assertions in register search e2e specs

The `register-filter` and `transactions` specs compared the DOM row count
before applying a search filter with the count after clearing it. The register
virtualizes rows, so the DOM only holds the visible window and its size changes
once the container's `ResizeObserver` reports — the same ledger could read 42
rows before the filter and 26 after clearing it. Both specs now compare the
summary bar's stable domain transaction count and assert the first row is
rendered again.

Notes: test-only change, no product behavior changed.
