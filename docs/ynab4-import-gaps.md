# YNAB4 Import Gaps

Date: 2026-11-07. Scope: what our `.y4backup` importer drops or distorts
relative to real YNAB4 (`4.3.855`), and how to fix it.

Reference material (sibling project, read-only, lives outside this repo):

- Decompiled app: `/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/`
- Domain port (partial): `/home/radek/dev/ynab4/ynab4-modern/packages/domain/src/`
- Sibling notes: `/home/radek/dev/ynab4/ynab4-swf-analysis/README.md`,
  `ynab_file_index.txt`, `/home/radek/dev/ynab4/ynab4-modern/SCOPE.md`,
  `PROGRESS.md`, `README.md`

Our code (this repo):

- Importer: `packages/server/src/import-ynab4.ts`
- Exporter: `packages/server/src/export-ynab4.ts`
- Schema: `packages/server/src/schema.ts`
- Import API: `apps/web/src/app/api/import/route.ts`
- Import summary types: `packages/logic/src/duplicates.ts` (`ImportSummary`, `ImportSkippedEntry`)
- Import tests: `packages/server/tests/import-ynab4*.test.ts`,
  `apps/web/tests/e2e/import.spec.ts`

How to re-check anything below: each gap lists exact source paths on both
sides plus a grep/spot-check an agent can rerun. General entry points:

```sh
# our side — what the importer touches
rg -n "checkNumber|FITID|YNABID|importedPayee|accepted|dateEnteredFromSchedule|matchedTrans|accountMapping|payeeLocation|renameCondition|autoFill|extraData|fileMetaData|strictBudget|twiceAMonth" packages/server/src/import-ynab4.ts
rg -n "entryName|ybsettings|ymeta|devices|snapshot" packages/server/src/import-ynab4.ts

# YNAB4 side — persisted field lists (getters = serialized JSON keys)
rg -n "public function get" "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/PayeeVO.as"
rg -n "public function get" "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/MatchableTransactionVO.as"
```

Top-level YNAB4 document shape (`YNABRootVO.as:18-36`):
`fileMetaData, budgetMetaData, masterCategories, transactions,
scheduledTransactions, accounts, monthlyBudgets, accountMappings, payees,
payeeLocations`. Our importer consumes: `accounts, payees,
masterCategories>subCategories, transactions>subTransactions,
scheduledTransactions, monthlyBudgets>monthlySubCategoryBudgets,
reconciliations` (non-stock, see G-09), `*.ybsettings`. It ignores:
`fileMetaData, budgetMetaData, accountMappings, payeeLocations`.

---

## G-01 — Zip/package entries beyond `.ynab4` + `.ybsettings` are ignored

Severity: medium (silent version risk) / low (sync state).

YNAB4 source:

- `dataAccess/YNAB4FileAccessor.as:54-82` — `saveFileExtension=".ynab4"`,
  load = `FileStream.readUTFBytes` → `JSON.parse` →
  `UntypedToYNABRootVOMarshaller`.
- `dataAccess/dropbox/PackageManagerDropbox.as:408-420,660-695`,
  `dropbox/SnapshotUtilities.as`, `SnapshotFileMetaData.as` — real budgets
  on disk are a package: `Budget.ymeta` pointer + `devices/` sync diffs +
  `Snapshots/`. `.y4backup` is the exported zip of that package.
- `ynabData/vo/FileMetaDataVO.as:13-51` — `CURRENT_DATA_VERSION=4.2.0`,
  `VERSION_THAT_*` migration constants (nested entities 2.1–2.3,
  payees-as-IDs 2.5, sorted cats 2.7 / accounts 3.0, fileMetaData 4.0,
  transfer-payee IDs 4.1.1, accountMappings sync 4.1.2, bank IDs removed
  4.2.0); rejects `<2.6`. `currentKnowledge:VersionVector` tracks Dropbox
  sync.

Our behavior (`import-ynab4.ts:183-206`): iterate zip entries, keep the
first `*.ynab4` text and first `*.ybsettings` text; throw only when no
`.ynab4` exists. Everything else (`Budget.ymeta`, `devices/*`,
`Snapshots/*`, `.ydeviceinfo`) silently ignored. No `budgetDataVersion`
check — a pre-2.6 or legacy-XML backup (`dataAccess/*Legacy*`,
`OldVOToNewVOMarshaller`) would misparse without an error.

Recheck:

```sh
rg -n "zipEntries|entryName|ynab4|ybsettings" packages/server/src/import-ynab4.ts
sed -n 1,60p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/FileMetaDataVO.as"
sed -n 1,60p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/YNABRootVO.as"
```

Fix:

1. After `JSON.parse`, read `ynabData.fileMetaData?.budgetDataVersion`;
   reject (clear error) when missing or `<2.6`, warn when `<4.2.0`.
2. Optionally warn (in `duplicatesSkipped`/summary) when the zip contains
   `devices/` or `Snapshots/` entries, so multi-device exports are visible.
3. Tests: unit test `extractYnab4DataFromZip` + version gate with synthetic
   zips (see `packages/server/tests/import-ynab4-zip.test.ts` pattern);
   include a `<2.6` fixture expecting rejection.

## G-02 — `budgetMetaData` parsed nowhere, settings persisted nowhere

Severity: medium (locale/currency formatting lost).

YNAB4 source: `ynabData/vo/BudgetMetaDataVO.as` — `budgetType,
currencyISOSymbol, currencyLocale, dateLocale, strictBudget`
(`BudgetType.as`: Personal/Business).

Our behavior:

- `parseYnab4SettingsXml` (`import-ynab4.ts:139-156`) extracts
  `currencySymbol, currencyISOSymbol, decimalSeparator, groupSeparator,
  dateFormat, budgetName` from `.ybsettings`.
- `importYnab4` (`:1661-1675`) puts the result into
  `ImportSummary.settings` (`packages/logic/src/duplicates.ts:104-111`).
- `api/import/route.ts:17-27` passes `settingsXml` through and returns the
  summary as JSON. `schema.ts` has no settings/locale table, so nothing is
  stored; formatting/locale is lost on every import.
- Mirror problem: `export-ynab4.ts:168-176` hardcodes
  `currencyLocale/dateLocale=en_US, strictBudget=TRUE, budgetType=Personal`.

Recheck:

```sh
rg -n "settings|currency|dateFormat|budgetName" packages/server/src/import-ynab4.ts
rg -n "budgetMetaData|strictBudget|budgetType|currencyLocale|dateLocale" packages/server/src/*.ts
sed -n 1,30p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/BudgetMetaDataVO.as"
```

Fix:

1. Decide where settings live: either a new `settings` key-value table (or
   reuse snapshots metadata) storing at least `currencySymbol,
   currencyISOSymbol, decimalSeparator, groupSeparator, dateFormat,
   budgetName` + `budgetMetaData { budgetType, currencyLocale, dateLocale,
   strictBudget }` from the `.ynab4` JSON root.
2. Thread `ynabData.budgetMetaData` through `importYnab4` alongside the
   `.ybsettings` parse (currently only the xml is passed).
3. Stop hardcoding export metadata; write back stored values.
4. Tests: round-trip test — import fixture with non-US locale, assert stored
   settings; export test asserts the values reappear.

## G-03 — Account types collapsed 11 → 3; `note` and `lastEnteredCheckNumber` dropped

Severity: medium (type fidelity) / low-medium (`note` — column already exists).

YNAB4 source: `ynabData/vo/AccountVO.as` fields —
`accountName, hidden, lastReconciledDate, lastReconciledBalance,
sortableIndex, lastEnteredCheckNumber (default -1), onBudget, accountType,
note`. `enums/AccountType.as`: Checking, Savings, CreditCard, Cash,
LineofCredit, Paypal, MerchantAccount, InvestmentAccount, Mortgage,
OtherAsset, OtherLiability.

Our behavior (`import-ynab4.ts:261-285,371-385`): `kind = credit` only for
CreditCard/LineofCredit, else `liquid` if on-budget else `offbudget`.
Investment/Mortgage/asset-liability distinctions are unrecoverable, and
re-export guesses (`export-ynab4.ts:179-201`: liquid→Checking,
credit→CreditCard, offbudget→InvestmentAccount). `sortableIndex→sort` and
`hidden/closed/isClosed→archived` survive; `acc.note` is never written even
though `accounts.notes` exists (`schema.ts:26`, migration `0022`).
`lastEnteredCheckNumber` has no column.

Recheck:

```sh
rg -n "accountType|accKindMap|groupLabel|archived|notes" packages/server/src/import-ynab4.ts
sed -n 8,30p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/AccountVO.as"
```

Fix:

1. Cheap: map `acc.note` into `accounts.notes` on insert (one line + test).
2. Type fidelity: add `accounts.account_type_raw` (or similar) preserving the
   verbatim YNAB4 string; keep `kind` for app logic; export prefers the raw
   value when present.
3. `lastEnteredCheckNumber`: only worth a column if check-number support
   (G-05) is ever built; otherwise document as intentionally dropped.
4. Tests: fixture with InvestmentAccount + note; assert raw type + notes
   survive import and re-export.

## G-04 — Payees: `enabled` ignored, autofill partial, rename rules + locations dropped

Severity: high (rename rules are user data) / medium (rest).

YNAB4 source: `ynabData/vo/PayeeVO.as` — `name, enabled (=true),
targetAccountId, autoFillCategoryId, autoFillMemo, autoFillAmount (=0),
renameConditions[] (aggregate child), locations[] (aggregate child)`;
`StringConditionVO.as` (`operator, operand, parentPayeeId`); top-level
`payeeLocations[]` (`YNABRootVO.as:36`); `PayeeLocationVO` (lat/long).

Our behavior (`import-ynab4.ts:235-243,1279-1350`):

- Name-only import; `enabled=false` (hidden/disabled) payees imported as
  normal; `targetAccountId` transfer payees skipped by design (modeled as
  `transferAccountId`) — acceptable but undocumented.
- `autoFillCategoryId` backfilled in §5b (verbatim when resolvable, else
  history-majority fallback requiring ≥3 uses and outright majority).
  `autoFillMemo/Amount` dropped.
- `renameConditions` never mapped into our `rename_rules` table (zero
  references in `import-ynab4.ts`; table defined `schema.ts:237-254`).
  `locations`/`payeeLocations` dropped.

Recheck:

```sh
rg -n "payeeDbIdMap|autoFill|enabled|rename|location" packages/server/src/import-ynab4.ts
rg -n "public function get" "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/PayeeVO.as"
```

Fix:

1. Persist `enabled` — add `payees.enabled`/`archived` flag (migration +
   import mapping + export `enabled:`).
2. Map `autoFillMemo/Amount` if a payee-autofill feature exists; otherwise
   record as dropped in this doc.
3. Import `renameConditions→rename_rules`: map YNAB4 `StringCondition`
   operators to our `source_pattern` semantics; unmapped operators go to
   `duplicatesSkipped`-style warnings, never silent. Needs operator audit
   first (`StringConditionVO.as` + `data/StringCondition.as`).
4. `locations`: drop deliberately (no maps feature) but note it.
5. Tests: payee fixture with disabled payee + rename conditions + autofill;
   assert flag/defaults/rules.

## G-05 — Transactions: six per-tx fields dropped (`checkNumber`, OFX lineage, schedule link, match state)

Severity: medium (check users, OFX re-import) / low (match workflow).

YNAB4 source: `BaseTransactionVO.as` (`targetAccountId,
transferTransactionId, categoryId, amount, checkNumber, memo`) extends to
`MatchableTransactionVO.as` (`accepted, accountId, FITID, YNABID, cleared,
date, dateEnteredFromSchedule, flag, importedPayee, payeeId, source,
subTransactions[], parentTransactionIdIfMatched`) and `TransactionVO.as`
(`matchedTransactions[]`).

Our behavior: keeps date/payee/memo/amount/cleared→`u/c/r`/flag/reconciliation
links/transfer pairing (transfer legs null `payeeId`, `:1058`). Drops with no
column and no warning: `checkNumber`; `FITID/YNABID/importedPayee/source`
(all OFX lineage — re-importing the same OFX file later can't dedupe);
`dateEnteredFromSchedule`; `parentTransactionIdIfMatched/matchedTransactions`
(the import-match workflow `data/MatchedTransaction.as`,
`MatchableTransaction.as`); `accepted` (export hardcodes `true` at
`export-ynab4.ts:405,445,488,509,541,621`).

Recheck:

```sh
rg -n "checkNumber|FITID|YNABID|importedPayee|dateEnteredFromSchedule|matchedTrans|accepted|source" packages/server/src/import-ynab4.ts packages/server/src/schema.ts
sed -n 1,45p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/MatchableTransactionVO.as"
```

Fix:

1. Add `transactions.check_number` (nullable text) and import/export it —
   small, self-contained.
2. Add OFX-lineage columns (`fitid, ynab_id, imported_payee, source`) or a
   single `import_meta` JSON column; use in duplicate/OFX matching later.
3. `matchedTransactions`: document as intentionally dropped
   (our match workflow differs); do not silently claim fidelity.
4. Tests: transaction fixture carrying all six fields; assert checkNumber +
   lineage survive, match fields reported as skipped.

## G-06 — Splits: zero legs filtered, zero-sum parents skipped

Severity: low-medium (rare, but silent data loss).

YNAB4 source: splits are full children (`SubTransactionVO`,
`parentTransactionId`, `SplitSubCategory`/`InflowSubCategory` markers).

Our behavior (`import-ynab4.ts:667-680,702-713`): legs with converted amount
0 are filtered (`nonZeroSubs`); parents with no nonzero legs are skipped
("Zero-amount split transaction"); parents whose legs net to 0 are skipped
("Zero-sum split transaction"). Only a `duplicatesSkipped` entry remains.
`Category/__Split__` markers become `categoryId=null` + `isIncome` heuristic
(`:1191-1214`).

Recheck: read `import-ynab4.ts:663-740` and compare with
`vo/SubTransactionVO.as` field list.

Fix: import zero legs verbatim (they are valid rows); only skip parents with
literally no non-tombstone children. If zero-sum parents break balance math,
fix the math, not the import. Test: split with a 0 leg + zero-sum parent
fixture.

## G-07 — Monthly budgets: notes + explicit-zero/empty months dropped

Severity: low-medium.

YNAB4 source: `MonthlyBudgetVO.as` (`month, note, monthlySubCategoryBudgets`
aggregate child); `MonthlySubCategoryBudgetVO.as` (`categoryId,
parentMonthlyBudgetId, note, budgeted, priorBalance, overspendingHandling`).
`overspendingHandling` handled correctly on our side (`:476-477, :527-528`
→ `overspendCarriesOver`).

Our behavior (`:556-582`): writes `assignments` only when
`budgeted != 0 && budgeted != null`. Months with no nonzero budgets create
nothing (YNAB4 distinguishes empty vs `hasRealData==false` months);
`MonthlyBudget.note` and per-category `note` dropped (no columns);
explicit-zero budgets indistinguishable from absent ones.

Recheck:

```sh
rg -n "monthlyBudgets|monthlySubCategoryBudgets|budgeted|overspendingHandling" packages/server/src/import-ynab4.ts | head -30
sed -n 10,25p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/MonthlyBudgetVO.as"
sed -n 10,25p "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/MonthlySubCategoryBudgetVO.as"
```

Fix: add note columns (`assignments.note` and/or month-level memo) or record
as dropped; import explicit-zero budgets when the month exists in YNAB4
(i.e. iterate months present, not only nonzero rows). Test: month with notes
+ explicit zeros.

## G-08 — Scheduled transactions: `twiceAMonthStartDay` lost, unknown frequencies silently become monthly

Severity: medium for twice-a-month users; low otherwise.

YNAB4 source: `ScheduledTransactionVO.as:9-11` — `frequency:String,
twiceAMonthStartDay:int` (+ all `Matchable` fields); frequency enum in
`enums/ScheduledTransactionFrequency.as`.

Our behavior (`import-ynab4.ts:1542-1602`): normalizes frequency strings,
falls back to `"monthly"` for anything unrecognized (`:1575-1576`) with no
warning; maps `anchorDay` but never reads `twiceAMonthStartDay`, so the
second leg of twice-a-month schedules is mistimed; `active` defaults `true`;
single-child scheduled splits collapse to plain rows (`:1483-1514`).

Recheck:

```sh
sed -n 1540,1610p packages/server/src/import-ynab4.ts
rg -n "twiceAMonth|frequency" "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/ynabData/vo/ScheduledTransactionVO.as"
```

Fix: persist a `second_anchor_day` (or `twice_a_month_start_day`) on
`recurring`; map it in import/export; surface unknown frequencies as
warnings instead of silent monthly. Test: twice-a-month + unknown-frequency
fixtures.

## G-09 — Reconciliations are synthesized; YNAB4 has no such entity

Severity: medium (imported history looks more reconciled/precise than source).

YNAB4 source: no `Reconciliation` entity in `YNABEntityType.as`; only
`AccountVO.lastReconciledDate/Balance` plus register-side
`reconciliationTargetDate/TransactionList` (`model/MRegister.as:47,267`,
`view/register/dialogs/ReconciliationStatementDialog.as`).

Our behavior (`import-ynab4.ts:258-259,279-430`): reads
`ynabData.reconciliations[]` when present — stock YNAB4 never writes this
array (only our own exporter does, `export-ynab4.ts:631-645`) — otherwise
synthesizes reconciliation rows from cleared flags / last-reconciled fields
(`:295-369`, including summing reconciled rows as a balance fallback
`:363-367`). `adjustmentTransactionId` is always null on import and export.

Recheck:

```sh
sed -n 258,300p packages/server/src/import-ynab4.ts
rg -n "reconciliations" packages/server/src/import-ynab4.ts | head -20
rg -rn "reconciliationTargetDate" "/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/model/MRegister.as" | head
```

Fix: mark synthesized rows as such (or only create the account-level
`lastReconciledAt/Balance` and skip row synthesis for stock files); document
that `reconciliations[]` input is our own extension. Test: stock-shaped
fixture (no array) vs our-export-shaped fixture; assert no phantom precision.

## G-10 — `accountMappings` (OFX import config) entirely dropped

Severity: low (usually safe) but should be explicit.

YNAB4 source: `AccountMappingVO.as:10-26` — `fid, shortenedAccountId, hash,
salt, targetYNABAccountId, dateSequence, shouldFlipPayeesMemos,
shouldImportMemos (=true), skipImport`; `data/AccountMapping.as`,
`AccountMappingManager.as`, `dataAccess/importing/` (`ImportData,
ImportUtilities, OFXLineReader, StringDateOFX/QIF`, `ImporterCSV/OFX/QIF`).

Our behavior: `ynabData.accountMappings` never read. Safe to skip for budget
math, but `skipImport/shouldFlipPayeesMemos/shouldImportMemos` is user
config lost on round-trip (export also omits it).

Recheck:

```sh
rg -n "ccountMapping" packages/server/src/import-ynab4.ts packages/server/src/export-ynab4.ts
```

Fix: document as intentionally dropped; if OFX import is ever built, revisit
storing at least the three boolean preferences per account.

## G-11 — Round-trip losses even for our own data

Severity: low-medium (export→import fidelity).

`export-ynab4.ts` never writes, so re-import can never restore:
`rename_rules, duplicate_ignores, transactions.needs_review,
categories.goal_target, accounts.notes/groupLabel, payees.auto_category_id`.
Export also emits stubs (`accepted:true`, `isTombstone:false`,
`entityVersion`, hardcoded locales per G-02).

Recheck: `export-ynab4.ts:96-120` (query surface) vs `:640-677` (emitted
root keys); `schema.ts:12-263` table list.

Fix: after fixing G-02/G-04, add a round-trip test (import → export →
import, diff summaries) covering settings, rename rules, goal targets,
notes, needs-review. Decide per-field: persist through the format (needs
YNAB4-tolerable extension keys) or declare out-of-scope.

---

## Suggested fix order

1. G-01 version gate + G-03 `note` passthrough — tiny, prevents silent
   misparse.
2. G-02 settings persistence + export honesty — removes hardcoded locales.
3. G-04 rename-rules import — biggest real user-data win; needs operator
   audit first.
4. G-05 `checkNumber` + OFX lineage columns; G-08 `twiceAMonthStartDay`.
5. G-06/G-07/G-09 semantics — each needs a product decision before code.
6. G-10/G-11 — document, then round-trip test.
