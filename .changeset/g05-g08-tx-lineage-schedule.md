---
"@ynab/server": patch
---

## YNAB4 transaction lineage + twice-a-month schedules (g05/g08)

Story: importing a `.y4backup` used to drop real per-row data —
check numbers, OFX lineage, and the second leg of twice-a-month
schedules vanished without a trace, and unknown schedule
frequencies silently became monthly. Six `transactions` columns now
persist the row-level fields (`check_number`, `fitid`, `ynab_id`,
`imported_payee`, `source`) and `recurring.second_anchor_day`
holds YNAB4's `twiceAMonthStartDay`; all of them round-trip through
the exporter. Separate nullable columns (not a JSON blob) so the
values stay queryable for future duplicate/OFX matching — matching
itself is still out of scope, the columns are only persisted.

Notes: YNAB4's import-match workflow (`accepted`,
`matchedTransactions`/`parentTransactionIdIfMatched`,
`dateEnteredFromSchedule`) is intentionally dropped — our match
workflow differs — but each now lands in `ImportSummary.warnings`
as an aggregated count instead of going silent, and the exporter's
hardcoded `accepted: true` is documented as deliberate for the
same reason. Unknown frequencies warn per distinct value before
falling back to monthly. The single-child scheduled-split collapse
is kept (a one-child split is not a valid split) but now warns
with a count. Migration `0028` adds the six columns.
