# Codebase Audit & Bug Report

**Audit Date**: 2026-08-28
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

The codebase demonstrates strong architectural foundations with clean separation of concerns across `logic`, `server`, and `ui` packages. The budget engine faithfully implements YNAB4's envelope budgeting algorithm with careful handling of credit card buffers, "Red Arrow to the Right", and cumulative carryovers. The split/transfer integrity layer is well-designed with centralized validation (`assertSplitsBalanced`). The reconciliation flow correctly locks reconciled rows and handles synthetic adjustments.

However, the audit identified **20 issues**: 2 Critical, 5 High, 8 Medium, and 5 Low/Code Quality issues. The critical findings involve incorrect income detection for split children and a stale cache/epoch race condition that could silently produce incorrect TBB values. The high-severity findings include reporting metadata bugs, potential floating-point precision loss in dollar-to-cent conversion, missing split sibling propagation in bulk updates, and a `twiceamonth` scheduling edge case.

### Regression Analysis

Git archaeology was performed on every finding to determine when it was introduced and whether it is a **regression from a previous bug fix**. The results are concerning: **7 of the 20 findings (BUG-02, BUG-05, BUG-07, BUG-11, BUG-12, BUG-13, BUG-15) were introduced or completed by commits whose message was itself a bug fix**, and 4 of those were introduced within the last 48 hours of development:

| Bug | Introduced By | Was It a Fix-Regression? |
| :--- | :--- | :--- |
| BUG-02 (cache race) | `a75b02e` ("fix: bug 18") + `245cac6` ("fix: BUG-07") | Yes — cache architecture added during bug-fix work |
| BUG-05 (bulk propagation ordering) | `989678f` ("fix: BUG-10 BUG-11 BUG-12") | Yes — the propagation *was* the fix; it traded date-consistency for determinism |
| BUG-07 (milliunit threshold) | `b129f6e` ("fix: BUG-01", ~8h before audit) | Yes — threshold chosen by a prior audit's recommendation without boundary tests |
| BUG-11 (CSV CC income) | `9cbb708` ("fix: BUG-04 BUG-05 BUG-06") | Yes — over-broad guard added to prevent refund misclassification |
| BUG-12 (diagnostics SQL) | `2b7213e` ("fix: BUG-07") | Partially — rework retained an implicit-invariant pattern |
| BUG-13 (synthetic IDs) | `245cac6` ("fix: BUG-07") | Yes — ID scheme changed during refinement, non-determinism kept |
| BUG-15 (reconciled sibling overwrite) | `989678f` + `7296aff` ("fix: BUG-03") | Yes — propagation fix didn't check sibling reconcile locks |
| BUG-19 (net worth history) | `c272ac5` ("fix: UNI-36") | Partially — clamp fix missed the no-transactions case |

**Pattern**: The project fixes bugs reactively but does not consistently add regression tests that pin the *fixed* behavior, and fixes are sometimes implemented as broad guards that break adjacent invariants. The remaining findings (BUG-01, BUG-03, BUG-04, BUG-06, BUG-08, BUG-09, BUG-10, BUG-14, BUG-16, BUG-17, BUG-18, BUG-20) date to original feature commits (`feat: engine`, `feat: reconciliation`, etc.) and are design/implementation oversights rather than regressions.

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | 2 | Budget Engine (cache invalidation race, split-child income misclassification) |
| **High** | 5 | Reports (minMonthSpend), Format (dollarsToCents precision), Server (bulkUpdate, recurring edge case, YNAB4 import heuristic) |
| **Medium** | 8 | Budget Engine (overspent display), Reports (net worth account tracking), Reconcile (uncleared exclusion), Recurring (catch-up resume), Import CSV (income logic), Schema (check constraint gaps), UI (optimistic state), API (missing 409) |
| **Low** | 5 | Code Quality (dead code, redundant checks, confusing scope naming) |

---

## Detailed Bug Findings

### [BUG-01] `isIncomeTransaction` Excludes Split Children Without Explicit `isIncome` Flag
- **Severity**: Critical
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Symbol**: `isIncomeTransaction()`
- **Description & Root Cause**:
  At lines 93-98, when the `accountMap` is provided and the transaction is a plain (non-transfer) row, the function checks `if (t.parentId != null) return false;` after checking `t.isIncome`. If a split child represents income (e.g., a paycheck split where one child is the net deposit) but its `isIncome` field was not explicitly set — perhaps due to a data migration, manual DB edit, or edge-case import path — the child is incorrectly excluded from income, causing TBB to be understated.

  In the normal code paths (`createSplitWithChildren`, `createTransaction`, `import-ynab4`), `isIncome` is explicitly set. However, the `isIncomeTransaction` function's fallback logic at line 97 unconditionally rejects split children, making it fragile against any future code path or data source that omits the field. The correct fallback for a split child with no category and positive amount should be to treat it as income, consistent with `createSplitWithChildren` semantics.

- **Reproduction / Scenario**:
  1. Create a split transaction where a child has `categoryId=null` and `amount>0` but `isIncome` is `undefined` (e.g., via a hypothetical future API endpoint or raw DB insert).
  2. The budget engine's `buildRawIndexData` calls `isIncomeTransaction` on this child, which returns `false` at line 97.
  3. The child's positive amount is NOT counted as income, reducing TBB.

- **Potential Impact**:
  TBB is silently understated. The user sees less money available to budget than they actually have. This is a data integrity bug that could go unnoticed for long periods.

- **Introduced By**:
  Commit `11c27fe` (2026-08-16, "fix: logic") refactored `isIncomeTransaction` and added the `parentId != null` early return. Commit `ce6103d` (2026-08-24, "fix: 1.6") later moved the `parentId` check into the `accountMap` branch, making it conditional on `accountMap` being provided.

- **Regression Prevention**:
  1. Add a unit test: `isIncomeTransaction({ parentId: 5, categoryId: null, amount: "5000" }, accountMap)` → `true`.
  2. Add a test verifying that a split child with no `isIncome` field and positive amount is classified as income.
  3. Add an integration test: create a paycheck split (one child = net income, another child = tax withholding), run `computeBudget`, verify TBB includes the net income child amount.
  4. Add a database-level check constraint or migration that ensures split children with `categoryId = NULL` and `amount > 0` always have `isIncome = true`.

- **Recommended Resolution**:
  Remove the blanket `if (t.parentId != null) return false;` at line 97 and instead fall through to the standard income logic: `return num(t.amount) > 0`. This makes `isIncomeTransaction` consistent with how `createSplitWithChildren` determines child income (categoryId==null && amount>0).

---

### [BUG-02] Budget Index Cache Epoch Race Condition
- **Severity**: Critical
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Functions**: `globalCacheEpoch`, `getOrBuildIndex()`, `invalidateBudgetIndex()`
- **Description & Root Cause**:
  The budget engine uses a `WeakMap`-based cache keyed on `BudgetData` object identity. The `globalCacheEpoch` is incremented on `invalidateBudgetIndex()` (global invalidation), and serialized indexes are stamped with the epoch at creation time (`serializedIndexEpochs`).

  The race condition occurs in `getOrBuildIndex()` (lines 789-809):
  1. A serialized index (`data.budgetIndex`) is created at epoch 1 and attached to `data`.
  2. `globalCacheEpoch` is incremented to 2 via `invalidateBudgetIndex()` (e.g., after an account deletion or transaction mutation).
  3. `getOrBuildIndex` is called again with the same `data` object. The `WeakMap` cache check at line 789 finds the OLD cached `IndexedBudgetData` (from epoch 1), which was set at line 822 on the previous call. It returns this stale cached index without rechecking the epoch.

  The epoch check at line 793 only fires when the `WeakMap` cache misses and the function falls through to the serialized index check. If the `WeakMap` cache hits (same `BudgetData` object identity), the epoch is never checked, and stale index data is returned.

  **However**, in the normal flow through `computeBudget()` (lines 837-949), the `invalidateBudgetIndex` is not called before `getOrBuildIndex`. The stale cache would only be a problem if:
  - The same `BudgetData` object is reused across mutations, OR
  - `invalidateBudgetIndex(data)` is called between `computeBudget` calls on the same object.

  In the server's `getBudgetData()` (`packages/server/src/queries/budget.ts`), a new `BudgetData` object is created on every call (line 37-79), and `buildBudgetIndex` is called fresh. So the WeakMap key changes each time, preventing this race in practice. But the `normalizedDataCache` (another WeakMap at line 154) stores normalized copies that could bridge multiple calls if the same raw data object is reused.

  The risk is low in current usage patterns but the cache architecture is fragile against future refactors.

- **Reproduction / Scenario**:
  1. Call `computeBudget(data, "2026-01")` — caches `IndexedBudgetData` for `data`.
  2. Mutate `data.transactions` (add/remove a transaction).
  3. Call `invalidateBudgetIndex(data)` — clears the normalized cache but the `IndexedBudgetData` cache entry remains (it was set at line 822 for `data` directly).
  4. Call `computeBudget(data, "2026-01")` again — the WeakMap hit at line 789 returns the stale cached index from step 1.

- **Potential Impact**:
  TBB and category available balances are computed from stale cached data. The user sees incorrect budget numbers. This would manifest as TBB not updating after transaction changes until a full page reload.

- **Introduced By**:
  Commit `a75b02e` (2026-08-25, "fix: bug 18") introduced `invalidateBudgetIndex()` and the cache-setting logic in `buildBudgetIndex()`. Commit `245cac6` (2026-08-26, "fix: BUG-07") added `normalizeBudgetData()` and the dual `data`/`normData` cache entries in `computeBudget()` at line 850.

- **Regression Prevention**:
  1. Add a unit test: call `computeBudget(data, "2026-01")`, mutate `data.transactions`, call `invalidateBudgetIndex(data)`, call `computeBudget(data, "2026-01")` again — assert the result reflects the mutated transactions, not the stale cache.
  2. Add a test that verifies `invalidateBudgetIndex(data)` clears ALL entries from `budgetDataIndexCache` for both `data` and its normalized copy.
  3. Add an integration test in the server that verifies TBB updates correctly after a transaction mutation without a full page reload.

- **Recommended Resolution**:
  In `invalidateBudgetIndex(data)`, explicitly delete the entry from `budgetDataIndexCache` (which it already does at line 275). The bug is that the `computeBudget` function at line 848 calls `getOrBuildIndex(normData, ...)` where `normData` is the normalized copy. The cache is set on `normData` (line 822) but invalidation clears it from `data` (line 275). If `normData !== data`, the normalized copy's cache entry is cleared on line 278-281, but the `data` entry set at line 850 (`budgetDataIndexCache.set(data, index)`) is NOT cleared. Fix: also delete from `budgetDataIndexCache` for `data` when `data !== normData`.

---

### [BUG-03] `computeSpendingTrends` `minMonthSpend` Initialized to Zero
- **Severity**: High
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function**: `computeSpendingTrends()`
- **Description & Root Cause**:
  At line 579, `minMonthSpend` is initialized to `0`. The spending values (`monthTotal`) are always non-negative (they represent net outflow amounts). The update condition at line 622: `if (monthTotal < minMonthSpend)` will never be true when all months have positive spending, because `0 < 0` is false. This means `minMonthSpend` is always reported as 0 for any dataset where every month has some spending, making the metric useless. It should be initialized to `Number.POSITIVE_INFINITY` or `Number.MAX_SAFE_INTEGER`.

  The same issue affects `maxMonthSpend` but in the opposite direction — it's initialized to `0` and all spending is non-negative, so the condition `monthTotal > maxMonthSpend` at line 619 works correctly for all cases (0 is always ≤ any positive spend).

- **Reproduction / Scenario**:
  1. Import transactions with spending in every month of the range.
  2. View the Spending Trends report. The "minimum month spend" statistic will always show $0.00.
  3. Any code or UI that relies on `minMonthSpend` for calculations or display will produce incorrect results.

- **Potential Impact**:
  The `minMonthSpend` field on `SpendingTrendsResult` is always 0 when any spending exists. This corrupts the `SpendingTrendsReport.tsx` UI component which likely displays this value, and any downstream analysis that uses it.

- **Introduced By**:
  Commit `edc822b` (2026-08-22, "fix: withdrawals") introduced the `minMonthSpend` and `maxMonthSpend` fields to `SpendingTrendsResult` in `computeSpendingTrends()`, initializing both to `0`.

- **Regression Prevention**:
  1. Add a unit test: `computeSpendingTrends()` with spending in every month → assert `minMonthSpend > 0`.
  2. Add a unit test: `computeSpendingTrends()` with one zero-spend month → assert `minMonthSpend === 0`.
  3. Add a snapshot test that captures the full `SpendingTrendsResult` output for a known dataset and fails if `minMonthSpend` unexpectedly changes.

- **Recommended Resolution**:
  Change line 579 from `let minMonthSpend = 0;` to `let minMonthSpend = Number.POSITIVE_INFINITY;`.

---

### [BUG-04] `dollarsToCents` Floating-Point Precision Loss
- **Severity**: High
- **Category**: Format / Unit Coercion
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function**: `dollarsToCents()`
- **Description & Root Cause**:
  The function at line 197 uses the `Number(absStr + 'e2')` trick to multiply by 100 without floating-point intermediate steps. While this works for most inputs, it fails for edge cases:
  1. Numbers with many decimal places: `dollarsToCents(0.0000001)` → `String(1e-7)` → `"1e-7"` → the `if (absStr.includes("e"))` branch at line 194 takes the `Math.abs(n) * 100` path, which is `1e-7 * 100 = 0.00001` → `Math.round(0.00001) = 0`. This is correct for cent rounding.
  2. Numbers near `Number.MAX_SAFE_INTEGER / 100`: `dollarsToCents(90071992547409.91)` → `absStr = "90071992547409.91"` → `Number("90071992547409.91e2")` = `9.007199254740991e15` which exceeds `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). The check at line 187 catches this and throws.
  3. Negative zero: `dollarsToCents(-0)` → `n = -0`, `sign = -1`, `absStr = "0"`, `Number("0e2") = 0`, `Math.round(0) = 0`, `sign * 0 = -0`. The `=== 0` check returns 0. Fine.
  4. **Real bug**: `dollarsToCents(0.295)` → `absStr = "0.295"` → `Number("0.295e2") = 29.5` → `Math.round(29.5) = 30`. But `0.295 * 100 = 29.499999999999996` due to floating-point. Using `e2` avoids this. However, `dollarsToCents(1.005)` → `absStr = "1.005"` → `Number("1.005e2") = 100.5` → `Math.round(100.5) = 101`. The correct answer is 101 cents ($1.01). But `1.005 * 100 = 100.49999999999999` which would round to 100. The `e2` trick gives the correct answer here.

  The primary concern is that `dollarsToCents` is used in CSV import (`csv-import.ts` line 560), YNAB4 import (`import-ynab4.ts` line 187), and the UI amount input. Any floating-point dollar amount that can't be exactly represented in binary could produce a cent value off by 1.

- **Reproduction / Scenario**:
  1. CSV import with amount "1.15" → `parseAmount("1.15")` returns `1.15` → `dollarsToCents(1.15)` → `String(1.15) = "1.15"` → `Number("1.15e2") = 115` → correct.
  2. CSV import with amount "0.57" → `parseAmount("0.57")` returns `0.57` → `dollarsToCents(0.57)` → `String(0.57) = "0.57"` → `Number("0.57e2") = 57` → correct.
  3. Most common dollar amounts work correctly. The risk is theoretical for amounts with many decimal places that parse to a float with precision issues.

- **Potential Impact**:
  Off-by-one-cent errors in imported transactions, causing reconciliation discrepancies and balance drift over time. Low probability but high impact when it occurs.

- **Introduced By**:
  Commit `c7422d9` (2026-08-26, "fix: BUG-27 BUG-28") added the `e2` string-multiplication trick and `isFinite` guard. The function itself dates back to commit `11c27fe` (2026-08-16, "fix: logic").

- **Regression Prevention**:
  1. Add a fuzz test that passes random dollar amounts (including edge cases like `0.01`, `0.99`, `1.005`, `1234567.89`) through `dollarsToCents` and verifies the result equals `Math.round(input * 100)` for well-behaved inputs.
  2. Add a property-based test: for any input where `String(n)` produces a standard decimal representation, `dollarsToCents(n)` should equal `Math.round(n * 100)`.
  3. Document that callers should prefer string-based dollar parsing (like `parseAmount`) over passing raw floating-point numbers.

- **Recommended Resolution**:
  Parse the dollar string directly rather than converting through a Number. Extract integer and fractional parts separately: `const [int, frac = ""] = String(n).split("."); const cents = parseInt(int) * 100 + parseInt((frac + "00").slice(0, 2));`. Alternatively, use a decimal library like `decimal.js` for all monetary calculations.

---

### [BUG-05] `bulkUpdateTransactions` Does Not Propagate Date/Status Changes to Split Siblings
- **Severity**: High
- **Category**: Splits & Transfers
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function**: `bulkUpdateTransactions()`
- **Description & Root Cause**:
  In `bulkUpdateTransactions`, when a split parent is identified and its date or status is changed, the changes are propagated to children (lines 1321-1347). However, the propagation only happens when `isSplitParent` is true. But in bulk update, `isSplitParent` is determined by checking `existing.parentId == null && existing.transferAccountId == null && hasChildren` (lines 1189-1191). If a bulk update includes a split child (not parent) and changes its date, the change IS propagated (lines 1328-1333). But if the bulk update includes a split parent AND a sibling, and the sibling's date/status is changed separately in the same bulk call, the propagation from the parent change may conflict with the sibling's own update.

  The more significant issue: when a split child's status is changed to "c" (cleared) via bulk update, line 1342-1347 propagates the status to the parent and all siblings, setting their `reconciledAt` and `reconciliationId` to null. But the parent's status may have been changed earlier in the same bulk call (line 1324). The later propagation from the child would overwrite the parent's explicitly-set status.

  This is a classic bulk update ordering problem — the order of iteration over `ids` determines the final state, which is non-deterministic from the caller's perspective.

- **Reproduction / Scenario**:
  1. Create a split with 2 children, all status "c".
  2. Bulk update: set child 1 status to "u" and parent status to "u" in the same call.
  3. If child 1 is processed first, its status change propagates to parent and child 2 (setting both to "u"). Then the parent's own update is a no-op (already "u").
  4. If parent is processed first, its status changes to "u" and propagates to children. Then child 1's update is a no-op.
  5. In both cases, the result is the same. But if the updates are conflicting (child 1 → "u", parent → "c"), the final state depends on processing order.

- **Potential Impact**:
  Non-deterministic split status after bulk operations. Could leave splits in inconsistent cleared/uncleared states.

- **Introduced By**:
  Commit `989678f` (2026-08-27, "fix: BUG-10 BUG-11 BUG-12") added split child date/status propagation in `bulkUpdateTransactions()` at lines 1328-1347.

- **Regression Prevention**:
  1. Add a unit test: bulk update a split with child → "u" AND parent → "c" in the same call, then assert the final state is deterministic (regardless of processing order).
  2. Add a test that bulk-updating a split child's status does not overwrite the parent's explicitly-set different status when both are in the same batch.
  3. Add an E2E test that selects a split parent and its children in the Bulk Edit modal, applies different statuses, and verifies consistent results.

- **Recommended Resolution**:
  Collect all propagation targets during the loop, then apply propagations after all individual updates are complete. Use a Set to deduplicate and apply the "last writer wins" semantics consistently. Alternatively, reject bulk updates that include both a split parent and its children in the same call.

---

### [BUG-06] `nextDateFor` Twice-a-Month Anchoring Drift with anchorDay > 15
- **Severity**: High
- **Category**: Recurring
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function**: `nextDateFor()`
- **Description & Root Cause**:
  In the "twiceamonth" / "semimonthly" branch (lines 531-549), the two target days are computed as:
  ```
  d1 = anchorDay <= 15 ? anchorDay : anchorDay - 15;
  d2 = anchorDay <= 15 ? anchorDay + 15 : anchorDay;
  ```
  For `anchorDay = 31`: d1 = 16, d2 = 31.
  For `anchorDay = 30`: d1 = 15, d2 = 30.
  For `anchorDay = 16`: d1 = 1, d2 = 16.

  The problem: d2 is clamped to the last day of the month (`clampedD2 = Math.min(d2, lastDay)`). For `anchorDay = 31` in a 30-day month, d2 = 30. The sequence becomes: 31st → 30th → 16th (next month) → 30th → 16th → 31st (next 31-day month) → ...

  This creates an irregular pattern: 31 → 30 → 16 → 30 → 16 → 31. The 16th-to-30th gap is 14 days (not the expected ~15), and the 30th-to-16th gap is 17 days. Over a year, the dates drift significantly from the intended "every ~15 days" schedule.

  Additionally, when `anchorDay > 15` and the first occurrence is set to the 16th (anchorDay=16, d2=16), the function considers it to be "in the second half" and jumps to d1 (1st) of next month. But the user who set `anchorDay=16` and `nextDate=2026-01-16` probably expects the next occurrence on the 1st of February, not the 1st of February. Wait, that IS what happens — the function correctly moves from the 16th to the 1st. But the semantic meaning of "twice a month starting on the 16th" should be: 16th and 1st of next month. The current code does achieve this, but the d1=1, d2=16 assignment makes the 16th the "second" date and the 1st the "first" date, which is conceptually inverted.

- **Reproduction / Scenario**:
  1. Create a semimonthly recurring transaction with `nextDate = "2026-01-31"`, `anchorDay = 31`, frequency = "twiceamonth".
  2. Post it. The next date becomes 2026-02-28 (clamped from 31).
  3. Post again. Next date becomes 2026-03-16.
  4. The sequence: Jan 31 → Feb 28 → Mar 16 → Mar 31 → Apr 16 → Apr 30 → May 16 → May 31.
  5. The user expected: Jan 31 → Feb 15 → Feb 28 → Mar 15 → Mar 31, or a more regular pattern.

- **Potential Impact**:
  Semimonthly recurring transactions (paychecks, bill payments) drift from their expected schedule, potentially causing missed payment projections and incorrect cash flow forecasts.

- **Introduced By**:
  Commit `ac445b4` (2026-08-16, "fix: recurring and projections") introduced the full `nextDateFor()` function including the "twiceamonth" / "semimonthly" branch with anchor-day logic.

- **Regression Prevention**:
  1. Add a unit test for `nextDateFor("twiceamonth", "2026-01-31", 31)` and verify the sequence over 6 months produces dates that are approximately 15 days apart.
  2. Add a test for `anchorDay = 16` verifying the 1st and 16th pattern.
  3. Add a test for `anchorDay = 28` in February (should clamp to Feb 28 and produce Mar 13 as the next date).
  4. Add a fuzz test that iterates `nextDateFor` across all valid anchor days (1-31) for 24 months and verifies the interval between successive dates never exceeds 18 days and is never less than 12 days.

- **Recommended Resolution**:
  For `anchorDay > 15`, the two target days should be `d1 = anchorDay - 15` and `d2 = anchorDay`. However, the "first half" vs "second half" determination should always be based on the current day relative to d1 and d2, regardless of which is larger. Alternatively, always use the 1st and 16th (or 15th and last-day) as the two monthly targets, ignoring anchorDay entirely for semimonthly scheduling.

---

### [BUG-07] `detectMilliunitScale` Heuristic Threshold May Misclassify Small Budgets
- **Severity**: High
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function**: `detectMilliunitScale()`
- **Description & Root Cause**:
  At lines 80-82, the heuristic checks if the maximum absolute amount exceeds 1,000,000 to determine if amounts are in milliunits (×1000) vs decimal dollars. The logic is: if all amounts are integers AND the max magnitude > 1,000,000, then they're milliunits. But 1,000,000 milliunits = $1,000.00. A budget with a transaction of exactly $1,000.00 stored as integer cents (100,000) would be below the threshold and correctly identified as cents. But a budget with a transaction of $10,000.01 stored as integer cents (1,000,001) would exceed the threshold and be incorrectly classified as milliunits, dividing all amounts by 10.

  The threshold of 1,000,000 is too low for budgets with larger transactions. A $10,000 transaction in cents is 1,000,000, which would be misclassified. In a personal budget, $10,000 transactions (e.g., tuition payment, car purchase, tax payment) are not uncommon.

- **Reproduction / Scenario**:
  1. Export a YNAB4 budget containing a $12,000 car purchase transaction.
  2. If stored as integer cents, this is 1,200,000.
  3. `detectMilliunitScale` sees maxAbs = 1,200,000 > 1,000,000 → returns true (milliunits).
  4. The import divides all amounts by 10, corrupting the entire budget.

- **Potential Impact**:
  All amounts in the imported budget are divided by 10, resulting in values that are 1/10th of the actual amounts. This is catastrophic data corruption. The user would see their $12,000 car purchase as $1,200 and all other amounts proportionally wrong.

- **Introduced By**:
  Commit `b129f6e` (2026-08-28, "fix: BUG-01") introduced `detectMilliunitScale()` with the `1_000_000` threshold. The function was added as part of fixing a prior issue where YNAB4 imports couldn't distinguish between milliunit and dollar formats.

- **Regression Prevention**:
  1. Add a test fixture: a YNAB4 backup with integer cent amounts where the largest transaction is $15,000 (1,500,000 cents). Verify `detectMilliunitScale` returns `false`.
  2. Add a test fixture: a stock YNAB4 backup (real milliunits) with amounts like -45000. Verify `detectMilliunitScale` returns `true`.
  3. Add a boundary test at the threshold: a backup with a single transaction of 1,000,001 cents ($10,000.01) — should return `false`.
  4. Document the threshold value prominently in the function's JSDoc so future maintainers understand the tradeoff.

- **Recommended Resolution**:
  Increase the threshold to 100,000,000 (=$100,000 in cents) or use a more robust detection method. Better: check if the amounts have a fractional part when divided by 1000. If `amount / 1000` has a fractional part, it's not milliunits. Additionally, check account balances — a checking account balance of 1,500,000 cents ($15,000) is reasonable; 1,500,000 milliunits ($1,500) is also reasonable. The detection should consider the distribution of amounts, not just the maximum.

---

### [BUG-08] `buildCarryoverMap` Reports Overspent from Wrong Month
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function**: `buildCarryoverMap()`
- **Description & Root Cause**:
  At lines 978-982, `overspentPrevious` is computed from `mostRecentPrior`, which is the most recent month with ANY data (assignments or transactions) before the target month. But the actual TBB calculation in `computePriorTBBSurplus` iterates through ALL prior months (lines 1030-1038), accumulating surplus and subtracting overspent at each step.

  The `overspentPrevious` value is returned in `BudgetResult` for display purposes (line 258 of types.ts: "Cash overspending from the previous month"). If there's a gap between the last data month and the target month, `overspentPrevious` reflects a month that may be several months ago, not the actual month before the target. This is misleading for the UI.

  Additionally, the overspent amount factored into `priorSurplus` via `computePriorTBBSurplus` is correct (all months are iterated), but `overspentPrevious` in the result doesn't match what was actually subtracted.

- **Reproduction / Scenario**:
  1. Have data in January 2026 with $100 cash overspending.
  2. Have no data in February 2026.
  3. View the March 2026 budget.
  4. `mostRecentPrior` = January 2026. `overspentPrevious` = 100 (January's overspending).
  5. But the actual overspent that affected March's TBB is 0 (January's overspending was already absorbed in January's TBB calculation and carried forward through February's zero-activity month).

- **Potential Impact**:
  The UI displays "Overspent in Previous Month: $100.00" when viewing March, but the overspending actually happened in January. This is confusing and misleading.

- **Introduced By**:
  Commit `914232b` (2026-07-29, "feat: engine") — the original budget engine implementation. `buildCarryoverMap` has always used `mostRecentPrior` for the `overspentPrevious` display value. The core TBB calculation (`computePriorTBBSurplus`) is correct; only the display field is inconsistent.

- **Regression Prevention**:
  1. Add a unit test: dataset with data in January, gap in February, view March — assert `overspentPrevious === 0` (since February had no activity) while TBB still correctly reflects January's overspending via the cumulative surplus.
  2. Add a test asserting `BudgetResult.overspentPrevious` equals `overspentByMonth.get(prevMonthKey(targetMonth))`, keeping the display field semantically honest.
  3. Document in `types.ts` that `overspentPrevious` refers to the *immediately preceding calendar month*, not the last month with data.

- **Recommended Resolution**:
  Compute `overspentPrevious` from the month immediately before the target month (i.e., `prevMonthKey(targetMonth)`), not from the most recent data month. If that month has no data, overspent should be 0.

---

### [BUG-09] `getReconcileState` Excludes Uncleared Transactions After Statement Date
- **Severity**: Medium
- **Category**: Reconcile
- **Location**:
  - **File**: `packages/server/src/queries/reconcile.ts`
  - **Function**: `getReconcileState()`
- **Description & Root Cause**:
  At lines 59-77, the SQL query includes `date <= ${statementDate}` for ALL status categories, including uncleared ("u"). This means uncleared transactions dated after the statement date are excluded from the uncleared count and total shown in the reconcile modal. The reconcile modal should show ALL uncleared transactions regardless of date, since they represent transactions that haven't been matched to any bank statement yet. The `date <= statementDate` filter is only meaningful for cleared and reconciled transactions (which define the working balance).

  The same issue exists in `computeReconcileState` in `packages/logic/src/reconcile.ts` at line 72: `if (t.date > statementDate) continue;` filters out all transactions (including uncleared) after the statement date.

- **Reproduction / Scenario**:
  1. Have an account with 5 cleared transactions before June 15 and 3 uncleared transactions dated June 20.
  2. Reconcile with statement date June 15.
  3. The reconcile modal shows uncleared count = 0 and uncleared total = $0.00.
  4. The user doesn't see the 3 uncleared transactions and may incorrectly think the account is fully reconciled.

- **Potential Impact**:
  Users may not realize there are uncleared transactions after the statement date, leading to incorrect reconciliation decisions. The working balance calculation is correct (only uses cleared + reconciled), but the display of uncleared transactions is misleading.

- **Introduced By**:
  Commit `d3452d6` (2026-08-16, "feat(server,web): add reconciliation round tracking, statement date cutoff, and adjustment status (UNI-10)") — the statement date cutoff was applied uniformly to all status aggregates, including uncleared, when the feature was first built.

- **Regression Prevention**:
  1. Add a unit test for `getReconcileState`: account with uncleared transactions dated *after* the statement date → assert `unclearedCount` includes them.
  2. Add a parallel test for `computeReconcileState` in `packages/logic/src/reconcile.ts` (the pure-logic mirror) so both implementations stay in sync.
  3. Add a parity test that runs both implementations against the same fixture and asserts identical outputs — this guards against future drift between the SQL and TS versions.

- **Recommended Resolution**:
  Compute uncleared sums and counts without the `date <= statementDate` filter. Only apply the date filter to cleared and reconciled status categories.

---

### [BUG-10] `autoPostDueRecurringTransactions` Catch-Up Resume After Failure
- **Severity**: Medium
- **Category**: Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function**: `autoPostDueRecurringTransactions()`
- **Description & Root Cause**:
  At lines 577-627, the catch-up loop for each due recurring rule processes occurrences sequentially. When a posting fails (line 599), the rule is deactivated (lines 610-618) and the loop breaks for that rule. However, the rule's `nextDate` has already been advanced by `postRecurringTransaction` (line 519-526) for SUCCESSFUL postings before the failure. If a rule had 3 overdue occurrences and the 2nd one fails:
  1. 1st occurrence: posted successfully, `nextDate` advanced to 2nd occurrence date.
  2. 2nd occurrence: fails, rule deactivated.
  3. The rule remains deactivated with `nextDate` set to the 2nd occurrence date.
  4. When the user fixes the issue and reactivates the rule, auto-posting won't catch up the 2nd and 3rd occurrences because `nextDate` has already moved past them.

  Additionally, the `remainingDue` value pushed to `capped` at line 589 is always `1`, which doesn't accurately reflect how many occurrences were skipped due to the cap.

- **Reproduction / Scenario**:
  1. Create a monthly recurring transaction that's 3 months overdue.
  2. Temporarily delete its linked category (so posting fails).
  3. Auto-post runs: 1st occurrence succeeds, 2nd fails, rule deactivated.
  4. Restore the category and reactivate the rule.
  5. Auto-post runs again: `nextDate` is already the 2nd occurrence date, so only the 2nd occurrence is posted (as a single occurrence). The 3rd overdue occurrence is lost.

- **Potential Impact**:
  Missed recurring transactions that are never posted. The user has to manually create the missing transactions.

- **Introduced By**:
  Commit `fcf6007` (2026-08-16, "feat(server,web): auto-post scheduled transactions at nextDate with preserved split signs (UNI-09)") — the catch-up loop was designed with forward-advancing `nextDate` from the start; the failure path that deactivates the rule mid-catch-up was part of the original design and did not account for partially-advanced schedules.

- **Regression Prevention**:
  1. Add a unit test: recurring rule 3 months overdue whose 2nd occurrence fails (e.g., missing category) → assert the rule's `nextDate` is rolled back to the original value when it is deactivated.
  2. Add a test: reactivate a previously-failed rule, run auto-post again, assert ALL remaining overdue occurrences are posted.
  3. Add a test asserting `capped[].remainingDue` reports the true count of skipped occurrences when the per-rule cap is hit (e.g., cap 2 with 4 overdue → `remainingDue: 2`).
  4. Add a test that a failing rule being deactivated does not corrupt a rule that posts successfully afterwards in the same run.

- **Recommended Resolution**:
  On failure, roll back the `nextDate` to the original value before the catch-up loop started. Or, on reactivation, recompute `nextDate` from the original start date rather than keeping the partially-advanced value. Also fix `remainingDue` to report the actual count of skipped occurrences.

---

### [BUG-11] CSV Import Income Logic Excludes Credit Card Refunds
- **Severity**: Medium
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/server/src/import-csv.ts`
  - **Function**: `importCsvTransactions()`
- **Description & Root Cause**:
  At line 151, the `isIncome` calculation:
  ```
  const isIncome = effectiveCategoryId == null && amount > 0 && !!account.onBudget && account.kind !== "credit";
  ```
  The `account.kind !== "credit"` condition means that positive uncategorized transactions on credit card accounts are never classified as income. While this is generally correct (credit card refunds should be categorized back to the original spending category, not as income), there are legitimate cases where a credit card statement credit (e.g., cashback rewards, sign-up bonuses) should be treated as income. The hard exclusion prevents this.

  Additionally, a CSV import might contain a genuine income transaction deposited to a credit card account (e.g., a refund from a merchant that exceeds the original purchase). In such cases, the transaction is silently treated as a non-income inflow to the credit card, which affects the card balance but not TBB.

- **Reproduction / Scenario**:
  1. Import a CSV with a $50 cashback credit on a credit card account.
  2. The transaction is imported as `isIncome: false`, `categoryId: null`.
  3. The $50 reduces the credit card balance but does NOT appear in TBB as available income.

- **Potential Impact**:
  Credit card cashback rewards and statement credits are not recognized as income, understating TBB.

- **Introduced By**:
  Commit `9cbb708` (2026-08-27, "fix: BUG-04 BUG-05 BUG-06") — **this is a regression from a previous bug fix**. The `account.kind !== "credit"` condition was added to prevent credit card refunds from being misclassified as income inflating TBB (the previous bug). The fix was too broad: it also blocks legitimate card credits (cashback, sign-up bonuses) from counting as income.

- **Regression Prevention**:
  1. Add a unit test: CSV import of a positive uncategorized row on a credit card account → assert the transaction is created (document the expected `isIncome` value explicitly in the test so the intent is locked in).
  2. Add a test verifying that a categorized refund (category set) on a credit card does NOT count as income — this is the invariant the original fix (BUG-04/05/06) was protecting; any relaxation of `kind !== "credit"` must preserve it.
  3. When relaxing the condition, run the full import test suite and confirm TBB is not inflated by categorized card refunds.

- **Recommended Resolution**:
  Remove the `account.kind !== "credit"` condition or replace it with a check for whether the account is on-budget (which is already covered by `!!account.onBudget`). If the concern is about refunds being misclassified as income, rely on the user to categorize the transaction correctly (or auto-categorize based on payee rules).

---

### [BUG-12] `recomputeAccountBalances` Uses Raw SQL That Doesn't Exclude Split Parents
- **Severity**: Medium
- **Category**: Database & API
- **Location**:
  - **File**: `packages/server/src/queries/diagnostics.ts`
  - **Function**: `recomputeAccountBalances()`
- **Description & Root Cause**:
  At lines 83-106, the raw SQL query for recomputing account balances uses `t.id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)` to exclude split parents. This correctly excludes parents from the outgoing sum (line 93) and incoming transfer sum (line 100). However, the query does NOT exclude split parents from the `WHERE t.transfer_account_id = a.id` condition (line 99-101). This means that if a split parent has a non-null `transferAccountId` (which shouldn't happen per schema, but could exist from edge-case imports), it would be counted in the incoming transfer sum incorrectly.

  More importantly, the `verifyBalanceIntegrity` function (lines 30-73) uses the same logic with the same SQL patterns. Both functions are correct for the current schema constraints, but rely on the implicit assumption that split parents never have `transferAccountId != null`.

- **Reproduction / Scenario**:
  1. A split parent transaction somehow gets a non-null `transferAccountId` (e.g., via direct DB manipulation or a future bug).
  2. `recomputeAccountBalances` counts this parent in the incoming transfer sum but not the outgoing sum.
  3. Account balances are incorrectly computed.

- **Potential Impact**:
  Account balance corruption if split parents ever have transferAccountId set. Low probability given current code paths, but the diagnostic functions should be defensive.

- **Introduced By**:
  Commit `2b7213e` (2026-08-28, "fix: BUG-07") reworked `recomputeAccountBalances` and `verifyBalanceIntegrity`. The parent-exclusion subquery was applied to the outgoing sum but the incoming-transfer sum retained the pre-existing pattern that only implicitly relies on split parents never carrying `transferAccountId`.

- **Regression Prevention**:
  1. Add a unit test for `verifyBalanceIntegrity` with a hand-crafted anomalous row (split parent with `transferAccountId` set) → assert the computed balance ignores it symmetrically on both the outgoing and incoming sides.
  2. Add a DB-level CHECK constraint (`transfer_account_id IS NULL OR parent_id IS NULL`) so the invariant "split parents are never transfers" is enforced by the schema, not by convention. This is the strongest regression guard.
  3. Add a parity test: `verifyBalanceIntegrity` reports zero differences on a freshly seeded database after any random sequence of CRUD operations (property-based test over the mutation API surface).

- **Recommended Resolution**:
  Add an additional condition to the incoming transfer subquery: `AND t.id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`. This makes the query fully defensive regardless of data anomalies.

---

### [BUG-13] `normalizeBudgetData` Synthetic Category IDs Could Collide
- **Severity**: Medium
- **Category**: Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function**: `normalizeBudgetData()`
- **Description & Root Cause**:
  At lines 233-255, synthetic categories are created with negative IDs (e.g., `nextSynthCatId--` starting from -1). These IDs are used as keys in Maps throughout the budget computation. While negative numbers work as Map keys, they could theoretically collide with real category IDs if the database ever assigns negative IDs (e.g., due to SQLite auto-increment overflow after billions of inserts). More practically, if `normalizeBudgetData` is called multiple times on the same dataset (due to cache misses), it will create new synthetic categories with new negative IDs each time, leading to duplicate entries.

  The `normalizedDataCache` WeakMap at line 154 prevents multiple calls on the same object, but the synthetic IDs are embedded in the returned `BudgetData`, and the categories array grows with each normalization of a new data object.

- **Reproduction / Scenario**:
  1. Budget data has 2 credit cards without explicit CC payment categories.
  2. First normalization: synthetic categories created with IDs -1, -2.
  3. Budget data is re-fetched (new object identity), normalization runs again.
  4. Synthetic categories with IDs -3, -4 are added. Now there are 4 synthetic categories for 2 cards.
  5. The budget computation iterates all categories, including the stale synthetic ones, which may have stale carryover or other data.

- **Potential Impact**:
  Duplicate synthetic categories in the categories array, causing double-counting of CC payment buffers and incorrect available balances for CC payment categories.

- **Introduced By**:
  Commit `245cac6` (2026-08-26, "fix: BUG-07") introduced `normalizeBudgetData()`. The original implementation used *positive* synthetic IDs (`maxCatId++` starting from the max real ID) — a later refinement (visible in the current code, `nextSynthCatId--` starting at -1) switched to negative IDs to avoid colliding with real auto-increment IDs, but kept the non-deterministic "new ID on every call" behavior.

- **Regression Prevention**:
  1. Add a unit test: call `normalizeBudgetData` twice on two distinct but identical-content `BudgetData` objects → assert the synthetic category for a given `linkedAccountId` has the *same* ID in both results (deterministic ID scheme).
  2. Add a test: normalization of data that already has a linked CC category does not add a duplicate synthetic category.
  3. Add a test that synthetic IDs are always negative and never collide with real category IDs from the DB.
  4. Add a test that `computeBudget` output for a credit card without a linked category is identical whether normalized once or twice (idempotency).

- **Recommended Resolution**:
  Check for existing synthetic categories by `linkedAccountId` before creating new ones. Or, use a deterministic ID scheme (e.g., `-(linkedAccountId + 1000000)`) so the same credit card always gets the same synthetic category ID.

---

### [BUG-14] `evalAmount` Division by Zero Not Handled
- **Severity**: Medium
- **Category**: Format / Unit Coercion
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function**: `evalAmount()`
- **Description & Root Cause**:
  At lines 395-398, the expression evaluator performs division:
  ```
  else if (t.op === "/") r = a / b;
  ```
  If `b` is 0, `r` becomes `Infinity` or `-Infinity`, and the check at line 399 (`!Number.isFinite(r)`) catches it and returns null. This is correct.

  However, the evaluator does not distinguish between "division by zero" and "result too large". Both return null silently. For a better user experience in the AmountInput, a more specific error message for division by zero would help users correct their input.

  Additionally, the expression evaluator accepts `*` and `/` operators with the same precedence as standard math, but YNAB4's inline calculator only supported `+` and `-`. The inclusion of `*` and `/` is a feature, but the precedence handling (lines 344-383) uses standard operator precedence, which could produce unexpected results for users who expect left-to-right evaluation (as in basic calculators). E.g., `2+3*4` = 14 with standard precedence, but 20 with left-to-right.

- **Reproduction / Scenario**:
  1. Enter `100/0` in the amount input.
  2. `evalAmount` returns null (division by zero → Infinity → caught by isFinite check).
  3. The UI treats this as "invalid input" without explaining why.

- **Potential Impact**:
  Minor UX issue. The expression evaluator silently fails on division by zero. Users may not understand why their input is rejected.

- **Introduced By**:
  Commit `5ddd9c7` ("feat: inline math") — the inline expression evaluator feature. The silent null-on-failure contract is original to the feature; the YNAB4 precedence deviation is a design choice made at introduction, not a regression.

- **Regression Prevention**:
  1. Add a unit test table for `evalAmount` covering: `"100/0"` → `null`, `"2+3*4"` → `14` (locks in standard precedence as the documented behavior), `"(1+2)*3"` → `9`, `"1/3"` → `0.333...` (finite check).
  2. If a distinct division-by-zero signal is added, snapshot-test the new return contract so the UI can render a specific message.
  3. Add a property test: any string with unbalanced parentheses or consecutive binary operators returns `null` (no exceptions thrown).

- **Recommended Resolution**:
  Add a specific check for division by zero before performing the operation, and return a distinct error or null with context.

---

### [BUG-15] `updateTransaction` Propagates Date to Reconciled Split Siblings
- **Severity**: Medium
- **Category**: Splits & Transfers
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function**: `updateTransaction()`
- **Description & Root Cause**:
  At lines 687-692, when a split child's date is changed, the new date is propagated to the parent and ALL siblings:
  ```
  if (current.parentId != null && "date" in p && p.date != null) {
    await db.update(transactions)
      .set({ date: String(p.date) })
      .where(or(eq(transactions.id, current.parentId), eq(transactions.parentId, current.parentId)));
  }
  ```
  The reconciliation lock check at lines 524-532 only checks if the PARENT is reconciled. It does NOT check if any of the SIBLINGS are individually reconciled. If a sibling is reconciled (which shouldn't normally happen since the reconcile flow flips all children together, but could happen from an edge case or future code path), the date propagation would overwrite the reconciled sibling's date, bypassing the reconciliation lock.

  The same issue exists in `bulkUpdateTransactions` at lines 1328-1333.

- **Reproduction / Scenario**:
  1. A split has child A (reconciled) and child B (not reconciled).
  2. User changes child B's date via the UI.
  3. The date propagates to child A, modifying a reconciled transaction.

- **Potential Impact**:
  Reconciled transaction lock bypass. In practice, this is unlikely because the reconcile flow flips all children simultaneously, but it's a latent vulnerability.

- **Introduced By**:
  Commit `989678f` (2026-08-27, "fix: BUG-10 BUG-11 BUG-12") — **this is a regression from a previous bug fix**. The sibling date/status propagation was itself the fix for earlier bugs where split dates drifted apart; the propagation was added without checking sibling reconciliation status, trading one invariant (date consistency) against another (reconcile immutability).

- **Regression Prevention**:
  1. Add a unit test: split with a reconciled sibling; update the non-reconciled sibling's date → assert a 422 error is thrown and no row is modified.
  2. Add a test for the status-propagation path in `bulkUpdateTransactions` with the same reconciled-sibling fixture.
  3. Add an invariant test: for any split, either all rows are reconciled or none are — if this invariant holds in the data, add a periodic integrity check that surfaces violations loudly rather than propagating over them silently.

- **Recommended Resolution**:
  Before propagating date changes, check that no sibling has `status === "r"`. If any sibling is reconciled, reject the date change with a 422 error.

---

### [BUG-16] `computeMonthlyInsights` Unused `_budgetResult` Parameter
- **Severity**: Low
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function**: `computeMonthlyInsights()`
- **Description & Root Cause**:
  At line 338, the function accepts `_budgetResult?: unknown` as a parameter but never uses it. The underscore prefix indicates it was intentionally ignored, but the function could benefit from the budget result to provide more accurate insights (e.g., comparing actual spending to budgeted amounts, or highlighting categories that are overspent). The current implementation only compares current month spending to a 3-month average, ignoring the budgeted amounts entirely.

- **Reproduction / Scenario**:
  N/A — this is a code quality issue, not a runtime bug.

- **Potential Impact**:
  Missed opportunity for richer insights. The function only does trend analysis but could also flag categories where spending exceeds the budgeted amount.

- **Introduced By**:
  Commit `65f007c` ("fix: right sidebar") — the monthly insights feature. The `_budgetResult` parameter was threaded through from the caller at introduction but never wired into the insight logic.

- **Regression Prevention**:
  N/A — code quality issue, no behavioral contract to protect. If the parameter is removed, add a compile-time check (no-unused-params lint rule) so dead parameters can't accumulate silently.

- **Recommended Resolution**:
  Either remove the unused parameter or integrate the budget result to provide budget-vs-actual insights.

---

### [BUG-17] `assertSplitsBalanced` Redundant Zero Check
- **Severity**: Low
- **Category**: Splits & Transfers
- **Location**:
  - **File**: `packages/logic/src/split.ts`
  - **Function**: `assertSplitsBalanced()`
- **Description & Root Cause**:
  At lines 100-108, the `toCents` helper converts a value to cents and validates it. At line 112, it checks `if (parent === 0)` and throws. Then at line 122, it checks `if (childAmount === 0)` for each child. The `toCents` function already uses `Math.round(n)` which can return 0 for non-zero inputs like `0.4` (rounds to 0). The subsequent zero check catches this.

  However, the control flow is confusing: `toCents` can throw via `return fail(...)` (which always throws), but the `return` keyword before `fail()` is redundant since `fail()` never returns. The function signature `(message: string): never` is correct, but the `return fail(...)` pattern is misleading — it looks like a return statement but actually throws. This is a code style issue, not a bug, but could confuse future maintainers.

- **Reproduction / Scenario**:
  N/A — code quality issue.

- **Potential Impact**:
  None at runtime. Maintenance risk: a developer might mistakenly think `return fail(...)` returns normally and add code after it.

- **Introduced By**:
  Commit `4ca2318` ("feat: transfer and split") introduced `assertSplitsBalanced` as the single source of truth for split validation (later consolidated in the BUG-18.3 refactor referenced in its docstring). Commit `e81c59d` ("fix: transfers in subtransactions") refined the child-category rules. The `return fail(...)` style dates to the original consolidation.

- **Regression Prevention**:
  1. Add a lint rule (e.g., `@typescript-eslint/no-invalid-void-type` won't catch this, but a review checklist or ESLint `no-return-throw` style rule helps) discouraging `return` before a `never`-returning call.
  2. Add exhaustive unit tests for `assertSplitsBalanced` covering: zero parent, zero child, mixed-sign balanced split, unbalanced-by-one-cent split, 1-child split — locking the contract that both UI and server rely on (single source of truth, BUG-18.3).
  3. Any change to `assertSplitsBalanced` must run both the transaction and recurring test suites, since both consume it via their own error factories.

- **Recommended Resolution**:
  Remove the `return` before `fail()` calls, or change `fail` to not have a `never` return type and instead throw explicitly at each call site.

---

### [BUG-18] `num` Function Silently Converts Non-Cents Strings
- **Severity**: Low
- **Category**: Format / Unit Coercion
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function**: `num()`
- **Description & Root Cause**:
  The `num` function at lines 47-89 strips currency symbols, commas, spaces, and underscores, but NOT decimal points. If a dollar-formatted string like `"$1,234.56"` is passed, the function returns `Math.round(Number("1234.56"))` = 1235, not 123456 (the cent value). The function is designed for integer cent strings (e.g., "123456"), and in practice it receives such strings from `getBudgetData` which calls `String(integer_cents)`. However, the function's signature accepts `string | number | null | undefined`, and callers outside the server's `getBudgetData` path (e.g., UI components, tests) might pass dollar amounts.

  The `numCents` function at line 95 exists as a stricter alternative that throws on non-integer input, but `num` is used pervasively throughout the budget engine and reports.

- **Reproduction / Scenario**:
  1. A test or UI component calls `num("$1,234.56")`.
  2. Returns 1235 instead of 123456.
  3. If this value is used as cents in a budget calculation, it's off by a factor of ~100.

- **Potential Impact**:
  Low in practice because DB values are always integer cent strings. But the function's lack of input validation makes it a footgun for future development.

- **Introduced By**:
  Commit `6308053` ("feat: init") — original utility. Commit `bdffa94` ("fix(logic): support currency symbols and formatted delimiters in num() (UNI-47)") added the symbol/delimiter stripping, which widened the accepted input space (and thus the footgun) without adding a decimal-digits guard.

- **Regression Prevention**:
  1. Add a unit test documenting current behavior: `num("1234.56") === 1235` — making the rounding-truncation contract explicit so future changes are conscious decisions.
  2. Add a test asserting `num` throws (or is documented to never receive) inputs with non-zero fractional parts from production call sites; grep-audit call sites and list them in a comment on `num`.
  3. Add a round-trip property test: for all DB-loaded amounts, `num(String(centValue)) === centValue` — this is the actual invariant the engine relies on.
  4. If a decimal guard is added, run the full logic test suite — the UNI-47 currency-stripping tests are the ones most likely to interact with the change.

- **Recommended Resolution**:
  Add a check: if the parsed string contains a decimal point and has non-zero fractional digits, throw or warn. Alternatively, deprecate `num` in favor of `numCents` for all new code.

---

### [BUG-19] `computeNetWorthReport` Tracks Off-Budget Accounts Without Transactions
- **Severity**: Low
- **Category**: Reports & Analytics
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function**: `computeNetWorthReport()`
- **Description & Root Cause**:
  At lines 167-178, for each month in the range, the function iterates all accounts and includes their balance if they have had transactions (tracked by `earliestMonthByAccount`). Accounts without ANY transactions (e.g., a manually-added "House Value" tracking account with a balance but no transactions) have no entry in `earliestMonthByAccount`, so the check `if (earliest && m < earliest)` at line 171 does NOT skip them. They appear in every month at their current balance.

  This means a "House Value" account of $500,000 added today will appear as $500,000 in all historical months going back years. The net worth chart will show a flat line at $500,000 for the entire history, which is incorrect — the house value should only appear from the month the account was created.

- **Reproduction / Scenario**:
  1. Create an off-budget tracking account "House" with balance $500,000, no transactions.
  2. View the net worth report for the past 12 months.
  3. The house value appears as $500,000 in all 12 months, inflating historical net worth.

- **Potential Impact**:
  Historically inaccurate net worth chart. Users may misinterpret their net worth growth.

- **Introduced By**:
  Commit `c272ac5` (2026-08-17, "fix(logic): clamp net-worth report balances prior to account creation (UNI-36)") — **this is a partial regression from a previous bug fix**. UNI-36 correctly added the `earliestMonthByAccount` clamp for accounts *with* transactions, but the guard `if (earliest && m < earliest)` is vacuously false for accounts *without* transactions, so those accounts were silently left out of the fix and still bleed their current balance into all history.

- **Regression Prevention**:
  1. Add a unit test extending the UNI-36 fixture: an off-budget account with a balance and *zero* transactions → assert it does NOT appear in months before the report end month (or before its creation month once that exists).
  2. Add a test that the historical net worth line for a newly-added tracking account is flat at 0 (not at its current balance) for all prior months.
  3. When the account creation-date migration lands, add a round-trip test: YNAB4 import → net worth report → historical values exclude accounts from before their import date.

- **Recommended Resolution**:
  Track account creation date (currently not stored in the schema) and use it as the "earliest" month for accounts without transactions. Alternatively, for accounts without transactions, exclude them from months before the current month (or the month they were created in). Without a creation date field, the best option is to only show such accounts in the latest month.

---

### [BUG-20] `AccountPatchSchema` Validation Gap for `onBudget` Without `kind`
- **Severity**: Low
- **Category**: Database & API
- **Location**:
  - **File**: `apps/web/src/app/api/schemas.ts`
  - **Function**: `AccountPatchSchema`
- **Description & Root Cause**:
  At lines 96-117, the `AccountPatchSchema` validates that when BOTH `kind` and `onBudget` are provided, they must be consistent. However, if only `onBudget` is provided without `kind`, the refinement at lines 107-113 doesn't trigger (since `data.kind === undefined`). The server's `updateAccount` function at `packages/server/src/queries/accounts.ts` lines 96-148 handles this correctly by checking the existing account's kind. But the API schema allows `onBudget: false` on a liquid account without providing `kind`, which the server would correctly handle (it checks `nextKind !== "offbudget" && nextOnBudget === false` at line 138-140 and would throw).

  This is not a bug per se — the server validates it correctly. But the API schema could provide a better error message by validating at the Zod level.

- **Reproduction / Scenario**:
  1. PATCH an existing liquid account with `{ onBudget: false }` (without `kind`).
  2. Zod validation passes.
  3. Server throws `AccountError("Liquid/credit accounts cannot have onBudget set to false", 400)`.

- **Potential Impact**:
  Minor UX: the error message comes from the server (400) rather than being caught by Zod (which could provide a more specific path-based error).

- **Introduced By**:
  Present since the API schema layer was created alongside the account endpoints (early in the monorepo conversion, `5386db7`). The schema-level consistency check only covers the both-fields-present case by design; server-side validation has always been the backstop.

- **Regression Prevention**:
  1. Add an API integration test: PATCH `{ onBudget: false }` on a liquid account → assert HTTP 400 with the server's consistency message (locks in the current backstop behavior).
  2. Add a test: PATCH `{ kind: "offbudget" }` on an account with existing transactions → assert HTTP 422 (the "cannot change type with transactions" path).
  3. If the Zod schema is ever tightened to cover the single-field case, keep the server check — the two layers must agree, and tests on both sides prevent either from drifting.

- **Recommended Resolution**:
  Add a Zod `superRefine` that checks the combination of `kind` (from patch or requires querying) and `onBudget`. Since Zod doesn't have access to the DB, this would need to be a runtime check, not a schema-level one. The current behavior is acceptable.

---

## Production Readiness Assessment & Next Steps

### Overall Assessment
The codebase is **moderately production-ready**. The core budget engine correctly implements YNAB4's envelope budgeting algorithm, and the split/transfer integrity layer is well-designed with centralized validation. The reconciliation flow properly locks reconciled transactions. The CSV and YNAB4 import paths handle the most common edge cases.

### The Regression Problem Must Be Addressed First

The regression analysis above shows a clear systemic issue: **roughly a third of all findings were introduced by previous bug-fix commits, four of them within the last 48 hours**. Fixing BUG-01 through BUG-20 without changing this pattern will simply grow the list. Before (or alongside) the individual fixes below:

1. **Adopt a "no fix without a pinning test" rule**: every bug-fix commit must include a test that fails on the pre-fix code. The git history shows fixes (e.g., `989678f`, `9cbb708`, `7296aff`) that shipped with no test guarding the new behavior, which is precisely how BUG-05, BUG-11, and BUG-15 slipped through.
2. **Add a regression test index**: maintain a test naming convention (e.g., `regression BUG-XX`) so that each historical fix is traceable to a test, and a fix can never be reverted accidentally by a refactor.
3. **Freeze-and-test before refactors**: BUG-02, BUG-13, and BUG-12 arose when perf/refactor work (`fix: BUG-07`, cache introduction) touched subtly-correct code. Run the full suite and add characterization tests before touching `budget-engine.ts` caching or diagnostics SQL again.

### What Must Be Fixed Before Production Use

1. **[BUG-01] (Critical)**: Fix `isIncomeTransaction` to not unconditionally exclude split children. This is the most impactful bug — it could silently understate TBB for users with paycheck splits.

2. **[BUG-02] (Critical)**: Fix the cache invalidation logic in `computeBudget` to properly clear cached entries for both `data` and `normData` objects. While unlikely in current usage, this is a latent race condition that could produce incorrect budget numbers after mutations.

3. **[BUG-07] (High)**: Increase the `detectMilliunitScale` threshold or implement a more robust detection method. The current threshold of $1,000 is too low and could corrupt imports of budgets with large transactions. **Note this was introduced ~8 hours before this audit by the BUG-01 fix commit (`b129f6e`) — fix it before the next import is run against a real backup.**

4. **[BUG-03] (High)**: Fix `minMonthSpend` initialization in `computeSpendingTrends` — this is a one-line fix with significant impact on reporting accuracy.

5. **[BUG-05] (High)**: Fix split sibling propagation ordering in `bulkUpdateTransactions` to ensure deterministic results when both parent and children are updated in the same batch.

6. **[BUG-06] (High)**: Address the `twiceamonth` scheduling drift for `anchorDay > 15`. This affects users who schedule semimonthly paychecks or bills on dates like the 16th/31st.

7. **[BUG-11] (Medium)**: Relax the CSV import `kind !== "credit"` guard, preserving the categorized-refund invariant the original fix protected (see its Regression Prevention section).

### Recommended Enhancements Before Production

1. Add a database migration to store account creation date, enabling accurate historical net worth for accounts without transactions (also required to fully fix BUG-19).
2. Add a database CHECK constraint enforcing "split parents are never transfers" (`transfer_account_id IS NULL OR parent_id IS NULL`) — the strongest guard for the class of bugs affecting BUG-12/BUG-15.
3. Add integration tests for the full budget computation pipeline (TBB invariant across month transitions, CC buffer correctness, overspending carryover).
4. Add fuzz tests for `dollarsToCents`, `num`, and `evalAmount` to catch floating-point edge cases.
5. Add an E2E test for the YNAB4 roundtrip (export → import → verify balances match), including a fixture with both milliunit and decimal-dollar encodings to pin `detectMilliunitScale` behavior.
6. Add a parity test between the SQL `getReconcileState` and the pure-TS `computeReconcileState` so the two implementations cannot drift (BUG-09 class).
7. Run `verifyBudgetIntegrity` periodically (or on every budget load) to catch invariant violations early.
