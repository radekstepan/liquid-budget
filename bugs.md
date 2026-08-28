# Codebase Audit & Bug Report

**Audit Date**: 2026-08-27
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

This codebase is a well-architected YNAB4 alternative with an unusually disciplined financial core: money is handled as integer cents end-to-end, transactions are wrapped in a mutex-protected transaction helper with savepoint nesting, the budget engine's cumulative carryover / TBB chain is internally consistent (including across month gaps, Red Arrow carryovers, and funded credit-card spending), and the optimistic-UI shell rolls back on failure. The test suite is extensive and — importantly — *asserts* the deliberate design decisions (e.g., unfunded CC spending does not reduce cash TBB), which this audit treated as specification rather than defect.

However, the audit identified **23 issues**, including one critical import-corruption hazard, three high-severity concurrency/feature bugs, and eight medium-severity correctness gaps. The most dangerous theme is not the pure math — the math is largely sound — but the **boundary between layers**: UI/server contract mismatches (recurring early-post), read-then-write windows outside the serialization mutex (balance corruption), engine-vs-diagnostics semantic drift (unfunded CC spending), and FK-driven silent rewrites of historical data (category deletion).

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | 1 | YNAB4 backup ingestion (amount-scale corruption) |
| **High** | 3 | Recurring posting, DB transaction races, auto-post race |
| **Medium** | 8 | Category deletion integrity, UI defaults, CC/diagnostics mismatch, CSV import, reconcile, reports |
| **Low** | 5 | Recurring date math, duplicate analysis, CSV heuristics, payees, register |
| **Code Quality / Inconsistency** | 6 | Dead code, duplicated validation logic, repo hygiene |

---

## Detailed Bug Findings

### [BUG-01] YNAB4 import assumes decimal-dollar amounts; stock YNAB4 backups (milliunits) would be inflated 1000×
- **Severity**: Critical
- **Category**: CSV & Import (YNAB4 backup ingestion)
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `importYnab4()` — every `dollarsToCents(t.amount)` / `dollarsToCents(msb.budgeted)` / `dollarsToCents(r.statementBalance)` call site (transaction inserts, split children, assignments, reconciliation balances, CC-payment category carryover back-calculation)
- **Description & Root Cause**:
  The importer converts every YNAB4 amount with `dollarsToCents()`, i.e. value × 100, treating backup amounts as **decimal dollars**. The canonical YNAB4 `.ynab4` JSON format stores amounts as **integer milliunits** (value × 1000, e.g. `-23500` = −$23.50). Feeding a stock YNAB4 backup through this importer multiplies every amount by 100 *on top of* the milliunit encoding, producing balances, budgets, and history that are 1000× too large — silently.
  The repository's own `backup.y4backup` (16,701 float amounts like `5831.12`, mixed with integers) has already been converted to decimal dollars, which is why the import tests and the roundtrip tests pass and the defect is invisible in this codebase.
- **Reproduction / Scenario**:
  Export a real budget from the YNAB4 desktop app (File → Export/Backup), producing a `.y4backup` whose transactions carry integer milliunit amounts (e.g. a `$45.00` grocery charge stored as `-45000`). Run `yarn db:import` (or upload via Settings → Import). Every transaction, starting balance, budget assignment, and reconciliation balance is imported 1000× too large: a $45.00 purchase becomes $45,000.00.
- **Potential Impact**:
  Total, silent corruption of an entire imported financial history. Because `export-ynab4.ts` divides by 100 symmetrically, the corruption is self-consistent within this app and will not be caught by a roundtrip test — only by a human comparing statement balances.
- **Recommended Resolution**:
  Detect the amount scale before import instead of assuming dollars: (a) if all transaction/budget amounts are integers and the magnitude distribution is ~1000× the plausible range (e.g. max |amount| > 10^6 for a personal budget), treat as milliunits and divide by 10 before `dollarsToCents`; or (b) accept the scale explicitly in the import UI with a validated preview of the first N transactions. Also add a fixture test with genuine milliunit-encoded data.
- **Introduced**:
  - Commit: `5c63d00` ("feat: import ynab4"), 2026-07-31. The original implementation chose `dollarsToCents` based on the repo author's own backup, which happened to already be in decimal-dollar form.
- **Regression Prevention**:
  Add a test fixture containing genuine milliunit-encoded data (e.g. `{ amount: -45000 }` for a −$45.00 transaction). Write an integration test that feeds this fixture through `importYnab4` and asserts the resulting `transactions.amount` is `-4500` (cents). Also add a fixture with mixed float/integer amounts matching the repo's `backup.y4backup` to keep that path covered. Run both before every YNAB4-import code change. The test should **fail** under the current code and only pass once scale detection is implemented.

---

### [BUG-02] "Post Now" on a future-dated recurring entry always fails with 409 — "enter early" feature is dead
- **Severity**: High
- **Category**: Recurring
- **Location**:
  - **File**: `packages/ui/src/RecurringView.tsx` (`renderCard`, "Post Now" button handler) and `packages/server/src/queries/recurring.ts` (`postRecurringTransaction`)
- **Description & Root Cause**:
  The UI explicitly supports posting a *future* scheduled occurrence into the register early: when `r.nextDate > today`, the button calls `onPost(r.id, today)` and its tooltip says *"Enter early into register as of today"*. The server, however, guards `postRecurringTransaction` with:
  ```ts
  if (validatedPostDate && validatedPostDate < r.nextDate) {
    throw new RecurringError(`Recurring transaction occurrence for ${validatedPostDate} has already been posted`, 409);
  }
  ```
  For a future-dated rule, `today < r.nextDate` by definition, so the request always throws. The error message ("has already been posted") is also wrong for this case — nothing has been posted.
- **Reproduction / Scenario**:
  Create a recurring transaction with nextDate in the future (e.g. rent due 2026-09-01, today is 2026-08-27). Open Recurring view, click "Post Now" on the card (which appears under "Later"). The API returns 409 and the shell shows the toast "Failed to post recurring transaction."
- **Potential Impact**:
  A core recurring-management affordance is non-functional. Users who want to log an upcoming bill early (YNAB4's "enter early") cannot; the confusion is compounded by the misleading 409 message.
- **Recommended Resolution**:
  Decide the contract and align both sides: either (a) permit `postDate < nextDate` for an explicit manual early post (keep the 409 guard only for *automatic* catch-up posting, e.g. via a `allowEarly: true` flag set by the UI route), or (b) have the UI post without a date and then re-date the created transaction. Document that the schedule pointer (`nextDate`) still advances from the scheduled date, not the early post date.
- **Introduced**:
  - UI "isFuture → Post Now" branch: commit `cc6cfed` ("feat: scheduled trans"), 2026-08-04. The early-post affordance existed before the server guard was added.
  - Server 409 guard: commit `32927a1` ("fix: BUG-19 BUG-20"), 2026-08-26. The `validatedPostDate && validatedPostDate < r.nextDate` check was added without testing against the UI's early-post path.
  - The two features have never been in alignment — the UI predates the guard, and the guard was added assuming postDate is always ≥ nextDate.
- **Regression Prevention**:
  Add a Playwright e2e test that: (1) creates a recurring transaction with `nextDate` in the future (e.g. 7 days from today), (2) navigates to the Recurring view, (3) clicks "Post Now" on the "Later" card, (4) asserts a transaction is created in the register dated **today**, and (5) asserts the recurring rule's `nextDate` advanced correctly. Run this test before any change to `postRecurringTransaction`'s date guard or the `isFuture` branch in `RecurringView`.

---

### [BUG-03] Read-then-write race: entity rows are read outside the transaction mutex, enabling double balance application
- **Severity**: High
- **Category**: Database & API (balance integrity)
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
    - `updateTransaction()` — `existing`/parent/child-count reads before `withTransaction(...)`
    - `deleteTransaction()` — `existing` and parent read before `withTransaction(...)`
    - `updateSplit()` — parent and `oldChildren` read before `withTransaction(...)`
  - **File**: `packages/server/src/queries/accounts.ts` — `deleteAccount()` reads the account before `withTransaction(...)`
  - Contrast: `bulkUpdateTransactions` / `bulkDeleteTransactions` correctly read *inside* the transaction.
- **Description & Root Cause**:
  `withTransaction` serializes the *write phase* via a per-connection `AsyncMutex` and `BEGIN…COMMIT`, but the initial SELECTs that determine what will be reversed run *before* the mutex is acquired. Two concurrent mutations that target the same row (or the same account) can both observe the same `existing` state, then serialize their writes: the second writer reverses a balance effect that was already reversed/replaced by the first, applying stale deltas on top of new ones. `updateSplit` is worst: it captures `oldChildren` outside, then reverses and re-inserts inside — a concurrent edit of the same split produces double-reversed child balances.
- **Reproduction / Scenario**:
  Fire two concurrent `PATCH /api/transactions` requests for the same id with different amounts (e.g. a double-clicked Save in two tabs, or a retry racing a manual edit). Both read `amount = X`; A commits (balance −X, +Y); B then commits (balance −X again, +Z). `accounts.balance` is now off by −X relative to the transaction ledger — detectable only via the balance-integrity diagnostic.
- **Potential Impact**:
  Silent account-balance corruption that self-heals only if someone runs `recomputeAccountBalances`. Split/transfer multi-account operations make the corruption cross-account.
- **Recommended Resolution**:
  Re-read the row (and children) inside `withTransaction` and operate on that authoritative snapshot; treat the outer read as a fast-path pre-check only. Alternatively, add an optimistic version/column or re-validate the read fields inside the transaction and 409 on mismatch (the pattern `postRecurringTransaction` already uses with its `WHERE nextDate = ? AND active = true` guard).
- **Introduced**:
  - `transactions.ts`, `accounts.ts`: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The initial port of every query module placed initial SELECTs outside the transaction boundary; `bulkUpdateTransactions` and `bulkDeleteTransactions` were written correctly inside the transaction, but the single-row operations were not.
  - `updateSplit`: introduced in the same commit. The `oldChildren` capture outside the transaction has been present since the split editor was first built.
- **Regression Prevention**:
  Extend the existing `packages/server/tests/transactions-concurrency.test.ts` to fire two concurrent `updateTransaction` calls for the same id with different amounts, then assert `accounts.balance` matches the sum of deltas from both operations (not a stale double-reverse). Add the same test for `updateSplit` and `deleteTransaction`. Run with `NODE_OPTIONS='--experimental-vm-modules' npx vitest run --reporter=verbose` on every server change.

---

### [BUG-04] Concurrent `GET /api/budget` runs race in auto-post and permanently deactivates healthy recurring rules
- **Severity**: High
- **Category**: Recurring / Database & API
- **Location**:
  - **File**: `apps/web/src/app/api/budget/route.ts` (`GET` → `autoPostDueRecurringTransactions`)
  - **File**: `packages/server/src/queries/recurring.ts` (`autoPostDueRecurringTransactions` failure handler; `postRecurringTransaction` optimistic-concurrency 409)
- **Description & Root Cause**:
  Every budget fetch triggers auto-posting. Two overlapping fetches (two tabs, a reload racing a mutation reload) both read the same due list. Requests serialize on the DB mutex, so the loser's `postRecurringTransaction` re-reads the row, sees `nextDate` already advanced, and throws 409. The auto-post loop's `catch` treats *any* failure — including this benign concurrency loss — as a corrupt rule and permanently executes `UPDATE recurring SET active = false`. A paused-by-accident rule silently stops generating transactions.
- **Reproduction / Scenario**:
  Have a rule due today. Open the app in two tabs simultaneously (or trigger a reload while the initial load's auto-post is in flight). One tab posts; the other receives 409 per rule and deactivates it. The Recurring view then shows the rule as "Paused" with no user action.
- **Potential Impact**:
  Scheduled transactions silently stop posting — missed bill entries, wrong TBB trajectory, and user distrust ("the app randomly paused my rent").
- **Recommended Resolution**:
  Distinguish the 409 "schedule mismatch / already posted" outcome from genuine failures: on 409, re-read the rule and continue (another runner won) instead of deactivating. Additionally, make auto-post idempotent per-process (an in-process "already ran for this nextDate set" guard) and consider running it once per app boot rather than on every budget fetch.
- **Introduced**:
  - `api/budget/route.ts`: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. Auto-post on every `GET /api/budget` has been present since the first monorepo commit.
  - Failure deactivation: commit `87d0ddc` ("fix: BUG-41 BUG-42 BUG-43"), 2026-08-27. The catch-all `active = false` was added to handle genuinely broken rules but did not distinguish the concurrency-409 case.
- **Regression Prevention**:
  Write a test that fires two `autoPostDueRecurringTransactions` calls concurrently against a due rule, then asserts `recurring.active === true` and only one occurrence was posted. Mock the `nextDate` advance guard to verify the 409 path specifically. Add a unit test for the failure handler that proves a `RecurringError(409)` from `postRecurringTransaction` does NOT set `active = false`. Run before any change to `autoPostDueRecurringTransactions`'s catch block.

---

### [BUG-05] Deleting a category silently orphans reconciled transactions and retroactively rewrites budget history
- **Severity**: Medium
- **Category**: Budget Engine / Data integrity
- **Location**:
  - **File**: `packages/server/src/queries/categories.ts`
  - **Function / Component / Symbol**: `deleteCategory()`, `deleteCategoryGroup()`
- **Description & Root Cause**:
  When a replacement category is supplied, only rows with `status != 'r'` are re-pointed:
  ```ts
  .update(transactions).set({ categoryId: target })
    .where(and(eq(transactions.categoryId, id), ne(transactions.status, "r")));
  ```
  Reconciled rows are deliberately skipped (locked), but the category row is then deleted, and the FK `transactions.category_id ON DELETE SET NULL` wipes their `categoryId`. Those historical outflows/inflows vanish from the envelope math: the affected month's category available increases, the overspend clamping and TBB chain recalculate differently, and spending reports change retroactively — all without warning.
- **Reproduction / Scenario**:
  Reconcile June; in August delete "Groceries" choosing replacement "Food". All June *reconciled* grocery rows become uncategorized; `computeBudget` for June now shows Groceries available ≈ +$X that never existed and TBB for all later months shifts.
- **Potential Impact**:
  Retroactive corruption of locked, user-trusted financial history; the budget-integrity diagnostic may also start reporting violations.
- **Recommended Resolution**:
  Treat reconciled references as a blocker: either refuse deletion while reconciled rows reference the category (422, mirroring `deleteAccount`), or re-point reconciled rows as part of the same replacement operation with the user's explicit consent (a reconciled row's *category* is metadata, not its locked core fields).
- **Introduced**:
  - Commit: `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The `ne(transactions.status, "r")` filter and the `ON DELETE SET NULL` FK on `transactions.category_id` have coexisted since the first schema design.
- **Regression Prevention**:
  Add a test that creates a category, assigns it to a transaction, marks the transaction as reconciled (`status = "r"`), then deletes the category with a replacement. Assert the reconciled transaction's `categoryId` is still the target (replacement) after the delete — not `null`. Also assert the budget history for the month containing the reconciled row is unchanged after the deletion. Run on every `deleteCategory` code change.

---

### [BUG-06] Budget view defaults to the hardcoded demo month "2026-06" instead of the current month
- **Severity**: Medium
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/BudgetApp.tsx` (`BudgetApp` state init: `useState(initialMonth ?? DEMO_MONTH)`)
  - **File**: `packages/logic/src/seed-fixture.ts` (`DEMO_MONTH = "2026-06"`)
  - **File**: `apps/web/src/app/(app)/[[...slug]]/page.tsx` (leaves `initialMonth` undefined for `/`)
- **Description & Root Cause**:
  Opening the app at the root URL (`/`) passes no `initialMonth`, so `BudgetApp` falls back to the seed-fixture's `DEMO_MONTH`. The value was chosen for the demo fixture, not as a runtime default. `updateUrl` only syncs the URL on later navigation, so the user also sits on `/` while viewing June 2026.
- **Reproduction / Scenario**:
  Open `http://localhost:3000/` on any day other than a June 2026 day — the budget grid shows June 2026 with that month's carryovers instead of the current month.
- **Potential Impact**:
  Users edit assignments against the wrong month's envelopes; TBB and category balances shown do not match the live month. Confidence-eroding for a finance app.
- **Recommended Resolution**:
  Default to `todayISO().slice(0, 7)` (the codebase already exports `todayISO`), reserving `DEMO_MONTH` strictly for seed/demo fixtures; push `/budget/<currentMonth>` on first paint.
- **Introduced**:
  - `seed-fixture.ts`: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29, which also introduced `DEMO_MONTH = "2026-06"`.
  - `BudgetApp.tsx`: the `initialMonth ?? DEMO_MONTH` fallback in the same commit. The intent was to have a sensible default for the demo seed; the defect is that no separate production default (`todayISO().slice(0,7)`) was ever set up.
- **Regression Prevention**:
  Add a unit test that renders `BudgetApp` with no `initialMonth` prop and asserts the internal month state equals `todayISO().slice(0,7)`. Also add an e2e test that opens `/` and checks the URL changes to `/budget/<currentYearMonth>` and the header displays the current month. Run on any change to `BudgetApp.tsx`'s state initialization.

---

### [BUG-07] Unfunded credit-card spending is invisible in the budget and trips the budget-integrity diagnostic
- **Severity**: Medium
- **Category**: Budget Engine / Reports & Analytics (consistency)
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts` (`computeAllMonths`, second pass over CC payment categories: `ccBuffer = fundedCC + cardAdvance − cardPayment`)
  - **File**: `packages/server/src/queries/diagnostics.ts` (`verifyBudgetIntegrity`)
- **Description & Root Cause**:
  By design (and asserted in `packages/logic/tests/budget-engine.test.ts` "BUG-07: pure credit card overspending…"), unfunded CC spending does not move cash into the CC Payment category and does not reduce cash TBB — the debt lives on the card account. Consequences: (1) the CC Payment category shows $0 available ("nothing owed to pay") while the card account is negative, diverging from YNAB4 where the payment category goes negative by the unfunded amount; (2) the diagnostics invariant `Σ on-budget balances − Σ category available − TBB === 0` no longer holds for exactly this scenario (checking 0 + card −10000 vs categories 0, TBB 0 → difference −10000), so the shipped `budget-integrity` endpoint reports false violations whenever a user charges more than they've budgeted before paying the bill.
- **Reproduction / Scenario**:
  Budget $0 to Groceries, charge $100 on a linked credit card, don't pay it yet. Budget screen shows Amex Payment available = $0.00 and Groceries = −$100.00 (red) while the card owes $100; `GET /api/diagnostics/budget-integrity` returns a non-zero `difference` although the engine is behaving as specified.
- **Potential Impact**:
  Users miss the "you need $100 to pay this card" cue YNAB4 provides; the diagnostic endpoint cries wolf on a normal state, training users to ignore genuine integrity failures.
- **Recommended Resolution**:
  Pick one semantic and align: either reflect unfunded CC spending in the CC Payment category available (available = −(unfunded spend + card balance adjustments), i.e. YNAB4's "payment needed" figure), or change `verifyBudgetIntegrity` to subtract net unfunded CC debt from the account side so the invariant matches the engine's documented model.
- **Introduced**:
  - Engine CC semantics: commit `914232b` ("feat: engine"), 2026-07-29. The second-pass `ccBuffer` formula has been `fundedCC + advance − payment` from the start.
  - Diagnostics: commit `2cfeead` ("fix: issues"), 2026-08-16. `verifyBudgetIntegrity` was written against the engine without accounting for unfunded CC debt, and the divergence was never caught because no test exercises both paths together.
- **Regression Prevention**:
  Add a test that creates a budget with unfunded CC spending (the exact scenario from the test at line 814 of `budget-engine.test.ts`) and then calls `verifyBudgetIntegrity`. Assert the reported `difference` is `0`. If the engine's `ccBuffer` semantics are left unchanged, the fix must be on the diagnostics side; if the CC Payment category is changed to reflect unfunded debt, the engine test expectations must be updated together. Both sides should be changed in the same commit so CI never sees a red diagnostics test.

---

### [BUG-08] CSV import reads all reference data outside the write transaction — concurrent imports duplicate rows
- **Severity**: Medium
- **Category**: CSV & Import / Database & API
- **Location**:
  - **File**: `packages/server/src/import-csv.ts`
  - **Function / Component / Symbol**: `importCsvTransactions()` (account/category/rename-rule/`existingTx` reads before `withTransaction`)
- **Description & Root Cause**:
  The duplicate-fingerprint set is built from a SELECT that runs before the mutex-protected transaction begins. A second overlapping import (double-submitted button, two tabs) builds its fingerprints from the same pre-import snapshot, so rows the first run already inserted are invisible to it and are inserted again. Within a single run, identical rows in one file are deliberately preserved (documented), which is correct for bank CSVs — the bug is the cross-request window.
- **Reproduction / Scenario**:
  Submit the same statement CSV twice in quick succession (or from two tabs). Both requests pass the fingerprint check against the pre-import ledger; the result is a fully duplicated set of transactions with inflated account balance.
- **Potential Impact**:
  Duplicated transactions with inflated balances; user must run the duplicate analyzer and delete manually.
- **Recommended Resolution**:
  Move the reference reads (account, categories, existing transactions, rename rules) inside `withTransaction`, matching the pattern already used by `bulkUpdateTransactions`.
- **Introduced**:
  - Commit: `da18db5` ("feat: import"), 2026-08-19. The CSV import module was written with all reference reads outside the transaction, unlike the existing bulk-query modules.
- **Regression Prevention**:
  Add a test that fires two concurrent `importCsvTransactions` calls for the same account and the same CSV file, then asserts `SELECT COUNT(*) FROM transactions WHERE account_id = ?` equals the expected single-import row count (not double). The repo already has a concurrency test setup at `packages/server/tests/transactions-concurrency.test.ts` — extend it. Run before any CSV import changes.

---

### [BUG-09] Optimistic split creation inserts only the parent row — transient wrong income/TBB and missing category outflows
- **Severity**: Medium
- **Category**: UI & State (optimistic consistency)
- **Location**:
  - **File**: `apps/web/src/components/BudgetAppShell.tsx`
  - **Function / Component / Symbol**: `api.addTransaction` (splits: pushes a single parent `newTx`; `api.updateTransaction` also applies `categoryId` to transfer rows without the server's boundary re-classification)
- **Description & Root Cause**:
  When a transaction with `subTransactions` is added, the shell applies correct account deltas but prepends **only the parent row** (with `parentId: null`, parent amount, `categoryId: null`) and no children. Client-side, `computeBudget` therefore sees a plain positive uncategorized row → transiently counted as **income** (paycheck splits inflate TBB), while the children's category outflows are missing; the register shows one un-decomposed row. Similarly, patching a category onto an internal transfer optimistically keeps it, while the server forces it to null — the category column and budget outflow flash inconsistently until the post-mutation reload lands.
- **Reproduction / Scenario**:
  Add a $3,000 paycheck split (children: Rent, Groceries, Income) and observe the budget screen in the sub-second before the reload: TBB jumps ~+$3,000, no category shows the outflow, and the register shows a single $3,000 row.
- **Potential Impact**:
  Flickering, misleading budget figures on every split save; on slow networks the wrong state is visible for seconds and may be screenshotted/misinterpreted. No persistent corruption (server truth wins on reload).
- **Recommended Resolution**:
  Insert synthetic child rows (temp ids linked to the temp parent) in the optimistic state, mirroring `createSplitWithChildren`'s classification; for transfer patches, mirror `classifyBoundaryTransfer` client-side (the logic package is already client-safe).
- **Introduced**:
  - `addTransaction`: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The optimistic split logic was simplified at inception to only insert the parent row — the children were deferred to the reload. The comment in the commit history suggests this was a conscious trade-off for code simplicity.
  - `updateTransaction` transfer-category mismatch: same commit. The optimistic `setData` applies `categoryId` directly without re-classifying the boundary transfer type.
- **Regression Prevention**:
  Add a unit test that calls `BudgetAppShell`'s `api.addTransaction` with a split payload and inspects the resulting optimistic state (before the server roundtrip) — assert that child rows with correct amounts, categories, and `parentId` are present in the transactions array and that `computeBudget` on the optimistic state reflects the children's outflows (not just the parent's total as income). Add a second test for `api.updateTransaction` on a transfer row — assert the optimistic state's `categoryId` matches what the server would set (null for internal transfers, the boundary category for cross-budget outflows).

---

### [BUG-10] European CSV amounts: single dot-thousands group "1.500" parses as 1.5 (1000× error)
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseAmount()` (branch `/^\d{1,3}(\.\d{3}){2,}$/` requires ≥2 dot-groups; the decimal branch `/^(\d*\.\d+|\d+\.)$/` catches the rest)
- **Description & Root Cause**:
  Dot-as-thousands is only recognized when there are **two or more** groups (`1.500.000`). A German/Dutch-style value with a single group — `1.500` meaning 1,500 — falls through to the decimal-fraction branch and parses as **1.5**. Comma-thousands has no equivalent gap (`1,500` matches the group regex), so the bug is specific to dot-separator locales.
- **Reproduction / Scenario**:
  Import a CSV containing `15.08.2026,Supermarket,1.500` (€1,500 purchase). The row imports as **$1.50** (150 cents) — 1000× too small, silently.
- **Potential Impact**:
  Silent large-magnitude amount corruption for European users; no error is raised because the value is *plausible*.
- **Recommended Resolution**:
  Accept a locale/format hint in the CSV import options (decimal separator, matching the YNAB4 settings XML already parsed on the YNAB4 path), and when `decimalSeparator: ","` treat `.` strictly as a thousands separator. Alternatively treat single-group `d+.ddd` with exactly three decimals as ambiguous and flag the row for confirmation.
- **Introduced**:
  - Commit: `da18db5` ("feat: import"), 2026-08-19. The `parseAmount` function has had the `{2,}` dot-group requirement since its first version. The comma-path works correctly because `1,500` matches the thousand-group regex.
- **Regression Prevention**:
  Add a test that `parseAmount("1.500")` returns `150000` (1500 dollars in cents), `parseAmount("1,500")` returns `150000`, and `parseAmount("1.500,50")` returns `150050`. These tests must **fail** under the current code for the `.` case. Run before any change to `parseAmount`'s regex branches. Also add a property-based test that roundtrips `parseAmount → dollarsToCents → fmt` for every major locale pattern.

---

### [BUG-11] Reconcile modal never sends `statementDate` — cannot reconcile to a past statement
- **Severity**: Medium
- **Category**: Reconcile
- **Location**:
  - **File**: `packages/ui/src/ReconcileModal.tsx` (`onSubmit` — sends only `accountId`, `statementBalance`, `adjustmentCategoryId`)
  - **File**: `packages/server/src/queries/reconcile.ts` (`reconcileAccount` defaults `statementDate` to `todayISO()`); the API schema (`ReconcileAccountSchema`) supports `statementDate`
- **Description & Root Cause**:
  The server and schema fully support reconciling as of an arbitrary statement date (working balance, flip window, and adjustment are all bounded by it), but the modal hardcodes today. Reconciling mid-month against *last month's* statement therefore locks every cleared row dated between the statement date and today into this round — rows that belong on the *next* statement.
- **Reproduction / Scenario**:
  On Sept 3, reconcile against the Aug 31 statement. Rows dated Sep 1–3 (this month's cleared spend) are flipped to Reconciled and locked, even though the bank hasn't issued a statement covering them.
- **Potential Impact**:
  Over-locking: users must run "undo reconciliation" to edit rows that shouldn't have been locked; the statement-balance comparison silently includes the wrong window.
- **Recommended Resolution**:
  Add a (defaulting-to-today) statement-date field to the modal and pass it through; the server requires no changes.
- **Introduced**:
  - `ReconcileModal.tsx`: commit `b2ce51e` ("feat: reconcile"), 2026-08-04. The modal was written with only statement-balance input and never included a statement-date field. The server-side schema and API support `statementDate` (it is optional and defaults to `todayISO()`), so this is a pure UI omission.
- **Regression Prevention**:
  Add an e2e test that: (1) reconciles an account with a specific past `statementDate`, (2) verifies only rows dated ≤ that date are flipped to `"r"`, and (3) verifies rows dated after the statement date remain `"c"`. Assert the modal's submitted payload includes `statementDate`. Run on any change to `ReconcileModal.onSubmit` or `reconcileAccount`.

---

### [BUG-12] Monthly insights: "3-month average" divides by months-with-activity and includes CC payment categories
- **Severity**: Medium
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function / Component / Symbol**: `computeMonthlyInsights()` (divisor `mMap.size`; no `isCreditCardPayments` filter, unlike `computeSpendingTrends`)
- **Description & Root Cause**:
  The baseline average divides the prior-period total by the number of prior months that *had spending* for that category, not by 3. A category that spent once in the last three months gets its single month treated as its "average", producing huge spurious "+300% vs 3-mo avg" insights. Additionally, transactions categorized directly to Credit Card Payment categories are included here, while `computeSpendingTrends` excludes CC-payment groups at the "all" level — the two "spending analysis" surfaces disagree.
- **Reproduction / Scenario**:
  Spend $50 in a category in one of the last three months, $0 in the other two, then $120 this month → insight claims "+300%" although the true 3-month average is $40 (+200% even that is overstated by the divisor; with one prior month of $10 the claim becomes +1100%).
- **Potential Impact**:
  Misleading financial insights; inconsistent numbers between the Insights panel and Spending Trends.
- **Recommended Resolution**:
  Divide by the fixed window (3) or by the number of prior months that exist in the ledger, and apply the same CC-payment-group exclusion as the trends engine.
- **Introduced**:
  - Commit: `ad1d6c4` ("fix: net worth / insights"), 2026-08-16. `computeMonthlyInsights` used `mMap.size` (months-with-activity) as its divisor from the first commit. The CC-payment-group filter was included in `computeSpendingTrends` (same file, line 531) but not replicated here.
- **Regression Prevention**:
  Add a test that creates 3 prior months of data with spending in only 1 of them, then asserts `computeMonthlyInsights` produces a divisor of exactly 3 (or the number of months that exist). Add a second test with a transaction categorized to a CC Payment category and assert it does not appear in the insights output. Run on any change to `computeMonthlyInsights`.

---

### [BUG-13] "Twice a month": hand-set nextDate on days 16–19 (anchor ≤ 15) skips the month's second occurrence
- **Severity**: Low
- **Category**: Recurring
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `nextDateFor()` — `case "twiceamonth"` / `"semimonthly"`
- **Description & Root Cause**:
  The first-half boundary is `currentDay <= 15` (plus a special case for `d1 === 16`). For anchor 5 the two pay days are the 5th and 20th; a nextDate of the 16th–19th (e.g. after a manual edit or an imported schedule) is treated as *second half* and jumps to next month's 5th, skipping the 20th entirely. Generator-produced dates (exactly d1/d2) are unaffected.
- **Reproduction / Scenario**:
  Create a twice-a-month rule with `nextDate = 2026-09-17`, `anchorDay = 5`; the next occurrence becomes 2026-10-05, skipping 2026-09-20.
- **Potential Impact**:
  A skipped paycheck/bill occurrence in an unusual-but-reachable state; auto-post catch-up will not back-fill it.
- **Recommended Resolution**:
  Treat "first half" as `currentDay < d2` (clamped-aware), not `currentDay <= 15`, so any day before the second occurrence advances to it.
- **Introduced**:
  - Commit: `6308053` ("feat: init"), 2026-07-29. The `currentDay <= 15` heuristic has been in `nextDateFor`'s twiceamonth branch since the very first commit of the project. The `d1 === 16` special case was added later to patch one anchorDay=31 scenario, but the core boundary was never generalized.
- **Regression Prevention**:
  Add parameterized tests for `nextDateFor("twiceamonth", date, anchor)` covering: anchor 5 with nextDate on day 17 → expect day 20 of the same month; anchor 5 with nextDate on day 20 → expect day 5 of the next month; anchor 31 with nextDate on day 16 → expect day 31 of the same month (clamped). Every anchor from 1 to 31 with nextDate set to the mid-point between d1 and d2 should produce d2, not skip it. Run on any change to the twiceamonth/semimonthly case.

---

### [BUG-14] Duplicate analysis performs its flag-set and stale-clear as two unwrapped updates
- **Severity**: Low
- **Category**: Database & API
- **Location**:
  - **File**: `packages/server/src/queries/duplicates.ts`
  - **Function / Component / Symbol**: `analyzeUnflaggedDuplicates()`
- **Description & Root Cause**:
  The "flag new duplicates" and "clear stale duplicate markers" updates execute as separate top-level statements with no `withTransaction`. A crash between them leaves some rows flagged and stale rows uncleaned. Low likelihood (single-user, local), but the codebase's own convention is to wrap multi-statement mutations.
- **Reproduction / Scenario**: Kill the process between the two UPDATEs during a large duplicate scan.
- **Potential Impact**:
  Inconsistent flag state; next run self-heals most of it.
- **Recommended Resolution**: Wrap both updates in `withTransaction`.
- **Introduced**:
  - Commit: `45477b0` ("feat: flag transactions"), 2026-08-19. The duplicate-analysis module was written with two separate top-level UPDATEs from its first version, unlike the convention set by other query modules.
- **Regression Prevention**: Add a test that runs `analyzeUnflaggedDuplicates`, then simulates a crash between the flag-set and stale-clear updates (e.g. by mocking `db.update` to throw after the first call). Assert the database is in a self-consistent state — no row should carry a `flagColor = "duplicate"` that the stale-clear would have removed, and no row that should have been flagged should be missing the marker. Alternatively, assert that `withTransaction` is called exactly once by wrapping the test in a spy. Run on any change to `analyzeUnflaggedDuplicates`.

---

### [BUG-15] CSV date heuristics: 2-digit years always map to 2000s; ambiguous numeric dates silently default to DMY
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseDate()` (`if (y < 100) y += 2000`), `detectDateFormat()` (tie → `"dmy"`)
- **Description & Root Cause**:
  `31/12/99` becomes 2099-12-31 (and `02/01/50` → 2050), so century-old statements import into the future. When a file contains only ambiguous day/month pairs (`01/02/2026`), detection produces zero votes and the default DMY is applied without warning to US users. The `swap` and `dateFormat` mitigations exist, but nothing surfaces "this file was ambiguous" to the user.
- **Reproduction / Scenario**: Import a statement dated `05/06/24` in a US locale with no disambiguating rows → parsed as June 5.
- **Potential Impact**: Mis-dated history (affects month bucketing, reports, reconciliation windows).
- **Recommended Resolution**: Apply a pivot (e.g. <70 → 2000s, else 1900s), and when votes tie and rows exist, surface the detected-vs-forced convention prominently in the import modal (it already shows `detectedDateFormat` — add a warning when votes were zero).
- **Introduced**:
  - Commit: `da18db5` ("feat: import"), 2026-08-19. Both the `y < 100 ? y += 2000` unconditional offset and the tie-breaking default to `"dmy"` have been present since the first CSV parsing implementation.
- **Regression Prevention**:
  Add a test for `parseDate("31/12/99", "dmy")` documenting the 2099 outcome as a known tradeoff, and a test for `detectDateFormat` on a file containing only ambiguous dates (e.g. all values ≤ 12) asserting a warning flag is set. Run before any change to `parseDate` or `detectDateFormat`.

---

### [BUG-16] Payee machinery (`payees`, `payeeId`, `autoCategoryId`) is effectively dead code
- **Severity**: Low
- **Category**: Database & API / Code Quality
- **Location**:
  - **File**: `packages/server/src/queries/payees.ts` (`findOrCreatePayee` has no callers on the CSV path)
  - **File**: `packages/server/src/import-csv.ts` (never resolves/creates payees or applies `autoCategoryId`)
  - **File**: `packages/server/src/import-ynab4.ts` (resolves payees to text only; never inserts `payees` rows)
- **Description & Root Cause**:
  The schema, queries, and UI plumbing for payees with automatic categorization exist, but no write path populates the table and `createTransaction` never sets `payeeId`. YNAB4 imports discard payee entities (mapping to text only), so even imported budgets have an empty `payees` table while every transaction carries a duplicated text payee.
- **Reproduction / Scenario**: Inspect `payees` table after a YNAB4 import or any CSV import — always empty; `autoCategoryId` never used.
- **Potential Impact**:
  Missed auto-categorization feature; schema surface without behavior; `updatePayee`'s careful cascade code is unreachable in practice.
- **Recommended Resolution**: Either wire CSV/YNAB4 import into `findOrCreatePayee` + `autoCategoryId` (the clear product intent), or remove the subsystem to reduce maintenance surface.
- **Introduced**:
  - `payees.ts` / schema: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The payees table, `findOrCreatePayee`, `updatePayee`, and the `payeeId` FK on `transactions` were ported from an earlier architecture that may have wired them.
  - `import-ynab4.ts`: commit `5c63d00` ("feat: import ynab4"), 2026-07-31. YNAB4 payee entities were resolved to text strings but never inserted into the `payees` table.
  - `import-csv.ts`: commit `da18db5` ("feat: import"), 2026-08-19. The CSV path never calls `findOrCreatePayee` or sets `payeeId`, despite the `payees` table and `autoCategoryId` existing.
- **Regression Prevention**:
  After wiring the feature, add a test that imports a CSV with known payees and asserts the `payees` table is populated, `payeeId` is set on the inserted transactions, and `autoCategoryId` is applied when a matching rule exists. For the YNAB4 path, add a test that after a full YNAB4 import the `payees` table contains one row per distinct payee and `transactions.payeeId` is non-null. Run on any import-path change.

---

### [BUG-17] Register running-balance fallback shows the *current* balance for rows that don't participate in the walk
- **Severity**: Low
- **Category**: Register & Balance
- **Location**:
  - **File**: `packages/logic/src/register.ts`
  - **Function / Component / Symbol**: `computeRunningBalances()` (final assembly fallback `runningBalanceById.get(r.id) ?? accountBalances.get(r.accountId) ?? 0`; and the split-parent mirror that only copies a child balance when `childBal != null`)
- **Description & Root Cause**:
  Rows that don't participate in the anchor walk (e.g. in an anchored single-account view, a split child on another account, or the first child of a cluster whose balance step happened on the other side of a transfer) fall back to the account's *current* balance rather than a historical figure. For split parents whose chronologically-first child produced no walk entry, the parent's cluster balance silently shows the live balance instead of the post-cluster value.
- **Reproduction / Scenario**: Open a single-account register containing a split whose first (date-descending) child is a transfer leg to another account; the parent row's Balance column shows the account's *current* balance, not the post-cluster balance, and changes as new transactions are added elsewhere.
- **Potential Impact**:
  Confusing (locally incorrect) balance column in narrow edge cases; no arithmetic corruption of the ledger.
- **Recommended Resolution**: Fall back to `null` and render "—" for non-participating rows; for split parents, pick the first child *that has* a walk entry rather than strictly the first row.
- **Introduced**:
  - Commit: `6f02a1b` ("feat: running balances"), 2026-08-04. The `computeRunningBalances` function was first implemented with the `?? accountBalances.get(r.accountId)` fallback and the first-child-by-position split-parent mirror. Both have been present since the register was first built.
- **Regression Prevention**:
  Add a register test that creates a split on account A with a child that is a transfer leg to account B, opens a single-account register anchored to account A, and asserts the split parent row's `runningBalance` is `null` (or equal to the transfer child's running balance, whichever fix is chosen). Assert the value does NOT equal `accountBalances.get(accountA)`. Run on any change to `computeRunningBalances`.

---

### [BUG-18] Code quality & internal inconsistencies (6 sub-items)
- **Severity**: Code Quality / Inconsistency
- **Category**: Cross-cutting
- **Location & Items**:
  1. **Dead serialization queue** — `apps/web/src/components/BudgetAppShell.tsx` declares `mutationQueueRef` ("mutation queue") but `runMutation` never enqueues; concurrent mutations are only reconciled by the seq-guarded reload. Either implement queueing or delete the ref.
     - **Introduced**: Commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The ref was declared in the initial shell but never wired into `runMutation`.
     - **Regression Prevention**: Delete the unused ref. If the serialization concern is genuine, add a test that fires two rapid `assign` calls and asserts the final state reflects both assignments in order — then implement `mutationQueueRef` usage and assert the test passes.
  2. **Inconsistent split-child income semantics** — `packages/server/src/queries/transactions.ts`: `createSplitWithChildren()` marks positive uncategorized children `isIncome = true`, while `createTransaction()`'s split-child path (`parentId != null`) forces `isIncome = false`. Currently only the former is reachable from the API, but the divergence is a trap for future callers of the engine-level `createTransaction(parentId)`.
     - **Introduced**: Commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. Both functions were ported from different source architectures (the createSplit path from a split-specific handler, the generic createTransaction from a single-row handler) without aligning their income logic.
     - **Regression Prevention**: Add a test that calls `createTransaction({..., parentId: realId, amount: 100, categoryId: null})` and asserts the resulting `isIncome` matches what `createSplitWithChildren` produces for the same child row. Either both are `true` (income) or both are `false`. Run on any change to either function's `isIncome` assignment logic.
  3. **Four near-identical split validators** — `packages/logic/src/split.ts:validateSubTransactions`, `packages/logic/src/recurring.ts:validateRecurringSubTransactions`, and server-side `assertSplitsBalanced` in `queries/transactions.ts` and `queries/recurring.ts`. Drift risk (the recurring one duplicates error-wrapping logic); consolidate into `@ynab/logic`.
     - **Introduced**: The logic validators date to commits `4ca2318` (split.ts, 2026-08-03) and the monorepo init (`5386db7`, 2026-07-29) for recurring.ts; the server duplicates were written separately in later commits (`a977109`, 2026-08-27) without reference to the existing logic versions.
     - **Regression Prevention**: Consolidate all four into a single `assertSplitsBalanced(parentAmount, children)` exported from `@ynab/logic`. Add a property-based test that generates random valid split children, asserts the validator passes, then mutates one child's amount and asserts the validator fails. All server-side code should call the logic version and convert the error type via the `errorFactory` parameter. Remove the other three.
  4. **`nextDateFor("never"/"once")` silently advances monthly** — `packages/logic/src/format.ts` default branch treats unknown/one-off frequencies as monthly. Correctness currently depends on `postRecurringTransaction` setting `active = false` for one-offs; any other caller (e.g. projections on paused rules) would get bogus dates. Return the input date for `never`/`once` explicitly.
     - **Introduced**: Commit `6308053` ("feat: init"), 2026-07-29. The `switch` statement's default case (line 610–618 of format.ts) falls through to the monthly logic; it was never updated to explicitly handle `"never"` and `"once"`.
     - **Regression Prevention**: Add explicit `case "never": case "once": return iso;` to `nextDateFor`. Add a test that `nextDateFor("never", "2026-09-17")` returns `"2026-09-17"` unchanged and that `nextDateFor("once", "2026-09-17")` also returns `"2026-09-17"`. Run on any change to `nextDateFor`.
  5. **Inconsistent bulk semantics** — `POST /api/recurring` `bulk-post` wraps all posts in one transaction (single failure rolls back every post), while `autopost` isolates per-rule; `DELETE /api/recurring` bulk loop is untransactioned (partial deletes on failure). Pick one semantic (per-item isolation is friendlier) and document it.
     - **Introduced**: `bulk-post` with-transaction wrapper: commit `5386db7` ("chore: convert to yarn/turbo monorepo…"), 2026-07-29. The autopost per-rule isolation was added later in commit `87d0ddc` ("fix: BUG-41 BUG-42 BUG-43", 2026-08-27), creating the inconsistency. The untransactioned bulk-delete loop was present from the first recurring route implementation.
     - **Regression Prevention**: Standardise all bulk operations on per-item isolation (each post/delete in its own `withTransaction` call). Add a test that submits a bulk-post with 3 ids where the 2nd is invalid and asserts the 1st and 3rd are still committed. Add the same test for bulk-delete. Run on any change to the recurring route's bulk handlers.
  6. **Repository hygiene / privacy** — `budget.db` (+WAL/SHM), `budget.test.db` (+WAL/SHM), `backup.y4backup` (a real 1.3 MB personal financial backup), and `import.csv` sit in the repo root; `.DS_Store` as well. For a financial app, binary state and real data in VCS risk accidental disclosure and migration confusion. Add to `.gitignore` and strip history if this repo is ever shared.
     - **Introduced**: Cumulative since the first commits — `backup.y4backup` was committed alongside the YNAB4 import feature (`5c63d00`, 2026-07-31); `budget.db` and test DBs grew organically from local development runs.
     - **Regression Prevention**: Add the following to `.gitignore`: `*.db`, `*.db-wal`, `*.db-shm`, `*.y4backup`, `import.csv`, `.DS_Store`. Run `git rm --cached` on the existing files. Add a CI check (e.g. in `turbo.json` or a pre-commit hook) that fails if any `.db` or `.y4backup` file appears in the staged changes. Document the `DATABASE_URL` env-var override for developers who want a persistent DB outside the repo tree.

---

## Verified Correct (ruled out during audit)

For future reviewers, the following were investigated and found to be **intentional and internally consistent** (several are pinned by tests in `packages/logic/tests/budget-engine.test.ts`):

- **Unfunded CC spending does not reduce cash TBB** and leaves the CC Payment category at 0 in the *engine* (BUG-07 addresses the *diagnostics/UX* inconsistency, not the engine math).
- **Cumulative carryover & TBB chain across month gaps** — `computeAllMonths`/`computePriorTBBSurplus` walk data-months only; gaps, future months, and no-activity months all resolve correctly, including `buildCarryoverMap`'s fallback for dataless target months.
- **Current-month displayed TBB excludes current-month cash overspending**; the overspend lands in the next month's carry-in via the surplus chain (YNAB4 Rule 3 semantics).
- **Split income children** are correctly classified via the persisted `isIncome` column (engine checks `isIncome` before the `parentId` guard); split parents are excluded from balances, outflows, income, and duplicate fingerprints everywhere.
- **Register same-day ordering** — walk order (`date DESC, id DESC`) matches the display's default sort; transfer destination rows reuse the source leg's running balance by design; split parents mirror their newest child.
- **Integer-cents discipline** — UI collects dollars, converts via `dollarsToCents(evalAmount(...))`; split validation compares integer cents both client- and server-side; the register's `Math.round` guards against float leakage.
- **Reconcile locking** — reconciled rows are rejected (422) in update/delete/bulk paths; split parents are locked when any child is reconciled; `unreconcileAccount` reverses exactly one round via `reconciliationId`, deletes the synthetic adjustment, and restores the previous round's stamp.
- **`withTransaction`** — mutex + `AsyncLocalStorage`-keyed savepoints correctly prevents nested-`BEGIN` errors and interleaving for code paths that read inside the transaction.

---

## Production Readiness Assessment & Next Steps

**Bottom line**: the calculation core is trustworthy; the *edges* are not yet. The engine's month math, envelope invariants, and cents discipline are solid and well-tested. What stands between this codebase and safe use with real financial data is import fidelity, a handful of concurrency windows, and a few silent history-rewriting paths.

**Must fix before trusting real data (blockers):**
1. **BUG-01** — import-scale detection for genuine YNAB4 backups (data-destroying, silent).
2. **BUG-03** — move authoritative reads inside the write transaction; add a regression test with two concurrent mutations (the repo already has `transactions-concurrency.test.ts` — extend it to cover `updateTransaction`/`deleteTransaction`/`updateSplit`).
3. **BUG-05** — make reconciled-referencing category deletion explicit rather than silently `SET NULL`.
4. **BUG-04** — stop deactivating recurring rules on benign 409s.
5. **BUG-02** — repair the recurring early-post contract (or remove the button).

**Should fix shortly after (quality/correctness):**
- BUG-06 (default month), BUG-08 (import transaction), BUG-09 (optimistic splits), BUG-10 (EU amount parsing), BUG-11 (statement date), BUG-07 (align CC semantics with the integrity diagnostic), BUG-12 (insights baseline).

**Ongoing hygiene:** BUG-14–17 and the BUG-18 items — especially removing the real `backup.y4backup`/`budget.db` from version control.

**Strengths worth preserving:** the integer-cents convention, the `AsyncMutex` + savepoint transaction design, the optimistic-rollback shell pattern, reconcile immutability, and the unusually honest test suite that documents intended YNAB4 semantics. The engine's pure-function design made this audit tractable — keep business math in `@ynab/logic` and keep the server as a thin, transaction-wrapped persistence layer.