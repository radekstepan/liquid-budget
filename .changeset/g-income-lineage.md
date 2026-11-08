---
"@ynab/server": patch
---

## Income attribution / lineage preservation (g-income-lineage)

Story: three YNAB4 income-lineage gaps are closed. Split imports now apply
first-inflow-child-wins per offset (`MonthlyBudget.as`
`isTransactionRelevantIncome`): only the offset of the first positive
non-transfer sentinel child counts, so a Deferred+Immediate split no longer
marks both legs income. The legacy wire names `__SupplementalIncome__` and
`__PrimaryIncome__` (`CategoryConstants.as:16-18`, resolved by
`OldVOToNewVOMarshaller.as:411-420`) classify exactly like
`__ImmediateIncome__` / `__DeferredIncome__` instead of falling through to
uncategorized, surface once in an aggregated import warning, and round-trip
verbatim. Paired transfers persist the dest leg's own memo + OFX lineage
(`transfer_memo/check_number/fitid/ynab_id/imported_payee/source`) and the
exporter prefers them for the fabricated dest leg (top-level and split
counterparts), falling back to the source side when null — which is exactly
the in-app/legacy state, so existing exports are byte-identical.

Notes: new nullable `transactions` columns (`income_category_raw` + six
`transfer_*`) via migration `0032_loud_paladin`; export consults the raw
sentinel only when the row has no real category (a categorized row always
wins, even with a stale sentinel). `updateTransaction` / `updateSplit` /
merge / bulk-edit clear the YNAB4-only columns when income-ness,
category, income month, or transfer-ness changes; split rewrites reset them
(fresh in-app authorship). Deliberate fork #6 (income-month superset) is
untouched — explicit `incomeMonth` overrides still honored everywhere.
Residual: dest-leg `flag` still mirrors the source on export (YNAB4 legs
carry independent flags; not asserted by any repro).
