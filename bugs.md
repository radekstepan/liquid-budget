# Codebase Audit & Bug Report

**Audit Date**: 2026-08-25 (revised 2026-08-25)
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

## Fix History

Twenty fixes (commits `dfc6dbf`–`40cf75c`) were applied before this audit. They addressed a prior bug list and use independent numbering. Relevant changes that affect findings below:

| Area | Fix |
|:---|:---|
| Budget engine | CC overhaul: `getCCAccountIds()` validates `kind === "credit"`, funded/unfunded spending separation, cash-advance tracking, `invalidateBudgetIndex(data)` exported and correctly clears cached index |
| Reconcile | State computation extracted to pure logic function; split parents excluded from aggregates |
| API | Empty PATCH returns existing row; only defined fields sent; category carryover null/0 normalized |
| CSV | `evalAmount()` handles `€£¥` and European decimal comma; text-month date formats supported |
| UI | Bulk-edit blocks reconciled rows; negative-zero display fixed; projections anchor to current month; calendar net-delta for transfers |

Of the 53 bugs listed below, 52 pre-date these fix commits (existed at `b210912` before any fix was applied). The only exception is BUG-05, where the fix commit `a75b02e` added `invalidateBudgetIndex()` but left the global no-argument path incomplete — this is an improvement over the prior state (no invalidation at all) rather than a regression.

## Executive Summary

The repository has broad automated coverage and all configured tests pass: 291 logic, 350 server, 365 UI, and 36 web/API. Coverage is weighted toward valid, sequential happy paths. The audit found issues that can change financial results, create invalid ledger structures, or make backup/restore non-lossless. The highest risks are non-atomic recurring posting, split/reconciliation state inconsistencies, mutable account classification, and incomplete YNAB4 roundtrips.

| Severity | Count | Primary Areas |
|:---|---:|:---|
| **High** | 26 | Budget engine, recurring writes, splits/transfers, reconciliation, imports, optimistic state |
| **Medium** | 25 | Parsing, reports, API validation, UI persistence/routing, database constraints |
| **Low** | 1 | CSV malformed-input diagnostics |
| **Code Quality** | 1 | Inconsistent API error normalization |

The test suite does not exercise concurrent HTTP mutations, failure between committed sub-operations, malformed calendar dates, backup field-by-field roundtrips, or corrupted persisted browser state.

## Detailed Bug Findings

### [BUG-01] Legacy databases fail normal startup when `__drizzle_migrations` table is absent
- **Severity**: High
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `packages/server/src/client.ts:76`; `packages/server/src/migrate.ts:37`; `packages/server/src/migrate-bootstrap.ts:62-64`
- **Description & Root Cause**: `bootstrapMigrationJournal()` handles two cases correctly: fresh installs (no `accounts` table) and already-migrated DBs (hashes present). For the legacy upgrade case — `accounts` exists but `__drizzle_migrations` table is absent — it returns `"noop"` (line 64) with a comment stating "Caller should call `migrate()` first, then call this again." Neither `getDefaultDb()` nor the `migrate.ts` CLI follows this two-step sequence; both call bootstrap once then `migrate()`. Drizzle creates `__drizzle_migrations` and then applies migration `0000`, which fails because `accounts` already exists.
- **Reproduction / Scenario**: Open a database produced by the old hand-written schema path with `accounts` present and no `__drizzle_migrations` table, then start the app or run the migration CLI.
- **Potential Impact**: Existing user data becomes inaccessible because the server cannot start or upgrade the database.
- **Recommended Resolution**: Have `bootstrapMigrationJournal()` create `__drizzle_migrations` and insert the 0000 row when it detects the legacy case, eliminating the two-step requirement. Test against a populated legacy database.

### [BUG-02] Manual async transactions can interleave on the shared SQLite connection
- **Severity**: High
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `packages/server/src/queries/transactions.ts`; `createTransaction()` and related mutations; analogous `BEGIN`/`COMMIT` blocks in account, category, assignment, recurring, reconcile, CSV, and YNAB4 import queries
- **Description & Root Cause**: Mutations start a connection-level transaction, then execute multiple awaited operations. Every await yields to the event loop while the transaction remains open on the singleton `better-sqlite3` connection. A second request can issue `BEGIN` on that same connection, or execute statements inside the first request's transaction. Some `BEGIN` calls occur before the try/catch, so a nested-BEGIN failure is not rolled back by that function.
- **Reproduction / Scenario**: Issue two mutation requests concurrently, or allow `/api/budget` auto-posting to run while a user mutation is in progress.
- **Potential Impact**: Spurious "transaction within a transaction" errors, ambiguous transaction ownership, failed requests, and possible rollback/commit of work belonging to another operation.
- **Recommended Resolution**: Serialize multi-statement mutations with a connection mutex, or use a synchronous transaction callback with no await boundaries. Add real-connection `Promise.all()` tests.

### [BUG-03] Reset and reseed are not atomic
- **Severity**: High
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `apps/web/src/app/api/reset/route.ts`; `packages/server/src/seed.ts`; `resetDatabase()` and `seedDatabase()`
- **Description & Root Cause**: Reset commits the database wipe before seed starts its own transaction. A failure during seed therefore cannot restore the old budget.
- **Reproduction / Scenario**: Invoke the reset endpoint and cause seeding to fail after `resetDatabase()` returns.
- **Potential Impact**: The original budget is already destroyed and the replacement database can be empty or partially populated.
- **Recommended Resolution**: Enclose wipe and reseed in one transaction, or make seed operate inside the caller's existing transaction. Test rollback after an injected seed failure.

### [BUG-04] Recurring posting can duplicate an occurrence or leave the schedule stale
- **Severity**: High
- **Status**: Unresolved
- **Category**: Recurring
- **Location**: `packages/server/src/queries/recurring.ts`; `postRecurringTransaction()` and `autoPostDueRecurringTransactions()`
- **Description & Root Cause**: Materialization calls `createTransaction()` or `createSplitWithChildren()`, each of which commits independently. Only afterward is `recurring.nextDate` and `active` updated. There is no conditional compare-and-update and inactive rows are not rejected by `postRecurringTransaction()`. Additionally, `autoPostDueRecurringTransactions()` posts items sequentially; if 3 of 5 items commit and the 4th fails, the first 3 are already persisted with no rollback.
- **Reproduction / Scenario**: Fail or interrupt the schedule update after the transaction insert, retry posting, or submit two post requests for the same recurring ID.
- **Potential Impact**: Duplicate ledger rows, duplicated account balance changes, and partial auto-post commits that cannot be rolled back.
- **Recommended Resolution**: Materialize and advance the schedule in one transaction with `WHERE id = ? AND next_date = ? AND active = 1`, and make retry behavior idempotent. Explicitly reject inactive rows.

### [BUG-05] Global budget-index invalidation can reload a stale serialized index
- **Severity**: High
- **Status**: Partially resolved — `invalidateBudgetIndex(data)` correctly clears both the WeakMap entry and `data.budgetIndex`. The global no-argument path still only replaces the WeakMap and cannot clear indexes on unreachable objects.
- **Origin**: Introduced by fix commit `a75b02e` (fix: bug 18). Before this commit there was no invalidation at all — the cache was a `const WeakMap` that was permanently stale after any mutation. The function was added but the global path was left incomplete. This is an incomplete improvement, not a regression.
- **Category**: Budget Engine
- **Location**: `packages/logic/src/budget-engine.ts:156-163`; `getOrBuildIndex()`
- **Description & Root Cause**: Before `a75b02e`, the budget-index cache was never invalidated — `getOrBuildIndex()` returned a permanently stale index after any mutation. Commit `a75b02e` added `invalidateBudgetIndex(data)`, which correctly clears both the WeakMap entry and `data.budgetIndex` for a specific object. However, `invalidateBudgetIndex()` (no argument) only replaces the WeakMap, so existing `BudgetData` objects still hold their serialized `budgetIndex` and the next computation hydrates the old index.
- **Reproduction / Scenario**: Compute and attach `data.budgetIndex`, mutate `data.assignments` or `data.transactions`, call `invalidateBudgetIndex()` without an argument, then call `computeBudget(data, month)`.
- **Potential Impact**: TBB, category availability, carryovers, CC buffers, and overspending remain stale after the caller believes the cache was invalidated.
- **Recommended Resolution**: Migrate all callers to use `invalidateBudgetIndex(data)`, which is already correct. Version attached serialized indexes as a safety net.

### [BUG-06] Negative opening category carryover is silently erased
- **Severity**: High
- **Status**: Unresolved
- **Category**: Budget Engine
- **Location**: `packages/logic/src/budget-engine.ts`; `computeAllMonths()` and `computePriorTBBSurplus()`
- **Description & Root Cause**: `currentBalance` is seeded from `category.carryover` (line 431), but `monthCashOverspent` is derived only from current-month cash transactions. If the initial carryover is negative and the first month has no spending, the row is clamped to zero without recording the deficit as overspending or TBB debt.
- **Reproduction / Scenario**: Set a non-CC category to `carryover: "-10000"`, disable `overspendCarriesOver`, and compute a first month with no assignment or transaction.
- **Potential Impact**: A persisted opening deficit disappears and the next month's TBB is overstated by 10000 cents.
- **Recommended Resolution**: Define opening negative carryover semantics explicitly and either carry the debt or record it as initial cash overspending that affects TBB.

### [BUG-07] Funded credit-card spending disappears when no payment category is linked
- **Severity**: High
- **Status**: Partially resolved — `getCCAccountIds()` (line 165-179) now validates `a.kind === "credit"` and the CC pass separates funded/unfunded spending. However, if a credit account has no valid `linkedAccountId` on any payment category, `ccBuffer = 0` (line 529) and the funded amount is still discarded.
- **Category**: Budget Engine
- **Location**: `packages/logic/src/budget-engine.ts`; `getCCAccountIds()` and the CC pass in `computeAllMonths()`
- **Description & Root Cause**: The non-CC pass calculates and stores funded CC spending by account, but the second pass can apply it only to a payment category with a matching `linkedAccountId`. If the link is absent or invalid, the funded amount is discarded.
- **Reproduction / Scenario**: Charge 10000 cents to a credit account in a funded category without a valid linked CC payment category.
- **Potential Impact**: The budget reserves no money for the funded card debt, breaking the cash/envelope invariant and understating the payment obligation.
- **Recommended Resolution**: Require every on-budget credit account to map to exactly one valid payment category, or provide an explicit unlinked-card debt bucket.

### [BUG-08] Duplicate CC payment links double-count one card buffer
- **Severity**: High
- **Status**: Partially resolved — `getCCAccountIds()` now validates `a.kind === "credit"`, preventing non-credit accounts from being classified as credit cards. The many-to-one mapping (two payment categories linked to the same account) remains possible.
- **Category**: Budget Engine
- **Location**: `packages/logic/src/budget-engine.ts`; `getCCAccountIds()`, `hydrateBudgetIndex()`, and `computeAllMonths()`; `packages/server/src/schema.ts`; `categories.linkedAccountId`
- **Description & Root Cause**: Two payment categories linked to the same card each receive the same `fundedCC + cardAdvance - cardPayment` buffer.
- **Reproduction / Scenario**: Create two CC-group categories with `linkedAccountId = 2`, then charge 10000 cents to account 2.
- **Potential Impact**: Reserved money is overstated.
- **Recommended Resolution**: Enforce a unique one-payment-category-per-credit-account invariant.

### [BUG-09] Bulk transaction update can create a self-transfer
- **Severity**: High
- **Status**: Unresolved
- **Category**: Splits & Transfers
- **Location**: `packages/server/src/queries/transactions.ts`; `bulkUpdateTransactions()`
- **Description & Root Cause**: Single-row updates reject changing a transfer's source account to its destination, but the bulk path does not. It reverses and reapplies balances and persists `account_id = transfer_account_id`.
- **Reproduction / Scenario**: Bulk-patch a transfer from account A to account B with `{ accountId: B }`.
- **Potential Impact**: Semantically invalid transfers enter the database and can confuse register views, reports, exports, later edits, and deletion logic.
- **Recommended Resolution**: Apply the same validation to bulk updates and add a database check that source and destination IDs differ.

### [BUG-10] Split-child amount edits are inconsistent and can corrupt the split
- **Severity**: High
- **Status**: Unresolved
- **Category**: Splits & Transfers
- **Location**: `packages/server/src/queries/transactions.ts`; `updateTransaction()` and `bulkUpdateTransactions()`
- **Description & Root Cause**: A single child edit updates the child and then validates against the unchanged parent, so a legitimate amount change fails unless another child is changed simultaneously. The bulk path updates the child and balance without re-totaling or validating the parent.
- **Reproduction / Scenario**: For a parent of -10000 with children -6000/-4000, change one child to -5000 through bulk update. The parent remains -10000 while children total -11000. The same change through single update is rejected.
- **Potential Impact**: Invalid split invariants, disagreement between parent-based exports and child-based balances, and future edits that fail unpredictably.
- **Recommended Resolution**: Make child amount changes an atomic full-split operation, either requiring complete replacement or re-totaling and validating the parent consistently in both paths.

### [BUG-11] Deleting a split child bypasses a reconciled parent lock
- **Severity**: High
- **Status**: Partially resolved — `bulkUpdateTransactions()` (lines 1157-1165) now checks parent reconciliation status when updating children, and `bulkDeleteTransactions()` checks for reconciled children (lines 1097-1101). However, the child-deletion path in `deleteTransaction()` does not check the parent's status; a child of a reconciled parent can still be deleted individually.
- **Category**: Reconcile
- **Location**: `packages/server/src/queries/transactions.ts`; `deleteTransaction()`
- **Description & Root Cause**: Child deletion checks the child's own status but not the parent's status. A reconciled parent can have an uncleared child because reconciliation flips the parent without consistently handling children.
- **Reproduction / Scenario**: Create a split with a cleared parent and uncleared child, reconcile the account so the parent becomes `r`, then delete the child individually.
- **Potential Impact**: A reconciled split can be re-totaled or otherwise modified after reconciliation, invalidating the locked round.
- **Recommended Resolution**: Reject all child mutations when the parent is reconciled, and define one consistent parent/child reconciliation policy.

### [BUG-12] Reconciliation calculates its difference before locking the state
- **Severity**: High
- **Status**: Unresolved
- **Category**: Reconcile
- **Location**: `packages/server/src/queries/reconcile.ts`; `reconcileAccount()`
- **Description & Root Cause**: `getReconcileState()` and adjustment validation run before `BEGIN` (line 135). A cleared transaction can be inserted or edited before the later flip and account update, but the adjustment amount was calculated from the old working balance.
- **Reproduction / Scenario**: Read the reconcile state, add or edit a cleared transaction in the same account before the write phase, then reconcile against the original statement.
- **Potential Impact**: The adjustment closes an obsolete difference and the account can be marked reconciled while its final cleared/reconciled balance does not match the statement.
- **Recommended Resolution**: Begin a transaction before reading the aggregate, and perform validation, adjustment, status changes, and metadata update against one snapshot.

### [BUG-13] Split parent reconciliation status is inconsistent with reconciliation aggregates
- **Severity**: High
- **Status**: Partially resolved — `getReconcileState()` now excludes split parents from aggregate queries (line 73: `NOT IN (SELECT parent_id...)`). However, the status-flip query in `reconcileAccount()` (lines 163-177) still updates every cleared row including split parents, so counts still diverge.
- **Category**: Reconcile
- **Location**: `packages/server/src/queries/reconcile.ts`; `getReconcileState()` and `reconcileAccount()`
- **Description & Root Cause**: Aggregate queries exclude split parents, but the status-flip query updates every cleared row, including split parents. The returned count therefore includes rows that did not contribute to the working balance, and parent/child statuses can diverge.
- **Reproduction / Scenario**: Reconcile a split whose parent is cleared but one child is uncleared.
- **Potential Impact**: The UI and database disagree about what was reconciled; the parent becomes locked while a child remains mutable, enabling BUG-11 and confusing later unreconciliation.
- **Recommended Resolution**: Exclude split parents from both counts and flips, or reconcile the complete split as one atomic unit with matching counts.

### [BUG-14] Imported reconciled rows cannot reliably be unreconciled
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-ynab4.ts`; reconciled transaction insertion; `packages/server/src/queries/reconcile.ts`; `unreconcileAccount()`
- **Description & Root Cause**: The importer sets imported rows to `status = 'r'` and copies each transaction date into `reconciledAt`, but creates no `reconciliations` row and leaves `reconciliationId` null. The fallback unreconcile branch matches only the account's one `lastReconciledAt` date or a null timestamp.
- **Reproduction / Scenario**: Import several reconciled YNAB4 transactions with different dates and an account last-reconciled date, then undo the last reconciliation.
- **Potential Impact**: Older imported rows remain permanently locked while account reconciliation metadata is cleared.
- **Recommended Resolution**: Import a real reconciliation round and assign its ID, or provide a precise import reconciliation mode. Never clear round metadata while leaving matching rows locked.

### [BUG-15] Changing account budget participation invalidates transaction semantics
- **Severity**: High
- **Status**: Unresolved
- **Category**: Budget Engine
- **Location**: `packages/server/src/queries/accounts.ts`; `updateAccount()`; `packages/logic/src/budget-engine.ts`; `isIncomeTransaction()`; `apps/web/src/app/api/schemas.ts`; `AccountPatchSchema`
- **Description & Root Cause**: The API permits changing `onBudget` and `kind` by updating only the account row. Existing transactions retain persisted `isIncome`, category, and transfer semantics. A positive off-budget starting-balance transaction has `isIncome = false`; changing the account to on-budget makes its balance budget-relevant without adding it to income/TBB. Kind and on-budget can also become contradictory.
- **Reproduction / Scenario**: Create an off-budget account with a positive starting balance, then PATCH `onBudget: true`; or change a credit account to off-budget without reclassifying its transactions.
- **Potential Impact**: Budget integrity and TBB become wrong, and credit-card classification can change retroactively.
- **Recommended Resolution**: Disallow boundary/type changes after transactions exist, or run an explicit atomic reclassification and recomputation operation.

### [BUG-16] Category carryovers and CC payment assignments are lost in YNAB4 roundtrip
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/export-ynab4.ts`; category and monthly-budget export; `packages/server/src/import-ynab4.ts`; category and assignment import
- **Description & Root Cause**: The exporter does not emit the application's `categories.carryover`. It does emit assignments for internal CC payment categories, but omits the internal CC group from exported master categories. The importer then has no `categoryIdMap` entry for those assignments and silently skips them.
- **Reproduction / Scenario**: Export a budget with nonzero category opening carryovers or assignments to CC payment categories, then import the backup.
- **Potential Impact**: Available balances and TBB change after restore even though the backup appears to contain the budget.
- **Recommended Resolution**: Define a complete mapping for internal categories, deliberately omit their assignments consistently, and persist application-only carryover metadata in a supported companion format.

### [BUG-17] Scheduled transaction metadata is lost during YNAB4 roundtrip
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/export-ynab4.ts`; scheduled export; `packages/server/src/import-ynab4.ts`; scheduled insertion
- **Description & Root Cause**: Export writes scheduled `memo`, `flag`, and inactive state as a tombstone. Import skips all tombstoned schedules and inserts active schedules without mapping memo or flag. The `never` frequency is also not handled by `formatFrequency()` and falls back to Monthly.
- **Reproduction / Scenario**: Pause a recurring item or create one with a memo/flag, export, then import. Also export an active `never` schedule before it is posted.
- **Potential Impact**: Paused schedules disappear, notes/flags disappear, and one-off schedules can become monthly schedules.
- **Recommended Resolution**: Preserve inactive rows as inactive, map all scheduled fields, and roundtrip one-off frequency explicitly. Add field-by-field scheduled fixture tests.

### [BUG-18] Deferred income month is truncated to the following month
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/export-ynab4.ts`; transaction income-category mapping; `packages/server/src/import-ynab4.ts`; deferred income mapping
- **Description & Root Cause**: Export represents any future `incomeMonth` only as `Category/__DeferredIncome__`. Import reconstructs that marker as `nextMonthKey(transaction month)`, losing the original month when income was deferred by more than one month.
- **Reproduction / Scenario**: Create a transaction dated June with `incomeMonth = "2026-09"`, export, and import.
- **Potential Impact**: Income enters TBB two months early after restore, changing historical and future budget results.
- **Recommended Resolution**: Persist the exact deferred month in an extension/metadata field or use a lossless application backup format.

### [BUG-19] Invalid calendar dates are accepted at API boundaries and normalized inconsistently
- **Severity**: High
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `apps/web/src/app/api/schemas.ts`; date regex schemas; `packages/logic/src/format.ts`; `nextDateFor()`, `addDaysISO()`, and `adjustDateShortcut()`
- **Description & Root Cause**: Schemas validate only `YYYY-MM-DD` shape, not calendar validity. JavaScript Date normalizes inputs such as `2026-02-31` instead of rejecting them. Recurring action routes also pass date strings without schema validation.
- **Reproduction / Scenario**: Create a transaction or recurring entry with `2026-02-31`, or call recurring post/autopost with an invalid date. `nextDateFor("monthly", "2026-02-31", 31)` can advance from the normalized March date to April.
- **Potential Impact**: Invalid dates enter the ledger; lexicographic reconciliation/autopost comparisons are wrong; scheduled months can be skipped.
- **Recommended Resolution**: Use one strict round-trip ISO date/month validator at API, domain, import, and deep-link boundaries.

### [BUG-20] Malformed CSV amounts are silently partially parsed
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts`; `parseAmount()`
- **Description & Root Cause**: `Number.parseFloat()` accepts a valid numeric prefix without requiring the complete normalized input to match a supported grammar.
- **Reproduction / Scenario**: Import `12abc`, `123.45 USD`, `1,23,4`, or `1-`. Values such as `12abc` become 1200 cents and retain no row error.
- **Potential Impact**: Corrupted bank data silently changes balances and duplicate identities.
- **Recommended Resolution**: Validate the entire normalized amount with an explicit grammar, including separator placement, and reject unsupported suffixes.

### [BUG-21] Re-importing a split or transfer can create a duplicate transaction
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-csv.ts`; existing fingerprint construction; `packages/logic/src/duplicates.ts`; `findDuplicateGroups()`; `packages/ui/src/CsvImportModal.tsx`
- **Description & Root Cause**: Existing split parents, children, and transfers are all excluded from the import fingerprint set. A plain incoming bank row has no structural metadata, so it cannot match the original parent or transfer.
- **Reproduction / Scenario**: Import a bank row, convert it to a split or transfer, then import the same statement again.
- **Potential Impact**: A second ordinary transaction is created and the account balance is overstated.
- **Recommended Resolution**: Separate generic structural duplicate grouping from import identity matching. Permit a plain incoming row to match an exact split parent or transfer, preferably using a durable bank transaction ID.

### [BUG-22] Duplicate fingerprints collide when fields contain the delimiter
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/duplicates.ts`; `duplicateFingerprint()`
- **Description & Root Cause**: Fingerprint fields are joined with `|` without escaping or length-prefixing.
- **Reproduction / Scenario**: `(payee="Store|Branch", memo="Lunch")` and `(payee="Store", memo="Branch|Lunch")` produce the same fingerprint.
- **Potential Impact**: A legitimate transaction can be flagged or skipped as a duplicate, causing silent import data loss.
- **Recommended Resolution**: Encode the tuple unambiguously, for example with JSON or length-prefixed fields.

### [BUG-23] Conflicting exact rename rules make explicit renames ineffective
- **Severity**: High
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/rename-rules.ts`; `learnRenameRule()` and `applyRenameRules()`; `packages/server/src/queries/transactions.ts`; rename learning after update
- **Description & Root Cause**: Learning `BCF1 -> New` when `BCF1 -> Old` exists appends a second exact rule. Exact rules are sorted only by exact-vs-pattern, so the older rule wins.
- **Reproduction / Scenario**: Rename one transaction from BCF1 to Old, later rename BCF1 to New, and import another BCF1 row.
- **Potential Impact**: The user's latest rename is ignored and the rule set contains contradictory behavior.
- **Recommended Resolution**: Enforce one normalized exact source mapping, replace conflicting rules, or define deterministic newest-rule-wins semantics.

### [BUG-24] Successful mutations can be rolled back in the UI after reload failure
- **Severity**: High
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `apps/web/src/components/BudgetAppShell.tsx`; mutation handlers and `reload()` calls
- **Description & Root Cause**: A successful write and its follow-up GET are in one try/catch. If the write commits but GET `/api/budget` fails, the catch restores the pre-write snapshot and reports failure.
- **Reproduction / Scenario**: Make POST/PATCH return 200, then make the following budget reload fail.
- **Potential Impact**: The server contains the transaction/category/recurring change while the UI hides it. Retrying can create duplicates, and users receive a false failure message.
- **Recommended Resolution**: Separate write failure from refresh failure, retain confirmed optimistic state, or refetch before allowing retry. Use idempotency keys where an outcome is uncertain.

### [BUG-25] Out-of-order budget reloads can replace current state with stale data
- **Severity**: High
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `apps/web/src/components/BudgetAppShell.tsx`; `reload()` and mutation handlers
- **Description & Root Cause**: Every reload unconditionally calls `setData()` when its response arrives. There is no generation, cancellation, or serialized refresh ordering.
- **Reproduction / Scenario**: Submit two mutations quickly and arrange for the second refresh response to arrive before the first refresh response.
- **Potential Impact**: Newer saved values can disappear, deleted rows can reappear, and a later edit can overwrite server state from a stale UI snapshot.
- **Recommended Resolution**: Serialize mutation/refresh operations or ignore responses older than the latest request generation.

### [BUG-26] Split status changes update only the visible parent row
- **Severity**: High
- **Status**: Unresolved
- **Category**: Splits & Transfers
- **Location**: `packages/ui/src/BudgetApp.tsx`; `cycleStatus()`; `apps/web/src/components/BudgetAppShell.tsx`; `updateTransaction()`
- **Description & Root Cause**: The register displays a split parent, but cycling its status sends a patch for only the parent. The server does not propagate status to children; the shell's optimistic propagation handles date, not status.
- **Reproduction / Scenario**: Click the cleared/uncleared indicator on a split parent.
- **Potential Impact**: Parent and children show different statuses, while reconciliation aggregates children and excludes the parent. The visible state no longer represents the rows used for accounting.
- **Recommended Resolution**: Treat split status as one atomic parent/child operation and use the same status model in register, reconciliation, and locking.

### [BUG-27] Negative dollar-to-cent rounding is asymmetric and floating-point sensitive
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `packages/logic/src/format.ts`; `dollarsToCents()`; dollar conversion sites in `packages/ui/src/Modals.tsx`, `BudgetView.tsx`, and `ReconcileModal.tsx`
- **Description & Root Cause**: `Math.round(d * 100)` rounds negative half values toward positive infinity and binary floating-point representation introduces additional errors.
- **Reproduction / Scenario**: `dollarsToCents(-1.005)` returns -100 rather than the intended nearest-cent result -101 under symmetric rounding; `1.005` can similarly round down.
- **Potential Impact**: User-entered transactions, assignments, goals, and reconciliation balances can differ by one cent.
- **Recommended Resolution**: Parse decimal strings or use decimal arithmetic; alternatively reject more than two fractional digits.

### [BUG-28] CSV `parseAmount()` rejects euro/pound/yen currency symbols while `evalAmount()` accepts them
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts:211`; `parseAmount()` vs `packages/logic/src/format.ts:72,109`; `evalAmount()`
- **Description & Root Cause**: `evalAmount()` strips `$€£¥` but `parseAmount()` only strips `$`. A quoted accounting value such as `€123.45` fails during CSV import but passes in manual entry forms.
- **Reproduction / Scenario**: Import a valid European or British bank CSV containing `€123.45` or `£123.45`.
- **Potential Impact**: Valid transactions are skipped as invalid during import, reducing imported account balances.
- **Recommended Resolution**: Unify currency symbol handling between `parseAmount()` and `evalAmount()`. Support parenthesized negative values consistently.

### [BUG-29] Description plus Memo CSV columns lose the real memo
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts`; header classification in `parseCsvImport()`
- **Description & Root Cause**: `Description` is recognized as a memo alias before the actual `Memo` column. When both exist, the real Memo column is ignored; the fallback then promotes Description to payee and clears the memo index.
- **Reproduction / Scenario**: Import `Date,Description,Memo,Amount` with `Whole Foods,Weekly groceries,-5.00`.
- **Potential Impact**: Notes are silently lost and duplicate matching becomes less reliable.
- **Recommended Resolution**: Give payee aliases precedence or resolve Description/Memo candidates deterministically.

### [BUG-30] Invalid dates influence CSV date-format detection
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts`; `detectDateFormat()`
- **Description & Root Cause**: Numeric voting checks only whether a component exceeds 12. It counts calendar-invalid rows such as `31/02/2026` as DMY evidence.
- **Reproduction / Scenario**: Mix invalid `31/02/2026` with valid MDY rows and ambiguous rows; the invalid row can determine the convention and make valid dates parse incorrectly.
- **Potential Impact**: Valid transactions receive wrong dates or are rejected, affecting month budgets and reports.
- **Recommended Resolution**: Validate candidate dates under each convention before counting votes; surface ambiguity when evidence is insufficient.

### [BUG-31] CSV swap mode can import blank payees
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts`; `swapPayeeMemo()` and `parseCsvImport()`; `packages/server/src/import-csv.ts`
- **Description & Root Cause**: Required-field validation occurs before swapping. A row with payee `Store` and empty memo passes validation, then becomes payee empty/memo Store. The server does not revalidate the swapped result.
- **Reproduction / Scenario**: Import a row with an empty Memo and enable Swap payee/memo.
- **Potential Impact**: Imported transactions have no usable payee, harming search, duplicate detection, and user review.
- **Recommended Resolution**: Swap before validation or validate again after swapping, with an explicit fallback/rejection policy.

### [BUG-32] HTTP CSV import is all-or-nothing despite lower-layer partial-import behavior
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `apps/web/src/app/api/import/csv/route.ts`; `POST`; `packages/server/src/import-csv.ts`; `importCsvTransactions()`
- **Description & Root Cause**: The parser/importer can collect invalid rows in `skipped`, but the HTTP route rejects the entire file when any parsed row has an error. The UI presents rows as skippable, so the layers disagree.
- **Reproduction / Scenario**: Submit one valid row and one invalid amount row.
- **Potential Impact**: One malformed bank row blocks all valid imports.
- **Recommended Resolution**: Choose an explicit all-or-nothing or partial policy and align route, importer, and UI messaging. Return row-level skip details if partial import is intended.

### [BUG-33] Duplicate analysis can keep a mutable row and ignore a reconciled duplicate
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/duplicates.ts`; `findDuplicateGroups()`; `packages/server/src/queries/duplicates.ts`; `analyzeUnflaggedDuplicates()`
- **Description & Root Cause**: Rows are sorted by ID and the first is always keeper. Locked handling is applied only to duplicates, never to the keeper. If the older ID is mutable and the newer ID is reconciled, the mutable row is kept and no actionable row is flagged.
- **Reproduction / Scenario**: Create identical mutable ID 1 and reconciled ID 2, then analyze duplicates.
- **Potential Impact**: The duplicate feature leaves the removable row unmarked and can encourage deletion of the wrong copy.
- **Recommended Resolution**: Prefer reconciled rows as keepers, then use deterministic ordering, or classify every group member before flagging.

### [BUG-34] Rename rules can bypass duplicate protection after a new rule is added
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-csv.ts`; existing/incoming fingerprint construction; `packages/logic/src/rename-rules.ts`
- **Description & Root Cause**: Existing rows are fingerprinted using their stored raw payee, while incoming rows are fingerprinted after applying rename rules. A rule added after a transaction was imported changes only the incoming fingerprint.
- **Reproduction / Scenario**: Existing row payee is `BCF1`; add rule `BCF1 -> BC Ferries`; re-import the same raw row.
- **Potential Impact**: The row is inserted again and the balance is overstated.
- **Recommended Resolution**: Compare raw and canonical fingerprints or persist the raw import identity separately.

### [BUG-35] Identical legitimate transactions in one CSV batch are silently dropped
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-csv.ts`; `batchSeen` and `existingFingerprints`
- **Description & Root Cause**: The fingerprint contains no source-row ID or bank transaction ID. Every later row with the same account/date/amount/payee/memo is skipped as a duplicate.
- **Reproduction / Scenario**: Import two same-day identical transit or vending charges.
- **Potential Impact**: Legitimate transactions are omitted and the account balance is understated.
- **Recommended Resolution**: Use bank-provided IDs where possible, or surface ambiguous identical rows for confirmation instead of automatically dropping them.

### [BUG-36] Monthly insight averages omit zero-spend months
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Reports & Analytics
- **Location**: `packages/logic/src/reports.ts`; `computeMonthlyInsights()`
- **Description & Root Cause**: The three-month average divides by `mMap.size`, which counts only months having at least one transaction. Months with zero spending must still be part of a three-month baseline.
- **Reproduction / Scenario**: Spend 30000 cents in one of the previous three months and zero in the other two; the computed average is 30000 instead of 10000.
- **Potential Impact**: Trend percentages and spending alerts are materially understated or overstated.
- **Recommended Resolution**: Initialize all three prior months to zero and always divide by three, or document a nonzero-month average with a different label.

### [BUG-37] Spending constituent percentages are misleading for negative net totals
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Reports & Analytics
- **Location**: `packages/logic/src/reports.ts`; `computeSpendingTrends()`; `packages/ui/src/SpendingTrendsReport.tsx`
- **Description & Root Cause**: `pctOfTotal` divides signed constituent values by signed `overallTotal`. Refunds exceeding spending can make a positive spender show -100% and a refund show 200%.
- **Reproduction / Scenario**: One group contributes +10000 and another -20000, producing overall total -10000.
- **Potential Impact**: The UI presents percentages that do not represent intuitive spending shares.
- **Recommended Resolution**: Define gross, absolute, or signed-contribution semantics and suppress/rename the metric when net total is non-positive.

### [BUG-38] Reconciliation foreign-key references are unenforced
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `packages/server/src/schema.ts`; `transactions.reconciliationId` and `reconciliations.adjustmentTransactionId`; migration `0003_add_reconciliations_table.sql`
- **Description & Root Cause**: Both reference columns are plain integers without foreign keys. `unreconcileAccount()` tolerates a missing adjustment row and still deletes the reconciliation record.
- **Reproduction / Scenario**: Delete or alter an adjustment transaction through direct SQL/recovery tooling, then unreconcile the account.
- **Potential Impact**: Orphan links and unreversed adjustment balances make reconciliation metadata disagree with the ledger.
- **Recommended Resolution**: Add foreign keys with explicit delete policy and fail loudly or repair balances when a referenced adjustment is missing.

### [BUG-39] Balance recomputation is not atomic
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Register & Balance
- **Location**: `packages/server/src/queries/diagnostics.ts`; `recomputeAccountBalances()`
- **Description & Root Cause**: The function reads accounts, performs separate outgoing/incoming sum queries, and updates each account without a transaction. A mutation can commit between a sum and its update.
- **Reproduction / Scenario**: Run the diagnostic recomputation concurrently with transaction creation/edit/deletion.
- **Potential Impact**: The repair operation can overwrite a newer balance with a stale value.
- **Recommended Resolution**: Use one transaction/consistent snapshot and preferably a single aggregate update statement.

### [BUG-40] Migration 0009 dropped nonzero amount constraints
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `packages/server/src/migrations/0005_closed_dazzler.sql`; amount checks; `packages/server/src/migrations/0009_mean_vindicator.sql`; rebuilt tables; `packages/server/src/schema.ts`
- **Description & Root Cause**: Migration 0005 created nonzero checks for transactions and recurring tables, but migration 0009 rebuilt those tables without copying the checks. The current schema and `assertValidAmount()` also permit zero.
- **Reproduction / Scenario**: Submit a zero transaction, zero recurring amount, or zero split child through the API/current schema.
- **Potential Impact**: Meaningless ledger rows and zero children can be persisted, weakening split invariants and complicating reports/duplicate handling.
- **Recommended Resolution**: Restore checks through a migration and reject zero at the application boundary consistently.

### [BUG-41] Updating a recurring split with an empty child array leaves a stale single entry
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Recurring
- **Location**: `packages/server/src/queries/recurring.ts`; `normaliseInput()` and `updateRecurring()`
- **Description & Root Cause**: `subTransactions: []` is not considered a split, but the update path deletes existing recurring children because the key is present. It leaves the old parent amount and usually a null category, converting the schedule into an unintended uncategorized single transaction.
- **Reproduction / Scenario**: PATCH an existing recurring split with `subTransactions: []`.
- **Potential Impact**: Future postings lose their categories/transfer legs while retaining the old aggregate amount.
- **Recommended Resolution**: Reject empty arrays or define an explicit atomic conversion to a valid single recurring entry.

### [BUG-42] Recurring action endpoints bypass runtime validation and lie about counts
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `apps/web/src/app/api/recurring/route.ts`; post/autopost/bulk-post/bulk-update/bulk-delete branches
- **Description & Root Cause**: Only ordinary create/update payloads use Zod. Action branches manually coerce IDs and dates, accept malformed values, and bulk update returns `ids.length` even when `updateRecurring()` returns null for nonexistent IDs.
- **Reproduction / Scenario**: Send a bulk update with `ids: ["not-an-id"]`, a mixed valid/nonexistent ID list, or `date=not-a-date` to post.
- **Potential Impact**: Invalid requests report success; malformed dates can be written to transactions; callers cannot trust operation counts.
- **Recommended Resolution**: Add schemas for every action, validate positive integer IDs and ISO dates, and report actual affected rows.

### [BUG-43] Mutation routes expose database/domain failures as inconsistent 500 responses
- **Severity**: Code Quality
- **Status**: Unresolved
- **Category**: Database & API
- **Location**: `apps/web/src/app/api/accounts/route.ts`, `categories/route.ts`, `assignments/route.ts`, and `rename-rules/route.ts`
- **Description & Root Cause**: Several routes do not catch domain/FK/unique errors, check update results, or normalize not-found responses. Unknown account/category IDs and invalid foreign keys can become framework 500s, while similar transaction routes return structured 4xx responses.
- **Reproduction / Scenario**: PATCH an unknown account, create a category with a nonexistent group, or upsert an assignment with a nonexistent category.
- **Potential Impact**: Clients show internal-error failures for invalid input and may not roll back or explain the actual user action required.
- **Recommended Resolution**: Centralize error mapping to 400/404/409/422, check affected rows, and avoid exposing raw database errors.

### [BUG-44] Invalid localStorage shapes can crash views
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `packages/ui/src/useLocalStorage.ts`; consumers in `BudgetApp.tsx`, `TransactionsView.tsx`, `ReportsView.tsx`, and `SpendingTrendsReport.tsx`
- **Description & Root Cause**: The hook catches malformed JSON but accepts any valid JSON value as `T`. Consumers then call object/array operations without runtime validation.
- **Reproduction / Scenario**: Store `null` for `ynab:transactions:sort`, `null` for collapsed groups, or an object/string for trends category IDs, then load the corresponding view.
- **Potential Impact**: TypeErrors replace views with the error boundary; invalid report subtabs can render blank content.
- **Recommended Resolution**: Add per-key runtime validators/safe defaults and remove invalid stored values.

### [BUG-45] Reports keep stale automatic date ranges after data changes
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `packages/ui/src/ReportsView.tsx`; `defaultStart`, `defaultEnd`, `startMonth`, and `endMonth`
- **Description & Root Cause**: Default ranges are recomputed from transactions, but the state is initialized only once. An import or mutation adding older history does not update the active range.
- **Reproduction / Scenario**: Mount Reports with a small/empty dataset, import older transactions, and remain on the mounted report view.
- **Potential Impact**: Newly imported history is omitted from reports until the user manually changes selectors.
- **Recommended Resolution**: Track whether the user customized the range and update automatic defaults when data changes while it remains untouched.

### [BUG-46] Deep-link and browser navigation state can diverge
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: UI & State
- **Location**: `packages/ui/src/BudgetApp.tsx`; `parsePath()`, `shiftMonth()`, `handleSetMonth()`, account deletion callback; `CalendarView` and Inspector wiring; `apps/web/src/app/(app)/[[...slug]]/page.tsx`
- **Description & Root Cause**: Calendar and Inspector month changes use raw `setMonth` and do not update the URL. The no-account `/transactions` path does not clear an existing account filter, and account deletion changes view/filter without changing the pathname. Month routes accept only shape, not month range.
- **Reproduction / Scenario**: Navigate between `/transactions/1` and `/transactions`, use browser Back/Forward, change Calendar month and refresh, delete the account from `/transactions/1`, or open `/budget/2026-99`.
- **Potential Impact**: The address bar and visible data disagree; refresh can restore a deleted/invalid account route or lose the selected month.
- **Recommended Resolution**: Centralize route state transitions, clear absent filters explicitly, update URL on every month transition, navigate after deletion, and validate month 01-12.

### [BUG-47] All Transactions displays the wrong balance for transfers
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: Register & Balance
- **Location**: `packages/logic/src/register.ts`; `computeRunningBalances()`; `packages/ui/src/TransactionsView.tsx`
- **Description & Root Cause**: In the unanchored view, a transfer row is inserted into both source and destination account walks, but `runningBalanceById` is keyed only by transaction ID. The destination walk overwrites the source walk's balance for the same row.
- **Reproduction / Scenario**: Have a transfer from A to B and view All Transactions. The row has one scalar `runningBalance`, although it has different balances in A and B.
- **Potential Impact**: The displayed balance is often the destination balance rather than the source row's balance, undermining register balance verification.
- **Recommended Resolution**: Store balance keyed by transaction/account side, render the appropriate side, or define an explicit all-accounts balance metric instead of overwriting one value.

### [BUG-48] Split-child flags are not preserved by YNAB4 export/import
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/export-ynab4.ts`; split child export; `packages/server/src/import-ynab4.ts`; split child import
- **Description & Root Cause**: Child transaction flags are not emitted in `subTransactions`; import derives child status from the parent and does not restore child flag state.
- **Reproduction / Scenario**: Create a split with a flagged child, export, and import.
- **Potential Impact**: User review metadata disappears and a restored backup is not field-equivalent.
- **Recommended Resolution**: Export/import child flags or explicitly document and test the loss as a format limitation.

### [BUG-49] Imported settings are discarded and exported XML is not escaped
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `apps/web/src/app/api/import/route.ts`; `packages/server/src/db-import.ts`; `packages/server/src/export-ynab4.ts`; `exportYnab4()`
- **Description & Root Cause**: Import extracts settings but passes only `ynabData` to `importYnab4`; no settings are persisted. Export interpolates budget name/currency/date values into XML without escaping `&`, `<`, or `>`.
- **Reproduction / Scenario**: Import custom settings and export later, or export a budget name such as `A & B`.
- **Potential Impact**: Settings silently revert on future exports and reserved characters produce malformed backup XML.
- **Recommended Resolution**: Persist settings metadata, pass it through roundtrip, and XML-escape every emitted text value.

### [BUG-50] Multi-section CSV export cannot be fed back to CSV import
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `apps/web/src/app/api/export/route.ts`; CSV export; `packages/logic/src/csv-import.ts`; `parseCsvImport()`
- **Description & Root Cause**: The export is a multi-section database dump whose first header is `Type,ID,Name,...`; the importer expects one transaction header with Date, Payee/Description, and amount columns.
- **Reproduction / Scenario**: Download `/api/export?format=csv` and submit the resulting file to `/api/import/csv`.
- **Potential Impact**: The application exposes a file that appears to be a backup but cannot restore through the advertised CSV path.
- **Recommended Resolution**: Provide a transaction-only import-compatible export, label this as a report dump, or implement a dedicated parser.

### [BUG-51] Unclosed CSV quotes are silently accepted
- **Severity**: Low
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/logic/src/csv-import.ts`; `parseCsv()`
- **Description & Root Cause**: The parser records characters until EOF even when `inQuotes` remains true and returns no parse error.
- **Reproduction / Scenario**: Import a file containing an opening quote without a closing quote.
- **Potential Impact**: Multiple physical rows can be merged into one malformed row and be imported or reported misleadingly.
- **Recommended Resolution**: Return a structural CSV error when EOF is reached while quoted, with the affected row number.

## New Findings

### [BUG-52] Recurring import drops memo and flagColor fields
- **Severity**: Medium
- **Status**: Unresolved
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-ynab4.ts:739-752`
- **Description & Root Cause**: The YNAB4 exporter emits `memo` and `flagColor` for recurring schedules, but the importer's insert statement does not include these fields. They are silently discarded.
- **Reproduction / Scenario**: Export a recurring schedule with a memo and flag, then import.
- **Potential Impact**: User notes and flags on recurring entries disappear after roundtrip, making a restored backup incomplete.
- **Recommended Resolution**: Map `memo` and `flagColor` in the recurring import insert.

### [BUG-53] Auto-post across multiple recurring items is not transactional
- **Severity**: Medium
- **Status**: Unresolved (related to BUG-04)
- **Category**: Recurring
- **Location**: `packages/server/src/queries/recurring.ts`; `autoPostDueRecurringTransactions()`
- **Description & Root Cause**: The function posts each due recurring item sequentially. Each `postRecurringTransaction()` commits its own transaction. If 3 of 5 items commit and the 4th fails, the first 3 are already persisted with no rollback mechanism.
- **Reproduction / Scenario**: Have 5 due recurring items; arrange for the 4th to fail (e.g., invalid category reference).
- **Potential Impact**: Partial auto-post commits create an inconsistent state: some scheduled items are advanced while others remain due.
- **Recommended Resolution**: Wrap the entire auto-post batch in a single transaction, or add compensating logic for partial failures.

## Production Readiness Assessment & Next Steps

This application should not be trusted with irreplaceable personal financial data until the High findings are addressed, especially BUG-02, BUG-03, BUG-04, BUG-06, BUG-09 through BUG-12, BUG-14 through BUG-19, and BUG-24 through BUG-26. These can lose or duplicate ledger entries, alter TBB/category balances, leave reconciled data mutable, or make a backup restore to a materially different budget.

The Medium findings are also important before production use because they affect import reliability, report correctness, browser recovery, and diagnostics. The system should have a single authoritative cents representation at every boundary, strict calendar/amount validation, complete backup roundtrip tests, and atomic mutation semantics.

Recommended validation work before release:

- Add property-based accounting tests for TBB, category availability, cash overspending, Red Arrow behavior, credit-card buffers, transfers, and non-contiguous months.
- Add real SQLite tests for concurrent requests, failure injection between transaction sub-steps, reset/reseed rollback, recurring posting retries, and reconciliation races.
- Add split invariant tests for every mutation route, including child amount/status changes, deletion, transfers, mixed-sign children, and reconciled parent/child combinations.
- Add field-by-field YNAB4 roundtrip fixtures covering inactive recurring rows, memo/flags, deferred months, carryovers, CC payment assignments, reconciliations, zero-balance accounts, hidden groups, and split children.
- Add malformed CSV fixtures for delimiter collisions, currency symbols, accounting negatives, invalid dates, unclosed quotes, Description plus Memo, duplicate-looking legitimate charges, and post-swap validation.
- Add browser tests for optimistic write-success/read-failure behavior, out-of-order reloads, corrupted localStorage types, popstate routing, deleted-account navigation, and report-range updates after import.

The passing automated suite is a useful baseline, but it does not establish financial correctness for the failure, malformed-input, concurrency, or roundtrip scenarios identified above.
