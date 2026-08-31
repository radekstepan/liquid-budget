# Codebase Audit & Bug Report

**Audit Date**: 2026-08-31
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

The codebase demonstrates strong engineering fundamentals — the budget engine correctly implements cumulative envelope budgeting, the `dollarsToCents` function uses string-based decimal arithmetic to avoid IEEE 754 artifacts, and the `evalAmount` parser is a proper hand-rolled expression evaluator (not `eval()`). However, the audit uncovered several critical accounting issues, data integrity risks, and UI-level bugs that can silently corrupt financial data or produce incorrect budget calculations.

The most severe cluster of issues involves **credit card buffer accounting** (order-dependent CC refund math, phantom money from unfunded refunds, cash advance locking), **reconciliation status sharing** (a single `status` column governs both sides of a transfer), and the **Transaction Modal silently demoting reconciled transactions** from `"r"` to `"c"` on any edit.

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
- **Description & Root Cause**:
  Within a single month, credit card *spends* are correctly clamped using `Math.max(0, Math.min(runningCashPool, spend))` so only funded portions transfer to the CC buffer. However, credit card *refunds* (positive `tx.amount`) are **unconditionally subtracted** from `monthFundedCCByAccount` and `catFundedCC` (lines 626–632), regardless of whether there was any funded spending to reverse. Because the inner loop processes transactions in chronological order (`sortedTxs`), the net CC buffer for a category can vary depending on whether a refund arrives before or after the related spend.
- **Reproduction / Scenario**:
  Category has $0 starting balance.
  - *Scenario A*: CC Spend $100 (funded=$0 since pool is $0), then CC Refund $50 → `catFundedCC` = 0 − 50 = −$50. Net buffer = **−$50**.
  - *Scenario B*: CC Refund $50 → `catFundedCC` = 0 − 50 = −$50. Then CC Spend $100 (pool now $50, funded=$50) → `catFundedCC` = −50 + 50 = $0. Net buffer = **$0**.
  
  Same transactions, different order, different budget outcome.
- **Potential Impact**:
  CC Payment category balances fluctuate based on arbitrary import/sort order of same-day transactions. This can cause the CC Payment category to show phantom negative debt or phantom surplus, misleading the user about how much to pay toward their credit card.
- **Recommended Resolution**:
  Refund amounts should be clamped to the previously-funded pool for that category+account pair, not subtracted unconditionally. Track funded spending separately and only reverse refunds up to the funded amount. Alternatively, compute a net spend/refund per category before applying clamped funding logic.

---

### [BUG-02] CC Refund on Unfunded Spending Creates "Phantom Money"
- **Severity**: Critical
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeAllMonths()` — First and Second passes
- **Description & Root Cause**:
  A corollary of BUG-01. When a user receives a CC refund for spending that was *unfunded* in a prior month, the unconditional subtraction of the refund from `monthFundedCCByAccount` makes the CC Payment category's available balance go *negative*. Because cash overspending checks explicitly skip CC Payment categories (`if (ccGroupIds.has(c.groupId)) continue;` at line 660), this negative balance never deducts from TBB.
  
  Meanwhile, the refund adds positive `rawFlow` back to the spending category, increasing its available balance. The user can then reassign that freed-up money elsewhere — effectively "printing" cash that isn't backed by any real income.
- **Reproduction / Scenario**:
  1. January: Overspend Groceries by $50 on CC (unfunded — pool was $0).
  2. February: Receive a $50 CC refund to Groceries. Groceries gains +$50 available. CC Payment drops to −$50 (but no TBB deduction because it's a CC category).
  3. User moves the +$50 from Groceries to Rent and spends it.
  
  Result: $50 of phantom money in the budget with no TBB warning.
- **Potential Impact**:
  Budget shows more available money than actually exists. User overspends without the budget warning them. This undermines the core envelope budgeting guarantee.
- **Recommended Resolution**:
  Track cumulative funded CC spending per account and clamp refund reversals to the funded amount. Any refund exceeding the funded pool should reduce the CC debt directly without freeing cash in the spending category.

---

### [BUG-03] Transaction Modal Silently Demotes Reconciled Transactions to "Cleared"
- **Severity**: Critical
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/Modals.tsx`
  - **Function / Component / Symbol**: `TransactionModal` — `save()` function, `cleared` state initialization
- **Description & Root Cause**:
  The modal initializes `cleared` state at line 155:
  ```typescript
  const [cleared, setCleared] = useState<boolean>(initial?.status === "c" || initial?.status === "r" || initial?.status == null);
  ```
  When `status === "r"` (reconciled), `cleared` is set to `true`. On save, the status is hardcoded to:
  ```typescript
  status: cleared ? "c" : "u"
  ```
  (lines 293, 312, 350). This means editing *any* field (memo, payee, flag) of a reconciled transaction silently downgrades its status from `"r"` (reconciled) to `"c"` (cleared), breaking the reconciliation state.
- **Reproduction / Scenario**:
  1. Reconcile an account (transactions become status `"r"`).
  2. Open any reconciled transaction in the edit modal.
  3. Change just the memo and save.
  4. The transaction's status silently changes from `"r"` to `"c"`.
- **Potential Impact**:
  Destroys reconciliation integrity. Previously locked transactions become unlocked. Future reconciliation rounds will re-process these transactions, potentially creating incorrect adjustment balances. The user receives no warning.
- **Recommended Resolution**:
  Preserve the original status when the transaction was already reconciled. If `initial?.status === "r"`, the save payload should emit `status: "r"` unless the user explicitly unchecked the cleared checkbox (which should require a reconcile warning). Alternatively, block editing of reconciled transactions in the modal entirely.

---

### [BUG-04] Single `status` Column Shared Across Both Sides of a Transfer
- **Severity**: Critical
- **Category**: Database & API / Reconcile
- **Location**:
  - **File**: `packages/server/src/schema.ts` — `transactions` table
  - **File**: `packages/server/src/queries/reconcile.ts` — `reconcileAccount()` (lines 182–196)
- **Description & Root Cause**:
  Transfers are stored as a single row with both `accountId` and `transferAccountId`. The `status` column (`"u"`, `"c"`, `"r"`) applies to both accounts simultaneously. When Account A is reconciled, the reconcile query flips the transfer's status to `"r"` — but this also marks it as reconciled in Account B, even though it may not have cleared Account B's bank statement yet.
- **Reproduction / Scenario**:
  1. Transfer $100 from Checking (Account A) to Savings (Account B).
  2. Mark the transaction as cleared in Checking.
  3. Reconcile Checking. The transfer's status becomes `"r"`.
  4. Open Savings — the transfer already shows as reconciled, preventing accurate reconciliation of Savings.
- **Potential Impact**:
  Prevents correct reconciliation of the receiving account. Working balance calculations for the receiving account include this transaction as already reconciled when it may still be pending at the bank.
- **Recommended Resolution**:
  Either add a `destStatus` column for the transfer destination's independent status, or split transfers into two linked rows (one per account) with independent status columns, similar to how YNAB4 stores transfer pairs.

---

### [BUG-05] YNAB4 Export Uses Dollars Instead of Milliunits
- **Severity**: Critical
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/export-ynab4.ts`
  - **Function / Component / Symbol**: `exportYnab4()` — all `amount / 100` expressions (lines 288, 350, 370, 389, 427, 448, 478, 528, 549)
- **Description & Root Cause**:
  The export divides internal cents by 100 (`amount / 100`), producing decimal dollar amounts (e.g., `15.00` for $15). YNAB4's native format uses **milliunits** (thousandths of a dollar, e.g., `15000` for $15). The exported backup file is therefore incompatible with YNAB4.
- **Reproduction / Scenario**:
  1. Export a budget containing a $15.00 transaction (stored as 1500 cents).
  2. The exported JSON contains `"amount": 15`.
  3. Import into YNAB4 — all values are 1000× smaller ($15 becomes $0.015).
- **Potential Impact**:
  Complete loss of financial fidelity in exported backups. Imported data in YNAB4 will show all amounts as fractions of cents.
- **Recommended Resolution**:
  Multiply cents by 10 (`amount * 10`) for all exported currency fields to produce milliunits. Apply to budgeted amounts, transaction amounts, sub-transaction amounts, reconciliation balances, and scheduled transaction amounts.

---

### [BUG-06] Credit Card Income / Cashbacks Dropped from Budget
- **Severity**: High
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `isIncomeTransaction()` (line 94)
- **Description & Root Cause**:
  For regular (non-transfer) transactions, `isIncomeTransaction()` has an early exit at line 94:
  ```typescript
  if (accA && accA.kind === "credit") return false;
  ```
  This executes *before* checking the `isIncome` flag or the transaction amount. Any positive uncategorized transaction on a credit card account is therefore never classified as income.
- **Reproduction / Scenario**:
  User receives a $50 cashback credit on their credit card, categorized as "To Be Budgeted" (null category). The transaction reduces the CC balance (correct) but is never counted as income, so TBB is permanently missing this $50.
- **Potential Impact**:
  CC cashbacks, statement credits, and reward redemptions silently disappear from the budget. TBB is understated.
- **Recommended Resolution**:
  Allow credit card transactions to be classified as income when they have a null category, positive amount, and `isIncome === true`. Move the `kind === "credit"` check to only apply as a fallback when `isIncome` is not explicitly set.

---

### [BUG-07] Deleting a Split Child Cascades into Full Transaction Deletion
- **Severity**: High
- **Category**: Splits & Transfers
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function / Component / Symbol**: `deleteTransaction()` (lines 1022–1037)
- **Description & Root Cause**:
  When a split child is deleted and only one sibling remains, the code deletes both the last remaining child AND the parent transaction (lines 1024–1037). This is intended to prevent invalid 1-child splits, but the result is that deleting one category allocation from a split silently destroys the entire receipt.
- **Reproduction / Scenario**:
  1. Create a $100 split: $60 Groceries + $40 Dining.
  2. Delete the $40 Dining child.
  3. The $60 Groceries child AND the parent are both deleted. The entire $100 transaction vanishes.
- **Potential Impact**:
  Silent data loss. The user expects only the deleted category to be removed; instead the entire transaction (including the remaining categorized portion) is permanently deleted and the account balance changes by the full transaction amount.
- **Recommended Resolution**:
  When only one child remains, convert it into a regular (non-split) transaction by removing its `parentId` and deleting the parent row. Preserve the remaining child's amount, category, memo, and other fields.

---

### [BUG-08] `evalAmount` Unary Minus Parser Silently Absorbs Spaces, Producing Wrong Amounts
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `evalAmount()` — unary minus tokenizer loop (lines 310–324)
- **Description & Root Cause**:
  The unary-minus number tokenizer skips whitespace (lines 319–320: `else if (cc === " ") { i++; }`) and continues accumulating digits. The regular (positive) number tokenizer at lines 342–354 correctly *breaks* on whitespace. This asymmetry means:
  - `"5 5"` → correctly returns `null` (rejected)
  - `"-5 5"` → silently parses as `-55`
- **Reproduction / Scenario**:
  User types `-5 50` in an amount field (intending `-5.50` but hitting space instead of period). `evalAmount` returns `-550`. After `dollarsToCents(-550)` = `-55000`, the transaction is recorded as −$550.00 instead of the intended −$5.50.
- **Potential Impact**:
  A common typo (space instead of decimal point in negative amounts) silently records an amount 100× larger than intended. For a negative amount, this could overdraw a budget category by hundreds of dollars.
- **Recommended Resolution**:
  Make the unary-minus tokenizer `break` on whitespace instead of skipping it, matching the behavior of the positive-number tokenizer.

---

### [BUG-09] Optimistic Rollback Race Condition Wipes Later Updates
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `apps/web/src/components/BudgetAppShell.tsx`
  - **Function / Component / Symbol**: Multiple mutation functions (`assign`, `addTransaction`, `updateTransaction`, etc.)
- **Description & Root Cause**:
  Each mutation captures `const snapshot = dataRef.current` synchronously before applying optimistic updates. If Request A fails and triggers rollback via `setData(snapshot)`, it restores state to before Request A — but this also wipes the optimistic updates from Requests B and C that were applied *after* the snapshot was taken, even if B and C will succeed.
- **Reproduction / Scenario**:
  1. User rapidly toggles flags on 3 transactions (Requests A, B, C).
  2. Request A fails (network timeout).
  3. `onRollback` restores state to before Request A, undoing B and C's optimistic updates.
  4. B and C succeed on the server, but the UI shows stale data until `reload()` completes.
- **Potential Impact**:
  Brief but confusing UI desync. In-flight successful edits disappear from the UI momentarily. With slow networks, the user may re-enter data they believe was lost.
- **Recommended Resolution**:
  Use a versioned snapshot or operation log that allows individual rollbacks without affecting other in-flight operations. Alternatively, always `reload()` on any failure rather than restoring a stale snapshot.

---

### [BUG-10] `useLocalStorage` Performs I/O Inside React State Updater — Crashes on Storage Quota
- **Severity**: High
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/useLocalStorage.ts`
  - **Function / Component / Symbol**: `setValue()` (lines 53–61)
- **Description & Root Cause**:
  The `setValue` callback invokes `window.localStorage.setItem()` inside the `setStoredValue` state updater (line 59). React may execute state updater functions during the render phase. If `setItem` throws (e.g., `QuotaExceededError` when storage is full, or `SecurityError` when cookies are disabled), the error is thrown *inside React's render cycle*, not within the outer `try/catch` at line 52 (which only catches synchronous errors from the `setStoredValue` call itself, not from the queued updater function).
- **Reproduction / Scenario**:
  1. Fill `localStorage` to capacity (5 MB in most browsers).
  2. Change a column sort or collapse a category group (triggers `useLocalStorage` write).
  3. `QuotaExceededError` crashes the React render cycle → white screen.
- **Potential Impact**:
  Application crashes with a white screen. No error boundary catches this because it occurs inside the React render phase. Requires manual clearing of localStorage or cache to recover.
- **Recommended Resolution**:
  Move the `localStorage.setItem` call to a `useEffect` that runs after render, or wrap it in its own try/catch inside the updater function. The state updater should only compute and return the new value.

---

### [BUG-11] Recurring Auto-Post Silently Drops Transactions After Cap
- **Severity**: High
- **Category**: Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `autoPostDueRecurringTransactions()` (lines 596–614)
- **Description & Root Cause**:
  When the app hasn't been opened for a long time, the auto-post loop caps at 5 occurrences per rule (`maxPerRule = 5`). Remaining due occurrences are counted and logged to the `capped` array but are **silently discarded** — the rule's `nextDate` is not advanced past the capped date. On the next app open, the same rule will attempt auto-posting again from where it left off, but only 5 more will be posted.
  
  However, the capped transactions are never posted and are not surfaced to the user as a warning. The user's ledger silently diverges from reality.
- **Reproduction / Scenario**:
  1. Create a weekly recurring transaction ($50/week).
  2. Don't open the app for 6 months (~26 occurrences due).
  3. App posts 5 transactions. The remaining ~21 are logged as `capped` but never posted.
  4. Account balance is $1,050 short of reality.
- **Potential Impact**:
  Severe ledger-to-reality divergence. User's budget and account balances are significantly incorrect after a long absence. No notification alerts the user to the gap.
- **Recommended Resolution**:
  Surface capped recurring transactions as a prominent user notification (toast/modal) explaining that N transactions were skipped and offering to post them. Alternatively, advance `nextDate` past the capped range and create a single catch-up summary transaction.

---

### [BUG-12] CSV Parser Treats Mid-Field Quotes as Quote-Mode Toggle
- **Severity**: High
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseCsv()` (line 92)
- **Description & Root Cause**:
  At line 92, when a `"` character is encountered outside of quote mode, the parser unconditionally enters quote mode (`inQuotes = true`) regardless of position within the cell. Per RFC 4180, a quoted field must begin with a `"` immediately after the comma delimiter. If a field contains a natural quote mid-value (e.g., `Store "A"`), the parser enters quote mode mid-cell, causing subsequent commas to be absorbed into the current field.
- **Reproduction / Scenario**:
  Import a CSV row: `2023-01-01,Store "A",Some memo,25.00`
  
  The parser hits the `"` before `A`, enters quote mode, absorbs the comma after `A"` and `Some memo` into the same field. Result: payee is `Store A,Some memo` and the amount field is missing.
- **Potential Impact**:
  Corrupted transaction data during CSV import. Fields are shifted, amounts may be parsed from memo text, and transactions may be silently malformed.
- **Recommended Resolution**:
  Only enter quote mode when `"` appears at the start of a field (i.e., when `cell === ""` or immediately after a comma/newline). Mid-field quotes should be treated as literal characters.

---

### [BUG-13] Deferred Income to Past Months Creates Confusing Budget Display
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildRawIndexData()` (line 517), `getMonthsWithData()` (line 943)
- **Description & Root Cause**:
  When a transaction has `incomeMonth` set to a month before the transaction's date, the income IS correctly recorded in the `incomeByMonth` map for that past month, and `getMonthsWithData()` includes `t.incomeMonth` in the ordered months list. The accounting math is technically correct. However, the past month shows income from a transaction that doesn't exist in that month's register — the user sees income in a month where no corresponding transaction is visible in the register view.
- **Reproduction / Scenario**:
  User creates an income transaction dated March 15 with `incomeMonth = "2024-01"`. January's budget view shows income, but January's register has no corresponding transaction.
- **Potential Impact**:
  Confusing UX. The accounting is correct but the budget and register views are inconsistent for the affected month.
- **Recommended Resolution**:
  Consider warning or blocking `incomeMonth` values earlier than the transaction date. If backward deferral is intentional, add a UI indicator showing deferred income from future-dated transactions.

---

### [BUG-14] "Overspent in Previous Month" Label Is Misleading When Months Are Skipped
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildCarryoverMap()` (lines 961–964)
- **Description & Root Cause**:
  `buildCarryoverMap` uses `mostRecentPrior` to find the "overspent previous" amount. If there's a gap in activity (e.g., data in January, none in February, data in March), `mostRecentPrior` resolves to January when viewing March. The UI displays "Overspent in Previous Month" but refers to January's overspending, not February's (which had no data).
- **Reproduction / Scenario**:
  1. Overspend $100 in a category in January 2025.
  2. No activity in February 2025.
  3. View March 2025's budget. "Overspent in Previous Month" shows $100 from January.
- **Potential Impact**:
  UI label is misleading when there's a gap. The TBB calculation itself is correct.
- **Recommended Resolution**:
  Display the actual month name (e.g., "Overspent in January") rather than the generic "Previous Month" when there's a gap.

---

### [BUG-15] Net Worth Report Omits Account Balance Before First Transaction Month
- **Severity**: Medium
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function / Component / Symbol**: `computeNetWorthReport()` (lines 170–173)
- **Description & Root Cause**:
  The code at lines 170–173 skips including an account's balance for months before its first transaction (`if (earliest && m < earliest) continue;`). For accounts created with a starting-balance transaction, the pre-transaction balance is correctly $0. However, this causes a visual "spike" in the net worth chart when accounts first appear, rather than showing a gradual ramp. More importantly, if the report start date is moved before all accounts' first transactions, net worth appears as $0.
- **Reproduction / Scenario**:
  1. Create a savings account with a $10,000 starting balance dated March 2024.
  2. View Net Worth report from January 2024. January and February show $0, March spikes to $10,000.
- **Potential Impact**:
  Net worth chart is misleading in historical months before accounts were created.
- **Recommended Resolution**:
  Use the `initialBalance` (currentBalance − totalDelta) for months before the first transaction, rather than suppressing the account entirely. Only suppress if the computed initial balance is $0.

---

### [BUG-16] Duplicate Detection Flags Identical Same-Day Purchases as Duplicates
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/duplicates.ts`
  - **Function / Component / Symbol**: `computeFingerprint()` / `findDuplicateGroups()`
- **Description & Root Cause**:
  The fingerprint is computed from `date + amount + normalizedPayee`. Two genuinely different transactions on the same day with the same amount to the same payee produce identical fingerprints. Split parent transactions are also not excluded from fingerprinting, creating false matches.
- **Reproduction / Scenario**:
  Buy two coffees from "Starbucks" for $5.00 on the same day. Both are flagged as duplicates.
- **Potential Impact**:
  False-positive duplicate flags lead users to delete legitimate transactions, corrupting their balance.
- **Recommended Resolution**:
  Include the transaction ID or a sequence number in the fingerprint. Exclude split parents from duplicate detection.

---

### [BUG-17] Duplicate Detection Exposes Reconciled Transactions for Deletion
- **Severity**: Medium
- **Category**: Database & API
- **Location**:
  - **File**: `packages/logic/src/duplicates.ts`
  - **Function / Component / Symbol**: `findDuplicateGroups()`
- **Description & Root Cause**:
  When a duplicate group contains reconciled transactions (`status === "r"`), the grouping algorithm may push reconciled transactions into the `duplicates` list (available for deletion), even though reconciled transactions should be locked.
- **Reproduction / Scenario**:
  Two identical reconciled transactions exist (from historical import). Duplicate detection flags one for deletion. User confirms → reconciled transaction is deleted → reconciliation state is corrupted.
- **Potential Impact**:
  Reconciled transaction lock is bypassed. Account balance and reconciliation history become inconsistent.
- **Recommended Resolution**:
  Filter reconciled transactions from duplicate detection, or always keep reconciled transactions as the "primary" member of a group.

---

### [BUG-18] Self-Transfer Produces Incorrect Running Balance
- **Severity**: Medium
- **Category**: Register & Balance
- **Location**:
  - **File**: `packages/logic/src/register.ts`
  - **Function / Component / Symbol**: `computeRunningBalances()` — single-account anchor mode (lines 103–115)
- **Description & Root Cause**:
  For a self-transfer (source and destination are the same account), both `isSource` and `isDest` are `true`, but `delta = isSource ? amt : -amt` only evaluates the `isSource` branch. The balance should net to zero, but the code applies the amount once.
- **Reproduction / Scenario**:
  Create a transfer from Account A to Account A for $100. View Account A's register. Running balance is shifted by $100 instead of $0.
- **Potential Impact**:
  Incorrect running balance display for the affected account. Self-transfers are an edge case but should net to zero.
- **Recommended Resolution**:
  When `isSource && isDest` (self-transfer), set `delta = 0`.

---

### [BUG-19] Reconcile Skips Split Parents When Children Carry Status
- **Severity**: Medium
- **Category**: Reconcile
- **Location**:
  - **File**: `packages/logic/src/reconcile.ts`
  - **Function / Component / Symbol**: `computeReconcileState()` (lines 63–66)
  - **File**: `packages/server/src/queries/reconcile.ts`
  - **Function / Component / Symbol**: `reconcileAccount()` (lines 198–218)
- **Description & Root Cause**:
  The client-side `computeReconcileState()` skips split parents and aggregates status from children. In the UI, clearing is done at the parent level. If children default to `"u"`, the split's amount drops out of the working balance despite the user having cleared the parent.
- **Reproduction / Scenario**:
  1. Create a split transaction with 3 children.
  2. Mark the parent as "Cleared" in the register.
  3. Open reconcile modal — working balance excludes the split amount because children are still `"u"`.
- **Potential Impact**:
  Working balance is understated during reconciliation. User must manually clear each split child.
- **Recommended Resolution**:
  Propagate the parent's status to all children when the parent is cleared.

---

### [BUG-20] Rename Rule Pattern Over-Generalizes Digits in Merchant Names
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/rename-rules.ts`
  - **Function / Component / Symbol**: `learnRenameRule()` / `inferRenameRule()`
- **Description & Root Cause**:
  The rule inference replaces ALL digit sequences with `[N]` wildcards. Merchant names containing meaningful digits ("7-Eleven", "24 Hour Fitness") get over-generalized. Additionally, if a target payee has multiple unrelated sources, pattern inference fails silently.
- **Reproduction / Scenario**:
  1. Rename `"Uber"` → `"Transport"`.
  2. Rename `"BCF1"` → `"Transport"`.
  3. Encounter `"BCF2"` — inference should suggest `"BCF[N]"` but fails because `"Uber"` is an existing source.
- **Potential Impact**:
  Pattern generalization silently fails for payees with mixed sources. Creates excessive exact-match rules.
- **Recommended Resolution**:
  Group existing sources by prefix/suffix when inferring patterns, ignoring unrelated sources for the same target.

---

### [BUG-21] Recurring Anchor Day Silently Overwritten from `nextDate`
- **Severity**: Medium
- **Category**: Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `updateRecurring()`
- **Description & Root Cause**:
  When updating a recurring rule without providing `patch.anchorDay`, the anchor day is extracted from the `nextDate` string. Setting `nextDate` to a short month (e.g., Feb 28) permanently changes the anchor from 31 to 28.
- **Reproduction / Scenario**:
  1. Create a monthly recurring on the 31st.
  2. Edit and set `nextDate` to `"2024-02-28"`.
  3. Anchor day permanently becomes 28. Future months trigger on 28th instead of month-end.
- **Potential Impact**:
  Recurring transactions permanently drift to the wrong day.
- **Recommended Resolution**:
  Only update `anchorDay` when explicitly provided. Preserve existing `anchorDay` when only `nextDate` changes.

---

### [BUG-22] YNAB4 Import Milliunit Detection Fails for Sub-Dollar Transactions
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `detectMilliunitScale()` (lines 100–113)
- **Description & Root Cause**:
  A valid YNAB4 transaction of $0.99 = 990 milliunits triggers `smallNonMultipleOf100Count > 0` (because `990 % 100 !== 0`), causing the detector to return `false` (decimal dollars). The importer then treats all milliunits as dollars, inflating amounts by 10×.
- **Reproduction / Scenario**:
  Import a standard YNAB4 backup with a $0.99 transaction. The detector incorrectly classifies the format. A $50 grocery transaction (5000 milliunits) becomes $500.
- **Potential Impact**:
  All amounts inflated 10× on import. Catastrophic for budget data.
- **Recommended Resolution**:
  Improve the heuristic to consider typical milliunit ranges. Allow user manual confirmation of scale factor during import.

---

### [BUG-23] Cash Advance Locks Borrowed Cash in CC Payment Category
- **Severity**: Low
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeAllMonths()` — `cardAdvances` handling (lines 671–673)
- **Description & Root Cause**:
  Cash advances from CC to checking are added to the CC buffer, locking the borrowed cash in the CC Payment category. The user must manually negative-budget the CC Payment category to use the borrowed money.
- **Reproduction / Scenario**:
  Transfer $100 from CC to Checking. $100 appears in Checking but is locked in CC Payment. Manual negative budgeting required to free it.
- **Potential Impact**:
  Confusing UX for cash advances. May match original YNAB4 behavior by design.
- **Recommended Resolution**:
  Document as intended behavior or add a UI indicator explaining cash advance budget mechanics.

---

### [BUG-24] YNAB4 Export Generates Non-Standard Entity IDs
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/export-ynab4.ts`
  - **Function / Component / Symbol**: `exportYnab4()`
- **Description & Root Cause**:
  Export generates entity IDs like `tx-${t.id}` based on local auto-incrementing keys rather than preserving original YNAB4 UUIDs. Breaks roundtrip fidelity.
- **Reproduction / Scenario**:
  Import a YNAB4 backup, immediately export. All entity IDs change. External tools can't reconcile the data.
- **Potential Impact**:
  Export → reimport duplicates all entities. YNAB4 ecosystem interoperability is broken.
- **Recommended Resolution**:
  Store and emit original YNAB4 entity IDs during import/export.

---

### [BUG-25] `numCents()` Accepts Trailing Decimal Point
- **Severity**: Low
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `numCents()` (lines 180–190)
- **Description & Root Cause**:
  Input `"123."` produces `parts[1] = ""` which is falsy, bypassing the decimal validation. Returns `123` instead of throwing `TypeError`.
- **Reproduction / Scenario**:
  `numCents("123.")` returns `123` silently instead of throwing.
- **Potential Impact**:
  Minor. Breaks strictness contract but produces correct value.
- **Recommended Resolution**:
  Add explicit check for empty fractional part.

---

### [BUG-26] CSV Date Format Detection Defaults to MDY for Ambiguous European Dates
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `detectDateFormat()`
- **Description & Root Cause**:
  When all dates are ambiguous (both day and month ≤ 12), the function defaults to MDY (US format). European users get wrong dates.
- **Reproduction / Scenario**:
  UK bank export: `05/03/2024` (March 5 DMY) → parsed as May 3 (MDY). All dates shifted.
- **Potential Impact**:
  All imported dates wrong for European users with uniformly ambiguous formats.
- **Recommended Resolution**:
  Allow manual date format selection during CSV import preview. Show a warning when auto-detection is uncertain.

---

## Production Readiness Assessment & Next Steps

### Must Fix Before Real Financial Data

1. **BUG-01 and BUG-02** (CC refund order-dependence and phantom money): These undermine the core budgeting guarantee. A user relying on envelope budgeting to control spending could unknowingly overspend real money because the budget shows phantom availability. Fix the CC buffer clamping logic.

2. **BUG-03** (modal reconciled status regression): This silently corrupts reconciliation state on any minor edit. A simple guard clause (`if (initial?.status === "r") use "r"`) would fix this.

3. **BUG-04** (shared transfer status): This makes accurate reconciliation of receiving accounts impossible. Requires a schema change (add `destStatus` column) with a migration.

4. **BUG-07** (split child deletion cascade): Users will lose transactions unexpectedly. Convert the last remaining child to a regular transaction instead of deleting everything.

5. **BUG-08** (evalAmount space-eating): A common typo in negative amounts produces 100× errors. Fix the unary minus tokenizer to break on whitespace.

### Should Fix for Reliability

6. **BUG-05** (export milliunits): Breaks YNAB4 interoperability entirely.
7. **BUG-09** (optimistic rollback race): Causes confusing UI desyncs during rapid editing.
8. **BUG-10** (localStorage crash): Can cause complete app failure in constrained storage environments.
9. **BUG-11** (recurring cap): Silent data loss after extended app absence.
10. **BUG-12** (CSV mid-field quotes): Corrupts imported data.

### Overall Assessment

The core budget engine is architecturally sound — the cumulative envelope model, split handling, and month iteration are well-implemented. The `dollarsToCents` function using string arithmetic is notably robust. The main risk areas are the CC buffer math (where the original YNAB4 semantics around funded/unfunded refunds were not fully replicated), the reconciliation system (which needs independent status tracking for transfer pairs), and the UI modal that silently loses reconciled status. Addressing the 5 "Must Fix" items above would make the application safe for personal financial tracking with real data.
