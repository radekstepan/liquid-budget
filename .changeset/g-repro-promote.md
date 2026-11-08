---
"@ynab/logic": patch
"@ynab/server": patch
---

## Promote YNAB4 repro files to tracked regression tests (g-tests)

The twelve `repro-*` test files (seven in `@ynab/logic`, five in
`@ynab/server`) are now tracked regression coverage instead of untracked
repro scratch. Each file pins YNAB4-parity behavior whose src fix already
landed (overspend mapping, twice-a-month phase, scheduled post ids,
money-strict, scheduled splits, income lineage, hidden mangle,
transfer prefix, split penny, search status, autofill, rename learning);
only stale `REPRO ONLY` headers, `repro:` suite labels, and since-fixed
`FAILS today` comments were rewritten — no assertion, import, or test
logic changed.
