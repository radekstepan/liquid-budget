---
"@ynab/server": patch
"@ynab/web": patch
---

## YNAB4 budget settings persistence (g02)

Story: importing a `.y4backup` with a non-US locale (e.g. cs_CZ, comma
decimal, koruna) used to drop every locale/currency setting — the
importer parsed `.ybsettings` into `ImportSummary.settings` but stored
nothing, and the exporter hardcoded `en_US`/`Personal`/`TRUE`. Budget
settings now live in a new `settings` key-value table (migration
`0026`): the six `.ybsettings` fields (`currencySymbol`,
`currencyISOSymbol`, `decimalSeparator`, `groupSeparator`, `dateFormat`,
`budgetName`) plus the `.ynab4` root `budgetMetaData` (`budgetType`,
`currencyLocale`, `dateLocale`, `strictBudget`, overlapping
`currencyISOSymbol`). The exporter writes stored values back (explicit
options still win) and only falls back to the stock defaults when
nothing was imported.

Notes: `ynabData.budgetMetaData` is threaded through `importYnab4`
alongside the XML parse (explicit `ImportYnab4Options.budgetMetaData`
wins, otherwise the document root is read directly); the `/api/import`
route and both CLI entry points forward the extracted metadata.
`resetDatabase` wipes `settings` so re-imports never leave stale keys.
`parseYnab4SettingsXml` no longer trims whitespace-only tags to empty,
so a space group separator survives. `settings` in the import summary
stays `undefined` when the backup carried no settings at all.
