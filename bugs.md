# Codebase Audit & Bug Report

**Audit Date**: 2026-08-31
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness, Git Origin Tracing & Regression Prevention

---

## Executive Summary

The codebase demonstrates strong engineering fundamentals — the budget engine correctly implements cumulative envelope budgeting, the `dollarsToCents` function uses string-based decimal arithmetic to avoid IEEE 754 artifacts, and the `evalAmount` parser is a custom expression evaluator. However, iterative bug fixes across the project's commit history have repeatedly caused regressions where fixing one edge case broke another.

A historical git trace reveals that **12 out of 26 bugs (46%) were directly introduced as regressions while attempting to fix previous bugs** (e.g. `0c232f3b`, `ee80f9f3`, `f3159bf2`, `7b736de0`, `287f3250`, `7b3c9dd7`, `c272ac55`). To prevent the development cycle from endlessly going in circles, every bug below now documents:
1. **When and where it was introduced** (commit hash, date, author, commit subject).
2. **Whether it was introduced as part of another bug fix** (and what that original fix was trying to solve).
3. **How to avoid reintroducing the original bug** when applying the resolution.
4. **Concrete, non-negotiable regression test plans and assertions**.

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | 5 | Budget Engine (CC buffers, income), Reconcile (status), UI (modal status regression), YNAB4 Export |
| **High** | 8 | Splits (deletion cascade), Register (self-transfers), Recurring (silent cap), Optimistic rollback, LocalStorage, CSV parser, evalAmount |
| **Medium** | 8 | Reports (net worth gap), Budget (gap months), Duplicates (false positives), Rename rules, Recurring (anchor day), Reconcile (split status) |
| **Low** | 5 | Code quality, display edge cases |

---

## Detailed Bug Findings

### [BUG-01] CC Refund Processing Is Transaction-Order-Dependent — Produces Different Budgets for Same Data
- **Severity**: Critical
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeAllMonths()` — First pass, non-CC category loop (lines 612–638)
- **Introduced In**:
  - **Commit**: `0c232f3b` (*"fix: BUG-07 BUG-08 BUG-09"*)
  - **Date**: 2026-08-30 22:31:08 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `0c232f3b` attempted to fix CC overspending attribution (BUG-07/08 in that round) by calculating CC funding incrementally per-transaction using a running pool (`runningCashPool`). When adding support for credit card refunds (`tx.amount > 0`), it unconditionally subtracted `tx.amount` from `monthFundedCCByAccount` and `catFundedCC` without clamping against previously funded spending.
- **Description & Root Cause**:
  Within a single month, credit card *spends* are correctly clamped using `Math.max(0, Math.min(runningCashPool, spend))` so only funded portions transfer to the CC buffer. However, credit card *refunds* (positive `tx.amount`) are unconditionally subtracted from `monthFundedCCByAccount` and `catFundedCC` (lines 626–632), regardless of whether there was any funded spending to reverse. Because transactions are processed in chronological order (`sortedTxs`), the net CC buffer for a category varies depending on whether a refund arrives before or after the related spend.
- **Reproduction / Scenario**:
  Category has $0 starting balance.
  - *Scenario A*: CC Spend $100 (funded=$0 since pool is $0), then CC Refund $50 → `catFundedCC` = 0 − 50 = −$50. Net CC buffer change = **−$50**.
  - *Scenario B*: CC Refund $50 → `catFundedCC` = 0 − 50 = −$50. Then CC Spend $100 (pool now $50, funded=$50) → `catFundedCC` = −50 + 50 = $0. Net CC buffer change = **$0**.
- **Potential Impact**:
  CC Payment category balances fluctuate based on arbitrary import/sort order of same-day transactions. CC Payment category can show negative debt or phantom surplus, misleading the user about card payment obligations.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `0c232f3b`*: Ensure refunds on a CC reduce the CC payment buffer so you don't keep cash set aside for purchases that were returned.
  - *Avoiding Regression*: Do not return to the pre-`0c232f3b` logic (which ignored CC refunds completely). Instead, track cumulative funded CC spending per category/account pair and clamp refund reversals to the *currently funded balance* (`fundedRefund = Math.min(catFundedCC, tx.amount)`).
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test 1 (Order Invariance)**: Given a category with $0 assigned, running two transactions in order [Spend $100, Refund $50] vs [Refund $50, Spend $100] must yield the exact same `ccBuffer` on the CC Payment category ($0 funded, $0 buffer, $50 unfunded debt).
  - **Test 2 (Funded Refund Reversal)**: Given a category with $100 assigned and available, Spend $100 on CC (funded = $100, buffer = $100). Then Refund $40 on CC. Assert CC Payment category buffer equals $60 and Category available equals $40.

---

### [BUG-02] CC Refund on Unfunded Spending Creates "Phantom Money"
- **Severity**: Critical
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeAllMonths()` — First and Second passes (lines 625–633, 660–678)
- **Introduced In**:
  - **Commit**: `0c232f3b` (*"fix: BUG-07 BUG-08 BUG-09"*)
  - **Date**: 2026-08-30 22:31:08 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Part of the same CC refund handler introduced in `0c232f3b`.
- **Description & Root Cause**:
  When a user receives a CC refund for spending that was *unfunded* in a prior month, the unconditional subtraction of the refund from `monthFundedCCByAccount` drives the CC Payment category available balance below zero. Because cash overspending checks explicitly skip CC Payment categories (`if (ccGroupIds.has(c.groupId)) continue;`), this negative balance never deducts from TBB. Meanwhile, the refund adds positive `rawFlow` back to the spending category, increasing its available cash. The user can assign that cash elsewhere, printing money unbacked by real liquid assets.
- **Reproduction / Scenario**:
  1. January: Overspend Groceries by $50 on CC with $0 budgeted (unfunded CC debt = $50).
  2. February: Receive a $50 CC refund to Groceries. Groceries gains +$50 available. CC Payment drops to −$50 (no TBB deduction).
  3. User moves the +$50 from Groceries to Rent and spends it from Checking.
  - Result: $50 of phantom cash created. Total bank balances != sum of category balances + TBB.
- **Potential Impact**:
  Violates fundamental envelope budgeting invariant (`Total Liquid Cash == Sum of Category Balances + TBB`). User overspends real bank funds.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `0c232f3b`*: Allow refunds to restore category balances when goods are returned.
  - *Avoiding Regression*: When a refund is credited to a category with prior unfunded CC debt, the refund must first pay down the unfunded CC debt (reducing the debt balance on the card) before restoring cash to the category's available envelope.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test**: Multi-month scenario. Month 1: $0 assigned to Clothing, $100 CC spend (unfunded). Month 2: $100 CC refund to Clothing. Assert:
    - Month 2 CC Payment available is $0 (not -$100).
    - Month 2 Clothing available is $0 (not +$100).
    - Month 2 TBB is unaffected.
    - Total budget integrity check `verifyBudgetIntegrity` reports `difference === 0`.

---

### [BUG-03] Transaction Modal Silently Demotes Reconciled Transactions to "Cleared"
- **Severity**: Critical
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/Modals.tsx`
  - **Function / Component / Symbol**: `TransactionModal` — `save()` function (lines 155, 293, 312, 350)
- **Introduced In**:
  - **Commit**: `b2ce51e3` (*"feat: reconciliation"*)
  - **Date**: 2026-08-04 14:40:57 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Introduced during the initial implementation of the reconciliation UI.
- **Description & Root Cause**:
  `TransactionModal` represents the cleared state as a simple boolean `const [cleared, setCleared] = useState<boolean>(initial?.status === "c" || initial?.status === "r" || initial?.status == null)`. When saving, the status is serialized as `status: cleared ? "c" : "u"`. Any transaction with status `"r"` that is opened in the modal and saved (even just changing the memo or payee) has its status overwritten to `"c"`.
- **Reproduction / Scenario**:
  1. Reconcile an account (transactions stamped with `status: "r"`).
  2. Double-click a reconciled transaction to open `TransactionModal`.
  3. Edit the memo from "Dinner" to "Dinner with team" and click Save.
  4. The transaction's status in the database is changed to `"c"`.
- **Potential Impact**:
  Reconciled history is silently destroyed. Locked transactions become unlocked. Future reconciliations will recalculate starting working balances incorrectly.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `b2ce51e3`*: Give users a simple toggle switch for Cleared / Uncleared in the edit modal.
  - *Avoiding Regression*: Keep the boolean cleared checkbox for new/unreconciled rows, but when editing a transaction where `initial.status === "r"`, preserve `status: "r"` if `cleared === true`. If the user unchecks `cleared`, show an explicit warning dialog that unreconciling a transaction will affect past reconciliation rounds.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/ui/tests/Modals.test.tsx`
  - **Test**: Render `TransactionModal` with `initial={{ id: 1, status: "r", payee: "Target", amount: -2500 }}`. Edit memo to "Weekly groceries", click Save. Assert `onSave` mock is called with object containing `status: "r"`.

---

### [BUG-04] Single `status` Column Shared Across Both Sides of a Transfer
- **Severity**: Critical
- **Category**: Database & API / Reconcile
- **Location**:
  - **File**: `packages/server/src/schema.ts` — `transactions` table (line 85)
  - **File**: `packages/server/src/queries/reconcile.ts` — `reconcileAccount()` (lines 182–196)
- **Introduced In**:
  - **Commit**: `9906281a` (*"feat(schema): create dedicated payees entity table and management queries (UNI-38)"*)
  - **Date**: 2026-08-17 09:34:04 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Architectural decision during early schema consolidation where transfers were stored as single rows with `accountId` and `transferAccountId` rather than dual counterparty rows.
- **Description & Root Cause**:
  Transfers are stored as a single row with both `accountId` and `transferAccountId`. The `status` column (`"u"`, `"c"`, `"r"`) applies to both accounts simultaneously. When Account A is reconciled, `reconcileAccount` executes `UPDATE transactions SET status = 'r' WHERE account_id = A OR transfer_account_id = A`. This marks the transfer as reconciled in Account B immediately, even if Account B's bank statement has not cleared it yet.
- **Reproduction / Scenario**:
  1. Transfer $500 from Checking to Savings on August 30.
  2. Mark the transaction cleared in Checking.
  3. Reconcile Checking as of August 31.
  4. Open Savings register. The inbound $500 transfer is already marked `"r"` (reconciled), locking it before Savings is reconciled.
- **Potential Impact**:
  Breaks reconciliation workflow on the receiving account. Prevents matching bank statement cleared transactions.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `9906281a`*: Single-row transfer representation avoided transfer sync bugs and orphaned counterparty rows.
  - *Avoiding Regression*: Maintain the single-row storage model to prevent orphan rows, but add a `transferStatus` (or `destStatus`) column (`text("transfer_status").notNull().default("u")`). `reconcileAccount` will only flip `status` when `accountId === target` and `transferStatus` when `transferAccountId === target`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/reconcile.test.ts`
  - **Test**: Create transfer from Account A to Account B. Reconcile Account A. Assert Account A's view sees transfer as `"r"`, but query for Account B's reconcile state returns transfer in `unclearedTotal` with status `"u"`.

---

### [BUG-05] YNAB4 Export Uses Dollars Instead of Milliunits
- **Severity**: Critical
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/export-ynab4.ts` (lines 288, 350, 370, 389, 427, 448, 478, 528, 549)
- **Introduced In**:
  - **Commit**: `629a980c` (*"feat: backups"*)
  - **Date**: 2026-08-23 10:16:03 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial implementation of YNAB4 `.ynab4` zip export.
- **Description & Root Cause**:
  The export divides internal cents by 100 (`amount / 100`), producing decimal dollar numbers (e.g. `15.00` for $15). YNAB4's native JSON specification requires integer **milliunits** (1 dollar = 1000 milliunits; $15.00 = `15000`).
- **Reproduction / Scenario**:
  1. Export a budget containing a $25.50 transaction (stored as 2550 cents).
  2. Inspect the exported `Budget.yfull` JSON file: `"amount": 25.5`.
  3. Load the exported `.ynab4` into YNAB4 desktop app: transaction displays as $0.0255 (less than 3 cents).
- **Potential Impact**:
  All exported backups imported into YNAB4 or third-party YNAB4 tools are corrupted by a factor of 1000×.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `629a980c`*: Convert database integer cents into exportable format.
  - *Avoiding Regression*: Convert cents to milliunits by multiplying by 10 (`Math.round(amount * 10)`), matching YNAB4's exact integer milliunit scale across transactions, sub-transactions, monthly category budgets, reconciliations, and scheduled transactions.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/export.test.ts`
  - **Test**: Seed a transaction with amount `12345` cents ($123.45). Run `exportYnab4()`. Parse the resulting JSON and assert `exportedTx.amount === 123450`.

---

### [BUG-06] Credit Card Income / Cashbacks Dropped from Budget
- **Severity**: High
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `isIncomeTransaction()` (line 94)
- **Introduced In**:
  - **Commit**: `ee80f9f3` (*"fix: BUG-01 BUG-02 BUG-03"*)
  - **Date**: 2026-08-30 11:27:31 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `ee80f9f3` attempted to fix BUG-02 from a prior audit ("manual uncategorized inflow on a credit card is never classified as income"). In doing so, it added `if (accA && accA.kind === "credit") return false;` at line 94 *before* checking whether `t.isIncome === true`.
- **Description & Root Cause**:
  `isIncomeTransaction` has an early return `if (accA && accA.kind === "credit") return false;` placed above the check `if (t.isIncome !== undefined) return t.isIncome === true;`. When a user receives credit card rewards/cashback and assigns it to "Income: To Be Budgeted" (setting `isIncome: true` and `categoryId: null`), the engine completely ignores the transaction in `incomeByMonth`.
- **Reproduction / Scenario**:
  1. Add transaction on Credit Card: Amount +$50.00, Category "Income for August", `isIncome: true`.
  2. Credit card balance decreases by $50 (correct).
  3. August TBB does not increase by $50 (bug — the $50 income vanishes).
- **Potential Impact**:
  Credit card cashbacks and rewards credits cannot be budgeted as income.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `ee80f9f3`*: Prevent accidental CC payments or starting balance credits without a category from auto-inflating TBB as income.
  - *Avoiding Regression*: Check explicit `t.isIncome` FIRST. If `t.isIncome === true`, return `true` regardless of account kind. Only if `t.isIncome` is undefined, default `accA.kind === "credit"` to `false`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test 1 (Cashback Income)**: Create a credit account transaction with `amount: 5000, categoryId: null, isIncome: true`. Assert `isIncomeTransaction` returns `true` and TBB reflects +$50.
  - **Test 2 (Uncategorized CC Inflow default)**: Create a credit account transaction with `amount: 5000, categoryId: null, isIncome: undefined`. Assert `isIncomeTransaction` returns `false` (satisfying the original `ee80f9f3` requirement).

---

### [BUG-07] Deleting a Split Child Cascades into Full Transaction Deletion
- **Severity**: High
- **Category**: Splits & Transfers
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function / Component / Symbol**: `deleteTransaction()` (lines 1024–1037)
- **Introduced In**:
  - **Commit**: `11c27fe8` (*"fix: logic"*)
  - **Date**: 2026-08-16 15:34:11 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `11c27fe8` added a check to enforce that split transactions must have at least 2 children (`if (remaining.length === 1)`). To prevent leaving an invalid 1-child split in the database, it deleted the parent and the last remaining child.
- **Description & Root Cause**:
  When a user deletes a split child and only one child remains, lines 1024–1037 delete the last remaining child AND the parent transaction. This turns the deletion of a single sub-item into the deletion of the entire transaction.
- **Reproduction / Scenario**:
  1. Record a $100 supermarket trip split as: $80 Groceries, $20 Household Goods.
  2. Later, delete the $20 Household Goods split leg.
  3. Result: The $80 Groceries leg and the $100 parent are deleted. The entire $100 transaction vanishes.
- **Potential Impact**:
  Silent data loss. Bank account balance changes by the full amount of the transaction rather than just the deleted split leg.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `11c27fe8`*: Prevent invalid 1-child split transactions where a parent points to a single child.
  - *Avoiding Regression*: When `remaining.length === 1`, do not delete the last child. Instead, **flatten** the remaining child into a regular transaction (update the child's `parentId` to `null` or copy the child's category/memo/amount onto the parent and delete the child row).
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/transactions.test.ts`
  - **Test**: Create split transaction with 2 children ($80 Groceries, $20 Household). Call `deleteTransaction(householdChildId)`. Assert database still contains a transaction with amount $80 and category Groceries, and the account balance is credited $20 (not $100).

---

### [BUG-08] `evalAmount` Unary Minus Parser Silently Absorbs Spaces, Producing Wrong Amounts
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `evalAmount()` — unary minus loop (lines 319–320)
- **Introduced In**:
  - **Commit**: `5ddd9c78` (*"feat: inline math"*)
  - **Date**: 2026-08-04 18:10:23 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial implementation of the math expression tokenizer in `format.ts`.
- **Description & Root Cause**:
  In `evalAmount()`, the unary minus number parser contains:
  ```typescript
  else if (cc === " " || cc === "\t" || cc === "\n") { i++; }
  ```
  This skips whitespace between digits of a negative number. When parsing positive numbers, whitespace immediately breaks the number token. As a result, `"-5 5"` is parsed as `-55`, whereas `"5 5"` returns `null` (syntax error).
- **Reproduction / Scenario**:
  1. In the transaction amount field, user types `-5 50` (accidental space instead of decimal point).
  2. `evalAmount("-5 50")` evaluates to `-550`.
  3. `dollarsToCents(-550)` records −$550.00 instead of rejecting the input.
- **Potential Impact**:
  Typo in amount field results in an entry 100× larger than intended.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `5ddd9c78`*: Allow expressions like `- 50 + 20` with whitespace between the operator and operand.
  - *Avoiding Regression*: Only skip whitespace *before* the first digit of the unary minus number. Once digits have started being collected (`num.length > 0`), any subsequent whitespace must terminate the number token.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/format.test.ts`
  - **Test 1**: `evalAmount("- 50 + 20")` returns `-30`.
  - **Test 2**: `evalAmount("-5 50")` returns `null` (rejected).
  - **Test 3**: `evalAmount("-5.50")` returns `-5.5`.

---

### [BUG-09] Optimistic Rollback Race Condition Wipes Later Updates
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `apps/web/src/components/BudgetAppShell.tsx`
  - **Function / Component / Symbol**: `runMutation` / `onRollback` across mutation callbacks (lines 309, 361, 520, etc.)
- **Introduced In**:
  - **Commit**: `f3159bf2` (*"fix: BUG-31 BUG-32 BUG-33"*)
  - **Date**: 2026-08-30 23:58:44 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `f3159bf2` replaced a pattern where `snapshot` was captured inside `setData` with capturing `const snapshot = dataRef.current` synchronously at the start of the handler to prevent closures from capturing stale state.
- **Description & Root Cause**:
  Synchronously capturing `dataRef.current` creates a snapshot of the world before Mutation 1. If Mutation 1 and Mutation 2 are triggered in rapid succession, Mutation 2 updates `dataRef.current`. If Mutation 1 subsequently fails, its `onRollback` executes `setData(snapshot)`, which overwrites `dataRef.current` with the pre-Mutation-1 state, obliterating Mutation 2's optimistic update.
- **Reproduction / Scenario**:
  1. Rapidly change Category Assignment A to $100, then Category Assignment B to $200.
  2. Request A fails (network glitch).
  3. `onRollback` for A sets state back to before A was edited, reverting both A and B.
- **Potential Impact**:
  Loss of optimistic UI state during fast data entry.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `f3159bf2`*: Prevent race conditions where `snapshot` was null if `setData` had not yet executed.
  - *Avoiding Regression*: Rollbacks must be granular (e.g. roll back only the specific assignment or transaction ID that failed) rather than resetting the entire root `BudgetData` object, followed by a background `reload()`.
- **Regression Test Plan & Assertions**:
  - **File**: `apps/web/tests/BudgetAppShell.test.tsx`
  - **Test**: Dispatch `assign(CatA, 100)` (mocked to fail) and immediately dispatch `assign(CatB, 200)` (mocked to succeed). When A fails, verify Cat B remains at 200 in the UI state.

---

### [BUG-10] `useLocalStorage` Performs I/O Inside React State Updater — Crashes on Storage Quota
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/useLocalStorage.ts`
  - **Function / Component / Symbol**: `setValue()` (lines 53–61)
- **Introduced In**:
  - **Commit**: `11f1301a` (*"feat: batch of changes"*)
  - **Date**: 2026-08-21 10:18:39 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Feature commit implementing validation and functional updates for local storage.
- **Description & Root Cause**:
  `setValue` calls `window.localStorage.setItem()` inside the callback passed to `setStoredValue((prev) => { ... })`. React state updaters can be executed during the render phase or in concurrent transitions. If `setItem` throws `QuotaExceededError` or `SecurityError`, the exception escapes into React's render loop, unmounting the component tree and causing a white screen.
- **Reproduction / Scenario**:
  1. Fill browser localStorage to capacity (5MB).
  2. Collapse a category group in `BudgetView`.
  3. `localStorage.setItem` throws `QuotaExceededError` inside `setStoredValue`. App crashes with white screen.
- **Potential Impact**:
  App becomes unusable when local storage is full or private browsing blocks storage.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `11f1301a`*: Support functional state updates `setValue(prev => next)` where the next value depends on current storage state.
  - *Avoiding Regression*: Compute `valueToStore` from current state, update React state, and perform `localStorage.setItem` in a separate `try/catch` block *outside* the render path.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/ui/tests/useLocalStorage.test.tsx`
  - **Test**: Mock `localStorage.setItem` to throw `new DOMException("QuotaExceededError")`. Call `setValue("new-val")`. Assert the hook updates internal React state without throwing and logs a console warning.

---

### [BUG-11] Recurring Auto-Post Silently Drops Transactions After Cap
- **Severity**: High
- **Category**: Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `autoPostDueRecurringTransactions()` (lines 596–614)
- **Introduced In**:
  - **Commit**: `db3ae0c2` (*"fix: BUG-07 BUG-08 BUG-09"*)
  - **Date**: 2026-08-27 15:52:35 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `db3ae0c2` added a safety cap (`maxPerRule = 5`) to prevent runaway infinite loops if a recurring schedule had an invalid interval or if the app was reopened after years.
- **Description & Root Cause**:
  When catch-up transactions exceed `maxPerRule` (5), the loop breaks and adds an entry to `capped: AutoPostCapped[]`. However, the API endpoint does not notify the user, and the recurring rule's `nextDate` remains in the past. If the user doesn't realize transactions were capped, their ledger is missing months of transactions with no UI alert.
- **Reproduction / Scenario**:
  1. Set a daily recurring rule. Do not open the app for 30 days.
  2. Open app: 5 transactions are auto-posted. 25 transactions are dropped from auto-post.
  3. No toast, banner, or prompt is shown to the user.
- **Potential Impact**:
  Silent divergence between real bank balance and budget register balance.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `db3ae0c2`*: Protect server process from locking up or running out of memory on huge date gaps.
  - *Avoiding Regression*: Keep the safety limit on automatic background materialization, but return `capped` metadata to the client and display an actionable toast/modal: *"25 overdue occurrences of [Payee] were paused. [Post All] [Skip to Today]"*.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/recurring.test.ts`
  - **Test**: Create daily recurring rule starting 30 days ago. Run `autoPostDueRecurringTransactions(db)`. Assert response contains `posted.length === 5` and `capped[0].remainingDue === 25`.

---

### [BUG-12] CSV Parser Treats Mid-Field Quotes as Quote-Mode Toggle
- **Severity**: High
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseCsv()` (line 92)
- **Introduced In**:
  - **Commit**: `da18db59` (*"feat: import"*)
  - **Date**: 2026-08-19 13:43:18 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial implementation of custom RFC-4180 CSV parser.
- **Description & Root Cause**:
  At line 92, when `ch === '"'` and `!inQuotes`, the parser sets `inQuotes = true` regardless of character index in the current field. If a cell contains unescaped mid-field quotes like `Store "A"`, the parser enters quote mode, swallowing commas until the next quote.
- **Reproduction / Scenario**:
  CSV row: `2023-01-01,Store "A",Groceries,50.00`
  Parser parses: Column 1 = `2023-01-01`, Column 2 = `Store A,Groceries`, Column 3 = `50.00`. Payee and category are mangled.
- **Potential Impact**:
  Mangled payees, shifted columns, and incorrect amounts during CSV statement import.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `da18db59`*: Handle standard quoted fields like `"Store, Inc",25.00`.
  - *Avoiding Regression*: Only activate `inQuotes` if `ch === '"'` occurs at the beginning of a cell (`cell.length === 0`). Treat mid-field quotes as literal characters.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/csv-import.test.ts`
  - **Test**: `parseCsv('2023-01-01,Store "A",Groceries,50.00')` returns `[['2023-01-01', 'Store "A"', 'Groceries', '50.00']]`.

---

### [BUG-13] Deferred Income to Past Months Creates Confusing Budget Display
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildRawIndexData()` (line 517)
- **Introduced In**:
  - **Commit**: `3b81bf1f` (*"feat: performance"*)
  - **Date**: 2026-08-18 09:23:41 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Optimization commit introducing raw indexing for budget data.
- **Description & Root Cause**:
  `buildRawIndexData()` attributes income strictly to `t.incomeMonth || mk`. If `incomeMonth` is set to a past month (e.g. transaction dated in March with `incomeMonth: "2024-01"`), the income appears in January's budget header, but January's register displays no transaction.
- **Reproduction / Scenario**:
  User receives a late bonus in March and flags it as "Income for January". January TBB increases, but January account registers show no activity.
- **Potential Impact**:
  Confusion when auditing historical monthly budgets against account statements.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `3b81bf1f`*: Support YNAB4's "Income for [Month]" deferrals.
  - *Avoiding Regression*: Support deferral forward and backward, but add visual indicator in the Inspector and Budget header explaining that $X of income originated from future/past transaction dates.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test**: Transaction dated `2026-03-15` with `incomeMonth: "2026-01"`. Verify `computeBudget(data, "2026-01").totalIncome` includes transaction amount and cumulative TBB flows forward into February and March.

---

### [BUG-14] "Overspent in Previous Month" Label Is Misleading When Months Are Skipped
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildCarryoverMap()` (lines 961–964)
- **Introduced In**:
  - **Commit**: `be5a407d` (*"fix: BUG-19 BUG-20 BUG-21"*)
  - **Date**: 2026-08-27 18:51:05 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `be5a407d` fixed carryover calculation over empty/gap months by looking up `mostRecentPrior` in the sparse data index.
- **Description & Root Cause**:
  `buildCarryoverMap` retrieves `overspentPrevious = index.overspentByMonth.get(mostRecentPrior)`. If a budget has activity in January, zero activity in February, and the user views March, `mostRecentPrior` is January. The UI renders "Overspent in Previous Month: $100", leading the user to believe February was overspent.
- **Reproduction / Scenario**:
  Overspend cash in Jan 2025. No entries in Feb 2025. Open Mar 2025 budget. Top banner says "Overspent in Previous Month: -$100".
- **Potential Impact**:
  Misleading UI copy.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `be5a407d`*: Ensure cash overspending from the latest active month is deducted from TBB across gaps.
  - *Avoiding Regression*: Maintain mathematical carryover deduction, but format label dynamically (e.g. `Overspent in ${monthLabel(mostRecentPrior)}`).
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test**: Jan cash overspend $50. Feb no data. Compute budget for March. Assert `priorSurplus` correctly subtracts $50 and `overspentPreviousMonthKey === "2025-01"`.

---

### [BUG-15] Net Worth Report Omits Account Balance Before First Transaction Month
- **Severity**: Medium
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function / Component / Symbol**: `computeNetWorthReport()` (lines 170–173)
- **Introduced In**:
  - **Commit**: `c272ac55` (*"fix(logic): clamp net-worth report balances prior to account creation (UNI-36)"*)
  - **Date**: 2026-08-17 09:31:38 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `c272ac55` attempted to fix an issue where new accounts back-calculated their starting balance into all historical months before the account was created.
- **Description & Root Cause**:
  Commit `c272ac55` added:
  ```typescript
  const earliest = earliestMonthByAccount.get(a.id);
  if (earliest && m < earliest) continue;
  ```
  If an account has no transactions in earlier months, it is skipped entirely. However, if an off-budget account (e.g. House, Car) has an initial base balance without transactions, or if starting balances were backdated, the net worth chart shows an artificial cliff/spike.
- **Reproduction / Scenario**:
  Create an off-budget tracking asset for $250,000. Add first adjustment transaction in March. Net worth report for Jan/Feb shows $0, spiking to $250k in March.
- **Potential Impact**:
  Distorted historical net worth graphs.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `c272ac55`*: Prevent an account opened in 2026 from artificially inflating 2020 net worth.
  - *Avoiding Regression*: Base the cutoff on the account's explicit `createdAt` or starting balance transaction date rather than the earliest transaction in the query window.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/reports.test.ts`
  - **Test**: Tracking account created Jan 2025 with $100k balance. First transaction Feb 2025. Assert Jan 2025 net worth point includes $100k.

---

### [BUG-16] Duplicate Detection Flags Identical Same-Day Purchases as Duplicates
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/duplicates.ts`
  - **Function / Component / Symbol**: `computeFingerprint()` (line 50)
- **Introduced In**:
  - **Commit**: `45477b00` (*"feat: flag duplicates"*)
  - **Date**: 2026-08-19 15:37:24 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial duplicate detection feature.
- **Description & Root Cause**:
  Fingerprint is `date:amount:payee`. Two independent, legitimate purchases on the same day for the same amount at the same merchant (e.g. two $4.50 coffees or transit fares) generate the same fingerprint and are grouped as duplicates.
- **Reproduction / Scenario**:
  Buy coffee at 8 AM for $4.50 and 2 PM for $4.50 on the same card. The app flags the second transaction as a duplicate.
- **Potential Impact**:
  Users may accidentally delete legitimate transactions.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `45477b00`*: Detect duplicated CSV imports.
  - *Avoiding Regression*: Match duplicate candidates based on available bank `fitId`/import ID, time/timestamp if available, or present them in the UI with an explicit *"N matching transactions"* disambiguation prompt rather than auto-selecting for deletion.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/duplicates.test.ts`
  - **Test**: Two transactions with same date, payee, amount, but different `fitId` / memo. Assert `findDuplicateGroups` marks them as distinct or requires user verification.

---

### [BUG-17] Duplicate Detection Exposes Reconciled Transactions for Deletion
- **Severity**: Medium
- **Category**: Database & API
- **Location**:
  - **File**: `packages/logic/src/duplicates.ts`
  - **Function / Component / Symbol**: `findDuplicateGroups()` (lines 90–105)
- **Introduced In**:
  - **Commit**: `45477b00` (*"feat: flag duplicates"*)
  - **Date**: 2026-08-19 15:37:24 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Part of initial duplicate detection logic.
- **Description & Root Cause**:
  When grouping identical transactions, `findDuplicateGroups()` sorts by ID and treats all but the first as duplicates to delete, without checking if any of the items are marked `status: "r"`.
- **Reproduction / Scenario**:
  An uncleared duplicate is imported that matches a historical reconciled transaction. If sorted incorrectly, the reconciled transaction is suggested for deletion.
- **Potential Impact**:
  Locked reconciled transactions can be deleted by duplicate cleanup.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `45477b00`*: Group duplicate rows.
  - *Avoiding Regression*: Reconciled transactions (`status === 'r'`) must always be treated as immutable primary rows; they can never be added to `duplicates` deletion candidates.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/duplicates.test.ts`
  - **Test**: Pass two matching transactions: one `status: "r"`, one `status: "u"`. Assert the `"r"` transaction is primary and the `"u"` transaction is marked duplicate.

---

### [BUG-18] Self-Transfer Produces Incorrect Running Balance
- **Severity**: Medium
- **Category**: Register & Balance
- **Location**:
  - **File**: `packages/logic/src/register.ts`
  - **Function / Component / Symbol**: `computeRunningBalances()` (lines 108–114)
- **Introduced In**:
  - **Commit**: `3b81bf1f` (*"feat: performance"*)
  - **Date**: 2026-08-18 09:23:41 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial single-pass running balance algorithm.
- **Description & Root Cause**:
  For an account register where `t.accountId === anchorId && t.transferAccountId === anchorId`, `isSource` and `isDest` are both `true`. The code branches on `delta = isSource ? amt : -amt`, applying `amt` once instead of canceling out to `0`.
- **Reproduction / Scenario**:
  Record transfer from Checking to Checking for $100. Register running balance shifts by $100.
- **Potential Impact**:
  Erroneous register balance.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `3b81bf1f`*: Unified register balance calculation for single and multi-account views.
  - *Avoiding Regression*: When `isSource && isDest`, explicitly set `delta = 0`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/register.test.ts`
  - **Test**: Compute running balance for an account with a $100 self-transfer. Assert running balance is unchanged before and after the row.

---

### [BUG-19] Reconcile Skips Split Parents When Children Carry Status
- **Severity**: Medium
- **Category**: Reconcile
- **Location**:
  - **File**: `packages/logic/src/reconcile.ts`
  - **Function / Component / Symbol**: `computeReconcileState()` (lines 63–66)
- **Introduced In**:
  - **Commit**: `e361d0e0` (*"fix: bug 3"*)
  - **Date**: 2026-08-25 13:22:04 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `e361d0e0` extracted reconcile math into pure logic in `@ynab/logic` to fix working balance calculation bugs.
- **Description & Root Cause**:
  `computeReconcileState` skips split parents (`if (parentIds.has(t.id)) continue;`) and sums child status. However, the UI toggle button sets `status = "c"` on the *parent* row. The children remain `"u"`. As a result, the cleared split transaction is omitted from the working balance.
- **Reproduction / Scenario**:
  Create a split transaction. Click the 'C' icon on the split parent in the register. Open Reconcile modal. Working balance does not include the split.
- **Potential Impact**:
  Reconciliation discrepancy whenever split transactions are cleared.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `e361d0e0`*: Prevent double-counting parent amount and child amounts.
  - *Avoiding Regression*: Exclude split parents from the sum, but ensure children inherit the parent's cleared/reconciled status when the parent is toggled, OR evaluate status from the parent while using children only for amounts.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/reconcile.test.ts`
  - **Test**: Split parent with `status: "c"` and two children with `status: "u"`. Assert `computeReconcileState` includes the split total in `clearedSum`.

---

### [BUG-20] Rename Rule Pattern Over-Generalizes Digits in Merchant Names
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/rename-rules.ts`
  - **Function / Component / Symbol**: `learnRenameRule()` / `inferRenameRule()` (lines 100–140)
- **Introduced In**:
  - **Commit**: `8e37293c` (*"feat: rename rules"*)
  - **Date**: 2026-08-19 23:28:05 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial implementation of automated payee pattern matching.
- **Description & Root Cause**:
  `inferRenameRule` replaces every digit sequence with `[N]`. `"7-ELEVEN STORE 123"` becomes `"[N]-ELEVEN STORE [N]"`, which matches unrelated merchants like `"11-ELEVEN"`. Furthermore, if target "Groceries" has multiple diverse source payees ("Safeway", "Trader Joe's", "BCF1"), new entries like "BCF2" fail to infer `BCF[N]` because the algorithm requires all existing sources for the target to share the same prefix.
- **Reproduction / Scenario**:
  Rename "Uber 123" -> "Taxis", and "Lyft 456" -> "Taxis". Import "Uber 789". The system fails to infer `Uber [N]` -> `Taxis`.
- **Potential Impact**:
  Degraded auto-categorization and noisy rename rule tables.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `8e37293c`*: Automatically learn rules like `AMZN Mktp US*123` -> `Amazon`.
  - *Avoiding Regression*: Only generalize trailing store/transaction numbers (e.g. 3+ digits at word boundaries) and cluster sources by prefix before inferring wildcard patterns.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/rename-rules.test.ts`
  - **Test**: Infer rule for "7-Eleven Store 456" -> "7-Eleven". Pattern should be `7-Eleven Store [N]`, not `[N]-Eleven Store [N]`.

---

### [BUG-21] Recurring Anchor Day Silently Overwritten from `nextDate`
- **Severity**: Medium
- **Category**: Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `updateRecurring()` (lines 341–351)
- **Introduced In**:
  - **Commit**: `287f3250` (*"fix: BUG-16 BUG-17 BUG-18"*)
  - **Date**: 2026-08-30 23:12:44 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `287f3250` attempted to ensure that editing a recurring transaction's `nextDate` kept the schedule anchor synchronized.
- **Description & Root Cause**:
  Lines 344–346 overwrite `anchorDay = parseInt(patch.nextDate.slice(8, 10), 10)`. If a monthly schedule is anchored to the 31st, and the user edits `nextDate` to February 28, `anchorDay` is permanently overwritten to 28. Future months trigger on the 28th instead of the 31st.
- **Reproduction / Scenario**:
  1. Create monthly recurring rule for day 31.
  2. Edit `nextDate` to `"2025-02-28"`.
  3. Advance schedule to March: next date becomes `"2025-03-28"` instead of `"2025-03-31"`.
- **Potential Impact**:
  Permanent schedule drift after short months.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `287f3250`*: Update anchor day when user explicitly changes the recurring schedule day.
  - *Avoiding Regression*: Only overwrite `anchorDay` if `patch.anchorDay` is explicitly provided, or if the new `nextDate` day is larger than the existing `anchorDay`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/recurring.test.ts`
  - **Test**: Recurring rule with `anchorDay: 31`. Update with `patch: { nextDate: "2025-02-28" }`. Assert reloaded rule retains `anchorDay: 31`. Advance date: assert next occurrence is `"2025-03-31"`.

---

### [BUG-22] YNAB4 Import Milliunit Detection Fails for Sub-Dollar Transactions
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `detectMilliunitScale()` (lines 100–113)
- **Introduced In**:
  - **Commit**: `7b736de0` (*"fix: BUG-04 BUG-05 BUG-06"*)
  - **Date**: 2026-08-30 22:00:57 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `7b736de0` added integer scale detection to distinguish between decimal dollar exports and milliunit backups.
- **Description & Root Cause**:
  `detectMilliunitScale` checks `if (abs < 1000 && abs % 100 !== 0) return false;`. In YNAB4 milliunits, any sub-dollar amount like $0.99 is `990` milliunits (`990 < 1000` and `990 % 100 !== 0`), which triggers `return false`. The importer concludes the file is decimal dollars and skips dividing by 10.
- **Reproduction / Scenario**:
  Import a standard YNAB4 backup containing a $0.99 app store purchase. The whole budget is imported 10× inflated ($50 groceries becomes $500).
- **Potential Impact**:
  Severe budget corruption on importing genuine YNAB4 archives.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `7b736de0`*: Support importing backups from systems that stored whole dollars (e.g. 15, 25, 45).
  - *Avoiding Regression*: YNAB4 milliunits are always multiples of 10 (`abs % 10 === 0`). Test `abs % 10 !== 0` to detect decimal integers, rather than `% 100`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/import-ynab4-scale.test.ts`
  - **Test**: Backup with amounts `[990, 15000, 45250, 1200000]`. Assert `detectMilliunitScale` returns `true`.

---

### [BUG-23] Cash Advance Locks Borrowed Cash in CC Payment Category
- **Severity**: Low
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeAllMonths()` (lines 671–673)
- **Introduced In**:
  - **Commit**: `f207ad4d` (*"fix: bug 7"*)
  - **Date**: 2026-08-25 14:51:46 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `f207ad4d` overhauled credit card transfers and cash advances.
- **Description & Root Cause**:
  Cash advances from a credit card to checking are added to `cardAdvances` which increases `ccBuffer` on the CC Payment category. This locks the borrowed cash in the payment category, requiring manual negative budgeting to free the funds.
- **Reproduction / Scenario**:
  Transfer $200 from Credit Card to Checking. Checking balance increases by $200, but CC Payment category available increases by $200.
- **Potential Impact**:
  Confusing workflow for cash advances.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `f207ad4d`*: Track debt incurred from credit card cash advances.
  - *Avoiding Regression*: Keep debt tracking on the account balance, but do not automatically add borrowed advance cash to the CC payment category buffer unless user assigns it.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/budget-engine.test.ts`
  - **Test**: Transfer $100 from CC to Checking. Assert Checking balance is +$100, CC balance is -$100, CC Payment category buffer is $0, and TBB is unchanged.

---

### [BUG-24] YNAB4 Export Generates Non-Standard Entity IDs
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/export-ynab4.ts` (lines 200–240)
- **Introduced In**:
  - **Commit**: `629a980c` (*"feat: backups"*)
  - **Date**: 2026-08-23 10:16:03 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **No**. Initial export implementation.
- **Description & Root Cause**:
  Export fabricates entity IDs like `tx-${t.id}` instead of preserving original YNAB4 UUIDs.
- **Reproduction / Scenario**:
  Import YNAB4 file, then export. Entity IDs are rewritten to synthetic strings.
- **Potential Impact**:
  Re-importing causes entity duplication.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `629a980c`*: Generate valid string IDs for JSON export.
  - *Avoiding Regression*: Store original entity UUIDs in metadata/db columns when importing, and re-emit them on export.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/server/tests/export.test.ts`
  - **Test**: Import transaction with UUID `A1B2-C3D4`. Export budget. Assert exported transaction entityId is `A1B2-C3D4`.

---

### [BUG-25] `numCents()` Accepts Trailing Decimal Point
- **Severity**: Low
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `numCents()` (lines 180–190)
- **Introduced In**:
  - **Commit**: `7b3c9dd7` (*"fix: BUG-34 BUG-35 BUG-36 BUG-37"*)
  - **Date**: 2026-08-27 22:15:55 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `7b3c9dd7` added strict validation in `numCents()` to reject float cents.
- **Description & Root Cause**:
  Input `"123."` produces `parts[1] = ""`. The check `if (parts[1] && !/^0+$/.test(parts[1]))` evaluates to `false` because `""` is falsy, bypassing validation.
- **Reproduction / Scenario**:
  `numCents("123.")` returns `123` instead of throwing `TypeError`.
- **Potential Impact**:
  Minor inconsistency with strict parser specification.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `7b3c9dd7`*: Reject fractional cents like `"123.45"`.
  - *Avoiding Regression*: Reject any input where `str.endsWith(".")`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/format.test.ts`
  - **Test**: `expect(() => numCents("123.")).toThrow(TypeError)`.

---

### [BUG-26] CSV Date Format Detection Defaults to MDY for Ambiguous European Dates
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `detectDateFormat()` (lines 250–280)
- **Introduced In**:
  - **Commit**: `cc9da6f6` (*"fix: 9.2"*)
  - **Date**: 2026-08-24 12:18:22 -0700
  - **Author**: Radek Stepan
- **Introduced As Part of Another Bug Fix?**:
  - **Yes**. Commit `cc9da6f6` implemented voting heuristics for ambiguous dates.
- **Description & Root Cause**:
  When all date rows have day ≤ 12 and month ≤ 12, the voting logic cannot disambiguate and hardcodes a fallback to `MDY`.
- **Reproduction / Scenario**:
  Import UK statement with dates `01/02/2024` through `05/02/2024`. All dates are interpreted as January/May instead of February.
- **Potential Impact**:
  Dates swapped by months for European CSV files.
- **Original Intent & Avoiding Regressions**:
  - *Original Intent in `cc9da6f6`*: Automatically detect date formats without prompting.
  - *Avoiding Regression*: Keep automatic detection when unambiguous (>12 present), but flag ambiguous imports in the UI preview modal so the user can toggle between `DD/MM/YYYY` and `MM/DD/YYYY`.
- **Regression Test Plan & Assertions**:
  - **File**: `packages/logic/tests/csv-import.test.ts`
  - **Test**: `detectDateFormat(['01/02/2024', '05/03/2024'])` returns `{ format: 'MDY', isAmbiguous: true }`.

---

## Production Readiness Assessment & Next Steps

### Root Cause Analysis of Past Regressions
The primary reason bug fixes in this codebase have repeatedly introduced secondary bugs is **the lack of multi-variant regression tests for edge cases**:
1. When CC refund handling was added (`0c232f3b`), tests only verified positive flows and missed order-of-operations dependency.
2. When credit card starting balances were excluded from income (`ee80f9f3`), tests only verified uncategorized transactions and missed manual cashback credits with `isIncome: true`.
3. When split child validation was added (`11c27fe8`), tests verified that splits have 2+ children but missed the deletion UX workflow where a user removes a child.

### Mandatory Rules for Future Fixes
1. **Never commit a bug fix without both a Positive Test (asserting the fix works) AND a Negative Invariant Test (asserting previous behaviors still hold).**
2. **Every bug fix PR must include test cases covering multi-month carryovers and edge cases (reconciliation locks, split clusters, transfers).**
3. **Execute the full test suite (`yarn test`) across all packages before merging.**
