# Oracle parity index — ynab4-modern (191 tests) → this repo

Behavior reference: observed YNAB4 file-format and budgeting behavior (see notes below).
Reference model: `../ynab4-modern` (TS model of YNAB4 behavior, Flex stripped, deviations in file headers).
This repo model difference: flat `BudgetData` + integer-cent strings (`packages/logic/src/types.ts`) + SQLite, vs modern entity graph + `Number` float + `DateWithoutTime`. Adapt amounts, not semantics.
Deliberate forks here (mark `// FORK:`): CC buffer (`budget-engine.ts:31-55`), Pre-YNAB-Debt non-port, incomeMonth superset, exact-only matching, case folding — see `.planning/codebase/INTEGRATIONS.md`.

## How to work through it (repeatable)

Each batch = one subagent session. Prompt: `Work batch BX in docs/oracle-parity-index.md: read the modern port + .test.ts, write packages/logic/tests/oracle-bx-<name>.test.ts against packages/logic/src/*, adapting float→cents. Keep yarn test + typecheck green.`
Order: B1 → B2 → B3 → B4 → B5 → B6. B7–B9 only on demand (store infra / app chrome / UI chrome mostly out of scope for this repo).

| Batch | Modern tests | This-repo target | Priority |
|---|---|---|---|
| B1 budget-math | 11 domain Monthly* + OverspendingHandling + CalculationUtilities | `packages/logic/src/budget-engine.ts`, `types.ts` | P0 |
| B2 transactions | 9 transactions/* (Base, Matchable, Matched, Transaction, Sub*, TransactionList, comparers, Scheduled) | `transfers.ts`, `split.ts`, `recurring.ts`, `register.ts`, `merge.ts` | P0 |
| B3 accounts-balances | Account, AccountList, AccountBalanceCalculator, AccountMapping(+Manager), AccountType, ClearedStatus, validation/AccountRules | `reconcile.ts`, `register.ts`, `server/src/queries/accounts.ts` | P0 |
| B4 categories-payees | Category, MasterCategory(+List), SubCategory, entityLists, hiddenCategories, smallEntities, Payee(+Location/Manager), AutoFillData, StringCondition, PayeeSettingsDialogPresentationModel | `rename-rules.ts`, `payee-autofill.ts`, `rename-suggest.ts`, `server/.../payees.ts`, `categories.ts` | P1 |
| B5 utils-enums | Currency/Math/QuickBudget/Transfer/StringUtilities, DateWithoutTime, ErrorLevel/ErrorState, enums (TransactionFlag/Source/Frequency/YNABEntityType), VO, framework/SyncableEntity | `format.ts`, `reports.ts` helpers, `csv-import.ts` date/amount parsing | P0 |
| B6 io-import-export | importerCSV/OFX/QIF, exporterCSV/QIF, unmarshaller, version, fileAccessor, budgetSession | `packages/logic/src/csv-import.ts`, `packages/server/src/import-ynab4/*`, `export-ynab4.ts` | P1 |
| B7 store | framework/* (Bridge, ChangeTracker, ClassNameMapper, Composite, errors, guid, IdentityMap, ObjectContext/Set, Serialization, SyncableEntity/VO, uid) + ynab/* (BudgetMetaData, hydration, saveChanges, sets, ClassNameMapper, EntityContext, Bridge, SyncableEntity, VOContext) | mostly N/A (SQLite replaces entityFramework); use `hydration`/`saveChanges`/`sets` semantics for `server/src/queries/*` invariants | P2 |
| B8 app-reports | MBudget/MRegister/RegisterFilter/RegisterSearchItem/registerGrid, reports providers (ChartColorMap, FilterSelection, HOReportDataRow, HOSortedMonthly, MBaseReport, NetWorth, P&L, ReportSettings/Utilities, SpendByCategory/Payee, SpendingTrends, reportExportCsv/Request, reports, controllers/*, managers, signals, MSidebar/MGlobal/HOAccountViewState/dateFormats/prefs | `packages/logic/src/reports.ts`, `search.ts`, `searchQuery.ts`, `recurring.ts` | P1 |
| B9 ui-chrome | ui/budget/* (8), register/* (23), dialogs/* (8), reports/* (14), startup/* (2), components/* (2), styles, host/startupLocales | `packages/ui/*` spot-checks only (calculatorEngine, suggestSelection, parseBudgetedInput/registerDate, overspending pill) | P3 |

## B1 budget-math → `budget-engine.ts` (P0)

Reference: YNAB4 monthly-budget behavior. Model: `../ynab4-modern/packages/domain/src/Monthly*.ts`.
Adapt: `priorBalance + budgeted - spent`, `recalcPriorBalance` clamp, `overspendingHandling` inherit (explicit ?? prev ?? AffectsBuffer), float→cents.

- `domain/src/MonthlySubCategoryBudget.test.ts` — id scheme, observed-list filter matrix, shouldAddSubTransaction edges, spent/budgeted/balance/priorBalance + NaN throws, rollover matrix (prev ± × Confined/AffectsBuffer/inherit/null), listener swap, inheritance + cache, createFromVO, VO round-trip.
- `domain/src/MonthlyMasterCategoryBudget.test.ts` — aggregation sums, carried-only-AffectsBuffer core, UPDATE fast path vs full rescan, ADD/REMOVE recalc, findOrCreate idempotence, zeroOut, dispose.
- `domain/src/MonthlyMasterCategoryBudgetList.test.ts` — update rename→remove+add, OUTFLOW-only filter, internal-master skip, Uncategorised factory rule, find/removeAndDispose, listen fan-out.
- `domain/src/MonthlySubCategoryBudgetList.test.ts` — update add/remove + Uncategorised factory, findBySubCategory, deleteEntity veto (+clearData), removeAndDispose slice-copy, UPDATE synthesis.
- `domain/src/MonthlyBudget.test.ts` — first-of-month guard, master seeding + composite view, buffer formulas (carried-negative, deferred in/out, supplemental), income offsets (Current/NextMonth, splits, null-offset filter), moveMoney, prev/next guards + waiting-leaf cascade, incremental diffs.
- `domain/src/MonthlyBudgetList.test.ts` — addItem chain (prepend/append/duplicate/sparse), transaction-driven creation, creation clamps (pre-2000, far-future), getOrCreate, first/last month, onBudget recalcBudgets, re-parenting, suspend/resume, freshStart, remove guards.
- `domain/src/MonthlyUncategorisedMasterCategoryBudget.test.ts` — createSubCategoryData override, aggregation.
- `domain/src/MonthlyUncategorisedSubCategoryBudget.test.ts` — filterTransaction matrix (null/off-budget/onBudget read/split/isUncategorised), observed-view wiring.
- `domain/src/OverspendingHandling.test.ts` — two singletons, toString/name, getEnumByName exact/ci/cs, null/empty/unknown→null.
- `domain/src/CalculationUtilities.test.ts` — idle-immediate, re-entrant FIFO drain, finally-reset on throw.
- `domain/src/vo/vo.test.ts` (budget half) — Monthly VO field names, JSON round-trip, defaults.

## B2 transactions → `transfers/split/recurring/register/merge` (P0)

Reference: YNAB4 transaction behavior. Model: `../ynab4-modern/packages/domain/src/transactions/*.ts`.

- `transactions/BaseTransaction.test.ts` — targetAccount/text interplay, eligibility warn-and-ignore, amount rounding + inflow/outflow, whatErrorStateShouldIHave matrix, suspension + one-hop propagation, isUncategorised branches, sub removal + veto, reciprocal break, VO round-trip.
- `transactions/MatchableTransaction.test.ts` — ctor pinning + DefaultDate aliasing, account/date/source guards, UserEntered downgrade refusal, YNABID/FITID→Imported, Reconciled auto-accept, checkNumber trim, transfer payee round-trip, targetAccount→payee re-emit.
- `transactions/MatchedTransaction.test.ts` — parent pinning, parentTransactionIfMatched write-once guard, cloneFrom (MT/{parent}/MatchedTransaction/{orig} + fresh sub-ids), populateFromVO/VO, createFromVO pattern.
- `transactions/Transaction.test.ts` — entityType + compareTransactionDates, matched-pair ordering, accepted clearing + exactly-once mirror-accept (no ping-pong), needsAcceptance truth table, setRunningBalance no-ops, setMatchedTransactions.
- `transactions/SubTransaction.test.ts` — date/account delegation + orphan throw, parent write-once guard, createFromVO/clone/suspend-resume, error bubbling, contentsEqual quirk, populateVO/FromVO + deferred transfer.
- `transactions/SubTransactionList.test.ts` — parent getter, identity index, sumOfSubTransactions rounding, category === matching, clone/equals, transfer scan first-match.
- `transactions/TransactionList.test.ts` — TRANSFER CORE + MATCHING + BULK: addItemAt null-account throw, removeItemAt quirk + teardown, suspend/resume/underflow, 3-way creation/change/removal flows, sub-partition flows, UPDATE sniff, matching/bulk paths.
- `transactions/transactionComparers.test.ts` — combo-chain order, every compareBy* direction + nulls, check-number matching, 10/60-day windows, transfer eligibility.
- `transactions/ScheduledTransaction.test.ts` — ctor defaults, createScheduledTransactionFromTransaction, getNext/PreviousOccurrence all 13 frequencies (TwiceAMonth ±15/clamp/rollover/throw, Unexpected frequency), getNumOccurrencesInRange.

## B3 accounts-balances → `reconcile/register` (P0)

- `domain/src/Account.test.ts` — ctor defaults, all-accounts aliasing, partitioned sources, rename side effect, onBudget cascade clone, isAllAccounts throw, debt/asset flags, VO round-trip.
- `domain/src/AccountBalanceCalculator.test.ts` — static date-filtered snapshot (cleared/uncleared/reconciled + working sum), ctor full recalc, incremental add/remove, running-balance + post-removal reseed, cleared/amount UPDATE replay, suspend/resume refcount, verbatim error strings.
- `domain/src/AccountList.test.ts` — sortable-index ordering, balance buckets (hidden/on/offBudget, assets/liabilities/netWorth), finders (name ci/null/allAccounts, id), adjacency/tab order, add/remove/delete guards, moveExistingItem.
- `domain/src/AccountMapping.test.ts` — ctor order, isAllAccounts guard verbatim, isEqual, matchesAccount, createFromFullValues (null/empty→null, salt, last-4, SHA-256/Base64 vector), createFromSecureValues, createFromVO.
- `domain/src/AccountMappingManager.test.ts` — exact/soft find, mapAccount create/reuse/null-bank no-op, soft-entry eviction, REMOVE/RESET null-out-missing.
- `domain/src/AccountType.test.ts` — eleven singletons, isAssetAccount/isRecommendedOnBudget, getEnumByName exact/ci/cs.
- `domain/src/ClearedStatus.test.ts` — U/C/R labels, positions, integer values.
- `domain/src/validation/AccountRules.test.ts` — empty/duplicate/backtick/valid paths, verbatim messages.

## B4 categories-payees → `rename-rules/payee-autofill` (P1)

- `domain/src/Category.test.ts` — Category + ICategory + CategoryType: name trim, OUTFLOW default, deleteable, sortableIndex int truncation, note cleanup, VO round-trip (type as string), toString.
- `domain/src/MasterCategory.test.ts` — expanded/isBudgetable defaults, entityType, createFromVO arg order, hidden-master deleteable=false, verbatim empty-name throw, VO type fallback, ReadAggregateChildren gate.
- `domain/src/MasterCategoryList.test.ts` — built-ins, name guard, sort/order, isSpecial/getNthNonSpecial, findByName, add/remove/delete, hide/unhide, pre-YNAB-debt find/create/rename, bulk renames, full-name switch.
- `domain/src/SubCategory.test.ts` — parent wiring + fullName/displayName/exportName, rename/re-parent refresh, null-name, isHidden incl. null-context, hidden-master mangled names, equals/compareTo, populateFromVO.
- `domain/src/entityLists.test.ts` — SubCategoryList finders + null-query quirk; TransactionsByAccountPartitioner isolation + createIfDoesntExist + backfill; live add/remove.
- `domain/src/hiddenCategories.test.ts` — HiddenCategoryDescriptor, MangledHiddenNameComponents round-trip + verbatim throws, HiddenSub/Master descriptors + lists.
- `domain/src/smallEntities.test.ts` — interfaces conformance, SplitSubCategory isSplit, InflowMonthOffset/InflowSubCategory/SplitSubCategory edges.
- `domain/src/Payee.test.ts` — transfer/non-transfer ctor, 30 reserved import payees verbatim sorted, deterministic transfer ids, transfer-aware setters, lazy fillData/transactions/locations, addConditions, rule matching.
- `domain/src/PayeeLocation.test.ts` — defaults, assign-if-different incl. NaN!==NaN, createFromVO + throws, re-parenting, VO round-trip.
- `domain/src/PayeeManager.test.ts` — transfer synthesis (missing create/stale delete, rename/hidden push), discovery (new payee, case-rename queue+flush, :294-306 stale-var bug), updateListsWithPayee membership.
- `domain/src/AutoFillData.test.ts` — culture-rounded amount + inflow/outflow, getSettingsFromTransaction order, applyToImported/applyToNew guards + verbatim same-target throws + split veto, sub-list cleanup.
- `domain/src/StringCondition.test.ts` — StringCondition + StringOperator: identity/names/labels, getEnumByName, evaluate matrix (Is/Contains/StartsWith/EndsWith, ci, null/blank guards, unknown throw), equals, createFromVO, VO round-trip.
- `app/src/reports/PayeeSettingsDialogPresentationModel.test.ts` — PM selection states, counts, names, chrome.

## B5 utils-enums → `format/csv-import/reports` helpers (P0)

- `domain/src/utils/CurrencyUtilities.test.ts` — roundBasedOnCulture digits table, safeAdd/safeSubtract rounding. Note fork: here integer cents; port table as `num()` expectations + repro-rounding-characterization.
- `domain/src/utils/MathUtilities.test.ts` — round table/NaN, clamp helpers.
- `domain/src/utils/QuickBudgetUtilities.test.ts` — current-month step-back, valid-history counting with gaps, average-outflow walking. Target: any quick-budget/goal logic.
- `domain/src/utils/StringUtilities.test.ts` — replaceAll/trim/isNullOrEmpty edges used by note/payee paths.
- `domain/src/utils/TransferUtilities.test.ts` — transfer classification core. Target: `transfers.ts:classifyBoundaryTransfer`.
- `domain/src/DateWithoutTime.test.ts` — YYYY-MM-DD round-trip, month-end clamp, day-0 idiom, ordering, year pivot, MM/DD/YY parse. Target: date handling in `recurring.ts`, `csv-import.ts`, `budget-engine:getMonthsWithData`.
- `domain/src/ErrorLevel.test.ts` / `ErrorState.test.ts` — ranks/colors, null→None coercion. Target: register error-state display.
- Enums: `TransactionFlag.test.ts` (7 singletons + int values), `TransactionSource.test.ts` (3 + int values), `ScheduledTransactionFrequency.test.ts` (13 frequencies), `YNABEntityType.test.ts` (all type names).
- `domain/src/framework/SyncableEntity.test.ts` (domain seam half: findParentGuaranteeExists + throws).

## B6 io-import-export → `csv-import/server/import-ynab4` (P1)

- `io/src/importerCSV.test.ts` — from ImporterCSV + ImportUtilities/DateWithoutTime.parseDate/CurrencyUtilities: build/apply/assignYNABIDs. Target: `packages/logic/src/csv-import.ts` + `server/.../import-csv`.
- `io/src/importerOFX.test.ts` — from ImporterOFX + OFXLineReader/TagAndValue/StringDateOFX. Target: OFX phase in `server/src/import-ynab4/phases/ofx.ts`.
- `io/src/importerQIF.test.ts` — from ImporterQIF. Target: QIF handling if any, else document as not-imported.
- `io/src/exporterCSV.test.ts` — separators/quoting/currency/date formatting, register/budget/report text, splits, CSV→entities→CSV round-trip. Target: `server/src/export-ynab4.ts`.
- `io/src/exporterQIF.test.ts` — buildQIFAccountExport, formatQIFAmount/Date, nullToEmptyString.
- `io/src/unmarshaller.test.ts` — minimal root, nested/matched/tombstoned/scheduled/transfer topology, legacy key renames, defaults, version gates verbatim. Target: `server/src/import-ynab4/*` (shared/phases/lineage/versions/amounts).
- `io/src/version.test.ts` — parse, clamping, toString joining, numeric compare, FileMetaDataVO constants.
- `io/src/fileAccessor.test.ts` — falsy omission replacer matrix, toJSON parity (key set, duplicated masterCategories, absent payeeLocations, tab indent, NaN), canLoadFileName, save/load round-trip.
- `io/src/budgetSession.test.ts` — open/hydrate/isDirty/save/saveIfNecessary/±13-month window/freshStart/dispose over real `.ynab4` text. Target: snapshot/restore + diagnostics invariants in `server/tests/invariants.test.ts`.

## B7 store → N/A except semantics (P2)

Framework: `store/src/framework/{Bridge,ChangeTracker,ClassNameMapper,CompositeObjectSet,errors,guid,IdentityMap,ObjectContext,ObjectSet,Serialization,SyncableEntity,SyncableVO,uid}.test.ts`.
YNAB: `store/src/ynab/{BudgetMetaData,hydration,saveChanges,sets,YNABClassNameMapper,YNABEntityContext,YNABEntityToYNABVOBridge,YNABSyncableEntity,YNABVOContext}.test.ts`.
Action: do not port; use `hydration` (mini-budget ordered hydration, out-of-order VOs, transfer linkage after endBulkUpdate, tombstones, missing-payee repair, strict-budget/null-type fixups, freshStart) and `sets` (payee blank/transfer guards, monthly-budget delete veto, sub-budget clearData veto, scheduled enterDue sweep, rename-conflict resolution) as invariant specs for `server/src/queries/*`. `guid` deterministic schemes useful for `import-ynab4/lineage.ts` id stability.

## B8 app-reports → `reports/search/recurring` (P1)

- Providers: `NetWorthDataProvider` (workingBalance math, selection gate, recalculateData columns, exportColumns side effect), `ProfitAndLossDataProvider` (dirty gate, income payee rows + [No Payee], 2-month accumulation + unselected skip, split fan-out + uncategorised fallback, category gate), `SpendByCategoryDataProvider` (internal/income skips, hidden-last, safeSubtract accumulation, split fan-out + dedupe, childRows nulling, untouched sweep), `SpendByPayeeDataProvider` (ALL_PAYEES gate, blank row first-only-when-used, percent fill, sorting), `SpendingTrendsDataProvider` (income/internal/empty skips, Change cells, linked prev-month deltas, transactionsDictionary), `HOReportDataRow` (ignored-average quirk, month cells, prev/change branches), `HOSortedMonthlyCategories`, `MBaseReport`, `ReportSettings` (find-or-create + objects↔names round-trip), `ReportUtilities`, `ChartColorMap`, `FilterSelection`. Target: `packages/logic/src/reports.ts` (already has reports.test.ts + reports-gaps.test.ts — extend, don't duplicate).
- Export: `reportExportCsv` (BOM/header, verbatim cells, row/child walk, separators/quoting), `reportExportRequest` (verbatim file-name template, blank-header→Category, month framing). Target: `server/src/export-ynab4.ts` if reports export lands.
- Register/search: `MRegister`, `RegisterFilter` (search/date gate order, reconciled-hiding tail, verbatim resetCount), `RegisterSearchItem` (parseSearchString matrix, placeholder merging, decimal-comma preprocessor, AND-wrapper). Target: `search.ts` + `searchQuery.ts` (+ existing search.test.ts / searchQuery.test.ts).
- Controllers/managers (port only the pure grammar, skip wiring): NetWorth/SpendByCategory/SpendByPayee/SpendingTrends/ProfitAndLoss report controllers (summary grammars, sort, drill-down guards, scoping), RegisterSearchController (performSearch pipeline, cancelSearch, date/recon/amount math), ReportsController (selection routing, dirty-gated refresh order, filter handlers), SidebarController + MSidebar, MGlobal/Signals, CurrencyManager/SettingsManager/dateFormats/NodePreferences/HOAccountViewState/MBudget/registerGrid. Target: spot-check against `server` queries + `ui` behavior; most are app-chrome, not logic parity.

## B9 ui-chrome → spot-checks only (P3)

`ui/budget` (autoSuggest, autoSuggestList, budgetGridData, overspending, parseBudgetedInput, tabTravel, useBudgetGrid, useBudgetMonth), `ui/register` (23 files: dropdowns, submenus, addBar/addNewTransaction, bulkActions, dateSelector, parseRegisterDate, recurringActions, footer/rowData/selectedTotal/selection/sort, requestSplit, scheduled*, showFilteredView, splitCommit/Remainder, transferPair), `ui/dialogs` (8), `ui/reports` (14), `ui/startup` (licensing, recentBudgets), `ui/components` (calculatorEngine, suggestSelection), `host/startupLocales`, `ui/styles`.
Action: only lift pure rules already proven useful — `calculatorEngine` (operator/memory/error semantics), `suggestSelection`, `parseBudgetedInput`/`parseRegisterDate`, `splitRemainder` (`calcSplitRemainder`), `overspending` pill grammar, `tabTravel`, `dateSelectorData` ranges — into existing `packages/logic` or `packages/ui/tests` equivalents. Skip React adapters (use* hooks) and verbatim chrome.
