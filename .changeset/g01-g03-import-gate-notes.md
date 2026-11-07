---
"@ynab/server": patch
"@ynab/logic": patch
"@ynab/web": patch
---

## YNAB4 version gate + account note passthrough (g01-g03)

Story: importing a `.y4backup` from a YNAB4 older than 2.6 (or a
legacy/foreign file with no `fileMetaData`) used to misparse silently,
wiping the ledger with garbage. The importer now rejects those backups
at the zip boundary with a clear error before touching the database,
warns when the data version predates 4.2.0 or the archive carries
multi-device `devices/`/`Snapshots/` sync state, and preserves YNAB4
account notes into `accounts.notes` (the column already existed but was
never written).

Notes: `extractYnab4DataFromZip` throws on missing/unparseable or
pre-2.6 `budgetDataVersion`; `importYnab4` enforces the same floor for
versioned data (before the wipe) and reports notices via the new
`ImportSummary.warnings` (added in `@ynab/logic`). Archive-level
warnings flow extract → import via a new optional `ImportYnab4Options`.
Our own exporter now stamps `fileMetaData.budgetDataVersion: 4.2.0` so
its zips pass the gate. `account_type_raw` preservation is explicitly
out of scope (later task). E2E backup fixture gained `fileMetaData`.
