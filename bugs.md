# Codebase Audit & Bug Report

**Audit Date**: August 25, 2026  
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

An exhaustive code review and financial logic audit was conducted across the entire monorepo (`packages/logic`, `packages/server`, `packages/theme`, `packages/ui`, and `apps/web`). The application implements a zero-based envelope budgeting system designed as a high-fidelity alternative to YNAB4 (You Need A Budget 4).

While the repository demonstrates strong software engineering practices (TypeScript strict mode, Drizzle ORM migrations, atomic SQL write transactions, automated testing fixtures, and optimistic UI updates), several critical financial accounting flaws, state inconsistencies, date calculation bugs, and API edge-case failures were identified.

The most severe issues include:
1. **Uncaught exceptions during auto-posting of recurring transfers to off-budget accounts** that cause the primary `GET /api/budget` endpoint to fail with HTTP 500.
2. **Client-side reconciliation working balance corruption** in `BudgetApp.tsx` that double-counts split transaction parents and omits inbound transfers, breaking the reconciliation modal and causing false 422 errors.
3. **Empty patch object crashes in database update queries** (`updateCategory`, `updateAccount`, `updateTransaction`) which produce invalid SQL syntax (`UPDATE ... SET WHERE`).
4. **Permanent schedule drift in recurring transaction frequency math** (`nextDateFor`) where monthly and semimonthly schedules get irreversibly stuck on the 28th after encountering February or short months.

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | 3 | Recurring Auto-Posting, Boundary Transfers, Reconcile UI Working Balance |
| **High** | 4 | Database Updates on Empty Patches, Category Carryover Persistence, Recurring Schedule Drift, Credit Card Cash/Debt Overspending Segregation |
| **Medium** | 5 | Reconciled Account Deletion Guard, Negative Zero Formatting, Calendar Internal Transfer Accounting, Expense Display Formatting, Disconnected Engine Code |
| **Low** | 3 | CSV Text Month Parsing, Comma Coercion in Math Evaluator, Populated Calendar Day Add Affordance |
| **Code Quality / Inconsistency** | 3 | Bulk Edit Validation on Reconciled Selection, Projections Anchor vs View Month, WeakMap Cache Invalidation |

---

## Detailed Bug Findings

### [BUG-01] Recurring Transfer to Off-Budget Account Crashes Auto-Posting and Breaks Budget Loading
- **Severity**: Critical
- **Category**: Recurring / Database & API
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `normaliseInput()`, `createRecurring()`, `postRecurringTransaction()`
- **Description & Root Cause**:
  In `normaliseInput()` (`recurring.ts`), when a recurring rule is a transfer (`isTransfer` is true), the category is unconditionally forced to `null`:
  ```ts
  const effectiveCategoryId = isTransfer || isSplit ? null : (explicitCategoryId ?? null);
  ```
  Consequently, `recurring.categoryId` is stored as `NULL` in the database, even when the transfer targets an off-budget account (e.g. monthly savings contributions to Wealthsimple TFSA, RRSP, or mortgage principal).
  
  When `postRecurringTransaction()` or `autoPostDueRecurringTransactions()` executes, it calls `createTransaction()` with `categoryId: r.categoryId` (which is `null`) and `transferAccountId: r.transferAccountId`. `createTransaction()` invokes `createTransfer()`, which checks whether the transfer crosses the budget boundary. For an outflow from an on-budget account to an off-budget account, `createTransfer()` strictly enforces that a budget category must be provided:
  ```ts
  if (baseInput.categoryId == null) {
    throw new TransactionError("Boundary transfer outflow requires a category", 400);
  }
  ```
  This throws an unhandled `TransactionError`. Because `GET /api/budget` (`apps/web/src/app/api/budget/route.ts`) automatically triggers `autoPostDueRecurringTransactions(db)` on every request, any due recurring transfer to an off-budget account crashes the entire budget fetch endpoint with HTTP 500.
- **Reproduction / Scenario**:
  1. Create an off-budget investment account (e.g. "TFSA Investment").
  2. Create a recurring monthly transfer from "Chequing" to "TFSA Investment".
  3. Set `nextDate` to today or a past date.
  4. Reload the app or execute `GET /api/budget`. The request fails with HTTP 500.
- **Potential Impact**:
  Total application denial of service. The user is unable to load the budget once a scheduled investment or mortgage transfer becomes due.
- **Recommended Resolution**:
  Update `normaliseInput()` in `packages/server/src/queries/recurring.ts` to inspect whether `transferAccountId` represents an off-budget boundary crossing. If the source account is on-budget and the target account is off-budget, preserve `explicitCategoryId` rather than forcing it to `null`.

---

### [BUG-02] Recurring Split with Off-Budget Transfer Child Throws Uncaught Exception on Materialization
- **Severity**: Critical
- **Category**: Splits & Transfers / Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `createRecurring()`, `updateRecurring()`
- **Description & Root Cause**:
  When inserting sub-transactions for a recurring split in `createRecurring()` and `updateRecurring()`, `categoryId` is forced to `null` whenever `transferAccountId` is present:
  ```ts
  const categoryId = transferAccountId ? null : (onBudget && c.categoryId ? Number(c.categoryId) : null);
  ```
  When a recurring split represents a paycheck with deductions (e.g. gross pay income, tax deduction, and a transfer deduction into an off-budget 401k/RRSP account), the transfer sub-transaction's category is saved as `NULL`.
  
  When `postRecurringTransaction()` materializes the recurring entry, it passes the children to `createSplitWithChildren()`. In `createSplitWithChildren()`, each child with a `transferAccountId` crossing into an off-budget account is checked:
  ```ts
  if (categoryId == null) {
    throw new TransactionError("Boundary transfer outflow requires a category", 400);
  }
  ```
  This throws a `TransactionError`, aborting transaction posting and crashing `autoPostDueRecurringTransactions()`.
- **Reproduction / Scenario**:
  1. Create an on-budget Chequing account and an off-budget Pension/RRSP account.
  2. Create a recurring split transaction on Chequing with a category expense child and an off-budget transfer child.
  3. Trigger "Enter Now" or let `nextDate` elapse.
  4. Posting fails with a 400/500 error.
- **Potential Impact**:
  Scheduled split transactions containing investment or debt transfer legs fail to auto-post and crash background queue execution.
- **Recommended Resolution**:
  In `createRecurring()` and `updateRecurring()`, do not force `categoryId` to `null` for transfer sub-transactions if the transfer crosses into an off-budget account. Allow `categoryId` to persist on `recurringSubTransactions`.

---

### [BUG-03] Client-Side Reconcile Working Balance Double-Counts Split Parents and Omits Inbound Transfers
- **Severity**: Critical
- **Category**: Reconcile / UI & State
- **Location**:
  - **File**: `packages/ui/src/BudgetApp.tsx`
  - **Function / Component / Symbol**: `reconcileState` memo calculation
- **Description & Root Cause**:
  In `BudgetApp.tsx`, `reconcileState` calculates the account's working balance client-side for the `ReconcileModal`:
  ```ts
  const txns = data.transactions.filter((t) => t.accountId === acct.id);
  const clearedSum = txns
    .filter((t) => t.status === "c")
    .reduce((s, t) => s + num(t.amount), 0);
  const reconciledSum = txns
    .filter((t) => t.status === "r")
    .reduce((s, t) => s + num(t.amount), 0);
  const workingBalance = clearedSum + reconciledSum;
  ```
  This implementation suffers from three critical flaws:
  1. **Double-counting split transactions**: `txns` includes both the split parent row (`parentId === null`, e.g., -$100) and the split child rows (`parentId !== null`, e.g., -$60 and -$40). Both are summed into `clearedSum`, doubling the split's balance impact (-$200 instead of -$100).
  2. **Omitting inbound transfers**: It only filters `t.accountId === acct.id`, completely ignoring transfers where `t.transferAccountId === acct.id` (funds transferred into this account).
  3. **Ignoring statement date boundary**: It includes future-dated cleared transactions beyond the statement date.
  
  Because the client computes an incorrect working balance, the `ReconcileModal` shows a false difference. If the user accepts or balances the modal and submits to `/api/reconcile`, the backend re-computes the true working balance via `getReconcileState()` (which correctly includes inbound transfers and excludes split parents). The backend detects a non-zero difference and, finding no adjustment category selected, rejects the request with HTTP 422: `"Statement balance does not match the working balance; provide an adjustment category to absorb the difference."`
- **Reproduction / Scenario**:
  1. Have an account with at least one split transaction or one inbound transfer from another account.
  2. Click "Reconcile" on the account.
  3. Observe that the displayed "Working Balance" does not match the register balance or the actual sum of cleared transactions.
  4. Attempt to reconcile with the true statement balance; the modal submission fails with a 422 error.
- **Potential Impact**:
  Users cannot reconcile any account containing split transactions or inbound transfers.
- **Recommended Resolution**:
  Align `reconcileState` in `BudgetApp.tsx` with the server's `getReconcileState()` query:
  - Exclude split parent IDs (`t.id` in `splitParentIds`).
  - Include inbound transfers (`t.transferAccountId === acct.id`), negating `t.amount`.
  - Filter transactions by `t.date <= statementDate`.

---

### [BUG-04] `updateCategory`, `updateAccount`, and `updateTransaction` Throw SQLite Syntax Errors on Empty Patch
- **Severity**: High
- **Category**: Database & API
- **Location**:
  - **File**: `packages/server/src/queries/categories.ts`, `packages/server/src/queries/accounts.ts`, `packages/server/src/queries/transactions.ts`
  - **Function / Component / Symbol**: `updateCategory()`, `updateAccount()`, `updateTransaction()`
- **Description & Root Cause**:
  When these query functions receive an empty patch object (or fields that evaluate to `undefined`), the internal dictionary `p` remains `{}`.
  Unlike `updateCategoryGroup()` and `updateRenameRule()` which explicitly guard:
  ```ts
  if (Object.keys(p).length === 0) return current;
  ```
  `updateCategory()`, `updateAccount()`, and `updateTransaction()` directly execute:
  ```ts
  const [row] = await db.update(table).set(p).where(eq(table.id, id)).returning();
  ```
  Passing an empty object `{}` to Drizzle ORM's SQLite builder compiles to the invalid SQL query `UPDATE <table> SET  WHERE id = ?`. SQLite fails compilation and throws a `SqliteError: near "WHERE": syntax error`, resulting in an unhandled 500 error.
- **Reproduction / Scenario**:
  1. Send a request `PATCH /api/categories` with body `{"id": 10}`.
  2. The server crashes with HTTP 500 and logs a SQLite syntax error.
- **Potential Impact**:
  API requests sending no-op patches cause server 500 errors instead of cleanly returning the unchanged entity.
- **Recommended Resolution**:
  Add an early return guard in `updateCategory()`, `updateAccount()`, and `updateTransaction()`:
  ```ts
  if (Object.keys(p).length === 0) {
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return row ?? null;
  }
  ```

---

### [BUG-05] Unchecking Opening Carryover in Category Edit Modal Fails to Clear Carryover
- **Severity**: High
- **Category**: UI & State / Core Budget Engine
- **Location**:
  - **File**: `packages/ui/src/Modals.tsx` (`CategoryModal`), `packages/server/src/queries/categories.ts` (`updateCategory`)
  - **Function / Component / Symbol**: `CategoryModal.save()`, `updateCategory()`
- **Description & Root Cause**:
  In `CategoryModal`, when a user unchecks "Set opening carryover balance" (`hasCarryover = false`), `onSave` evaluates:
  ```ts
  carryover: hasCarryover && evalAmount(carryover) != null ? Math.round((evalAmount(carryover) ?? 0) * 100) : undefined
  ```
  `v.carryover` is passed as `undefined`. `BudgetAppShell` sends `{ id, name, carryover: undefined, ... }` via `PATCH /api/categories`.
  On the server, `updateCategory()` inspects:
  ```ts
  if (patch.carryover != null) p.carryover = assertValidAmount(patch.carryover);
  ```
  Because `patch.carryover` is `undefined`, `p.carryover` is omitted. The database column retains its previous non-zero carryover value. The user cannot reset an opening category balance back to zero.
- **Reproduction / Scenario**:
  1. Create a category with a $50 opening carryover.
  2. Open the edit modal for the category and uncheck "Set opening carryover balance".
  3. Click "Save Changes".
  4. Inspect the budget or reload; the category still carries the $50 opening balance.
- **Potential Impact**:
  Category seed carryover balances cannot be removed or cleared through the UI once set.
- **Recommended Resolution**:
  In `CategoryModal`, pass `carryover: hasCarryover && evalAmount(carryover) != null ? Math.round((evalAmount(carryover) ?? 0) * 100) : 0` so that unchecking the option explicitly sends `0` to the server.

---

### [BUG-06] Permanent Schedule Drift in `nextDateFor()` After February or Short Months
- **Severity**: High
- **Category**: Recurring / Core Domain Math
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `nextDateFor()`
- **Description & Root Cause**:
  `nextDateFor()` advances an ISO date string without storing or referencing the original recurring rule anchor day.
  1. **Monthly clamping drift**: If a recurring rule is scheduled on the 31st (e.g. `2026-01-31`), advancing one month clamps the date to `2026-02-28`. When the next month arrives, `nextDateFor("monthly", "2026-02-28")` reads `originalDay = 28` and advances to `2026-03-28`, permanently drifting all future months to the 28th.
  2. **Semimonthly drift**: For `twiceamonth` / `semimonthly`, if the date is `2026-02-28`, `originalDay = 28 > 15` computes `targetDay = 28 - 15 = 13`. The date becomes `2026-03-13`. The next interval computes `13 + 15 = 28`, permanently shifting the schedule to the 13th and 28th of every month thereafter.
- **Reproduction / Scenario**:
  1. Create a monthly recurring transaction on `2026-01-31`.
  2. Post occurrences through March 2026.
  3. Observe that the March and April occurrences are scheduled for March 28 and April 28 instead of March 31 and April 30.
- **Potential Impact**:
  Recurring bills and paychecks scheduled for month-end or semimonthly intervals drift to incorrect calendar days.
- **Recommended Resolution**:
  Pass the original anchor day-of-month or anchor ISO date into `nextDateFor()`, or store an explicit `anchorDay` in the `recurring` table so monthly calculations clamp against the anchor day rather than the previous output string.

---

### [BUG-07] Budget Engine Does Not Distinguish Between Cash Overspending and Credit Card Debt Overspending
- **Severity**: High
- **Category**: Core Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildRawIndex()`, `buildCarryoverMap()`, `computeBudget()`
- **Description & Root Cause**:
  In YNAB4's envelope model, overspending behaves differently depending on whether it was incurred on Cash/Checking (Cash Overspending) or a Credit Card (Credit Card Overspending):
  - **Cash Overspending**: Deducted from next month's To Be Budgeted (TBB) and clamped to 0 in the category.
  - **Credit Card Overspending**: Adds to the debt on the Credit Card account, does *not* move cash into the CC Payment buffer, does *not* deduct from next month's TBB, and category balance resets to 0.
  
  In `budget-engine.ts`, when spending occurs on a Credit Card in an unfunded category (e.g. $100 charged to AMEX in Groceries with $0 budgeted):
  1. `buildRawIndex` transfers the full +$100 into the AMEX CC Payment buffer (`spendByAccountMonth`).
  2. In `buildCarryoverMap`, Groceries available balance (-$100) is clamped to 0 and added to `monthOverspent` (deducted from next month's cash TBB).
  3. The AMEX CC Payment category retains +$100 in available cash.
  
  This double-penalizes cash TBB while creating phantom backed funds in the Credit Card Payment category for debt that was never backed by cash.
- **Reproduction / Scenario**:
  1. Start with $0 TBB and $0 assigned in all categories.
  2. Charge a $100 transaction on a Credit Card categorized to "Groceries".
  3. In the current month, CC Payment category shows $100 Available to pay the card, despite no cash existing to back it.
  4. In the next month, TBB becomes -$100 (cash overspent deduction), while CC Payment still holds $100.
- **Potential Impact**:
  Severe divergence from YNAB4 credit card accounting principles; artificial inflation of credit card payment available balances and incorrect cash TBB deductions.
- **Recommended Resolution**:
  In `buildRawIndex()` and `buildCarryoverMap()`, calculate credit card buffer transfers based on the *funded* portion of category spending. If category available balance is negative, limit the credit card buffer transfer to the available cash, and record the unfunded remainder as credit card debt without adding it to `monthOverspent` (cash TBB deduction).

---

### [BUG-08] `deleteAccount` Bypasses Reconciled Transaction Lock for Own Transactions
- **Severity**: Medium
- **Category**: Register & Balance / Reconcile
- **Location**:
  - **File**: `packages/server/src/queries/accounts.ts`
  - **Function / Component / Symbol**: `deleteAccount()`
- **Description & Root Cause**:
  `deleteAccount()` checks whether any counterparty transactions (`transferAccountId = id`) on *other* accounts are reconciled (`status === 'r'`) and throws a 422 error if so. However, it does not inspect transactions residing directly on the account being deleted (`accountId = id`).
  When `db.delete(accounts).where(eq(accounts.id, id))` executes, SQLite's `ON DELETE CASCADE` foreign key rule deletes all transactions on that account, bypassing the reconciliation lock.
- **Reproduction / Scenario**:
  1. Reconcile an account with 50 cleared transactions (all become `status = 'r'`).
  2. Delete the account.
  3. The account and all 50 reconciled transactions are deleted without error.
- **Potential Impact**:
  Locked audit history and historical financial records can be destroyed without warning or un-reconciling.
- **Recommended Resolution**:
  In `deleteAccount()`, query `transactions` where `accountId = id and status = 'r'`. If any exist, throw an `AccountError("Account contains reconciled transactions. Unreconcile before deleting.", 422)`.

---

### [BUG-09] `fmt()` Formats Small Negative Cents as Negative Zero (`-$0.00`)
- **Severity**: Medium
- **Category**: Register & Balance / UI Formatting
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `fmt()`, `fmtSigned()`
- **Description & Root Cause**:
  In `fmt(cents: number)`:
  ```ts
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cents < 0 ? "-$" : "$") + s;
  ```
  If `cents` is a negative number between `-0.49` and `-0.01` (e.g. from fractional math or floating point calculation before rounding), `abs` formats to `"0.00"`, but `cents < 0` evaluates to `true`, returning `-$0.00`.
- **Reproduction / Scenario**:
  1. Call `fmt(-0.2)` or `fmtSigned(-0.01)`.
  2. Output is `-$0.00`.
- **Potential Impact**:
  Confusing visual glitch where zero balances display with a negative sign.
- **Recommended Resolution**:
  Round `cents` to an integer before checking the sign:
  ```ts
  const rounded = Math.round(cents);
  if (rounded === 0) return "$0.00";
  const abs = Math.abs(rounded) / 100;
  return (rounded < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ```

---

### [BUG-10] Calendar View Net Month and Day Net Treat Internal Transfers as Cash Losses
- **Severity**: Medium
- **Category**: Reports & Analytics / UI & State
- **Location**:
  - **File**: `packages/ui/src/CalendarView.tsx`
  - **Function / Component / Symbol**: `CalendarView` (`monthTotal`, `byDay`)
- **Description & Root Cause**:
  `CalendarView` calculates `monthTotal` and day totals by summing `t.amount` for all non-split-parent transactions:
  ```ts
  const monthTotal = data.transactions
    .filter((t) => t.parentId == null && t.date.startsWith(month))
    .reduce((s, t) => s + num(t.amount), 0);
  ```
  For transfers between two on-budget accounts (e.g. $500 from Checking to Savings, stored as `amount: -50000, transferAccountId: 2`), the single transfer row contributes `-$500` to the month's net total and the day's badge, falsely displaying a cash deficit on a pure asset transfer.
- **Reproduction / Scenario**:
  1. Create an on-budget transfer of $1,000 between Checking and Savings.
  2. Switch to Calendar View.
  3. Observe that "Net this month" is reduced by $1,000 and the day cell shows a -$1,000 pill.
- **Potential Impact**:
  Misleading cash flow totals in the calendar view for users who perform routine account transfers.
- **Recommended Resolution**:
  In `CalendarView.tsx`, identify internal on-budget transfers (`t.transferAccountId != null` where both source and destination accounts are on-budget) and exclude them from `monthTotal` and day net totals.

---

### [BUG-11] Inspector Expenses Display Double-Minus `--$X.XX` on Net Category Refunds
- **Severity**: Medium
- **Category**: Reports & Analytics / UI & State
- **Location**:
  - **File**: `packages/ui/src/Inspector.tsx`
  - **Function / Component / Symbol**: `Inspector` (Net Monthly Panel)
- **Description & Root Cause**:
  In `Inspector.tsx`, the outflow line is hardcoded as:
  ```tsx
  <span className="y-num font-medium" style={{ color: "var(--y-ink)" }}>
    -{money(effectiveCashFlow.outflow)}
  </span>
  ```
  If a user receives more in category refunds than spending during a month (e.g. returns on purchases from a prior month), `effectiveCashFlow.outflow` becomes negative (e.g. `-5000`). `money(-5000)` formats as `"-$50.00"`. Prepending `-` results in `--$50.00`.
- **Reproduction / Scenario**:
  1. In a month with no spending, receive a categorized return of $100 (+10000 in Groceries).
  2. Inspect the "Net Monthly" card in the sidebar.
  3. "Expenses (Outflow)" renders as `--$100.00`.
- **Potential Impact**:
  Malformed currency display string in the Inspector panel.
- **Recommended Resolution**:
  Use `effectiveCashFlow.outflow >= 0 ? `-${money(effectiveCashFlow.outflow)}` : `+${money(Math.abs(effectiveCashFlow.outflow))}``.

---

### [BUG-12] Disconnected / Dead Function in `budget-engine.ts`
- **Severity**: Medium
- **Category**: Code Quality / Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeOverspentForMonth()`
- **Description & Root Cause**:
  `computeOverspentForMonth()` was implemented on line 427 of `budget-engine.ts` to compute overspending for a single month, but it is not called by any function in `budget-engine.ts`, nor is it exported in `packages/logic/src/index.ts`. All overspent computation is instead performed inline in `buildCarryoverMap()`.
- **Potential Impact**:
  Dead code maintenance hazard and confusion regarding where overspending calculations occur.
- **Recommended Resolution**:
  Either export and reuse `computeOverspentForMonth()` to DRY up overspent calculation or remove the unused function.

---

### [BUG-13] CSV Importer Rejects Standard Text Month Dates (e.g., "15-Aug-2026", "Aug 15, 2026")
- **Severity**: Low
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseDate()`
- **Description & Root Cause**:
  `parseDate()` only parses dates conforming to purely numeric regular expressions (`/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/` and `/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/`). CSV bank statements using English three-letter month abbreviations (e.g., `15-AUG-2026`, `Aug 15 2026`) fail parsing and are rejected as `"Invalid date"`.
- **Reproduction / Scenario**:
  1. Import a CSV file with date column `15-Aug-2026`.
  2. The preview displays "Invalid date" on every row and disables the import button.
- **Potential Impact**:
  Inability to import bank exports from financial institutions that format dates with text month abbreviations.
- **Recommended Resolution**:
  Add support for 3-letter month abbreviations (`Jan`, `Feb`, `Mar`, etc.) in `parseDate()` before rejecting the string.

---

### [BUG-14] `evalAmount` Indiscriminately Strips Decimal Commas
- **Severity**: Low
- **Category**: Core Domain Math / Format
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `evalAmount()`
- **Description & Root Cause**:
  `evalAmount()` strips commas via `raw.replace(/[$,_]/g, "")`. For users entering amounts with European decimal commas (e.g., `12,50`), the string becomes `1250` ($12.50 becomes $1,250.00).
- **Reproduction / Scenario**:
  1. Type `12,50` into an amount input field.
  2. The input evaluates to $1,250.00 instead of $12.50.
- **Potential Impact**:
  Accidental 100x multiplication of financial amounts for European-format user input.
- **Recommended Resolution**:
  In `evalAmount()`, if a comma is followed by exactly two digits at the end of the expression (e.g. `,50`), treat it as a decimal separator (`.50`) rather than stripping it.

---

### [BUG-15] Calendar View Day Click Prevents Adding Transactions on Populated Days
- **Severity**: Low
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/CalendarView.tsx`
  - **Function / Component / Symbol**: `CalendarView` cell `onClick` handler
- **Description & Root Cause**:
  The `onClick` handler for day cells in `CalendarView` checks:
  ```ts
  if (items.length === 0) onAdd(dateIso(d));
  else setExpandedDay(expanded ? null : d);
  ```
  Once a day has even one transaction, clicking anywhere on that day cell toggles row expansion rather than opening the "Add Transaction" modal. Users cannot use the calendar to add transactions to dates that already have activity.
- **Reproduction / Scenario**:
  1. Navigate to Calendar View.
  2. Click a date that already has a transaction.
  3. The day expands/collapses instead of opening the Add Transaction modal.
- **Potential Impact**:
  Impaired workflow when adding multiple transactions on the same date from the Calendar view.
- **Recommended Resolution**:
  Add an explicit "+" button inside the day cell header (next to the day number) that calls `onAdd(dateIso(d))` regardless of existing items.

---

### [BUG-16] Projections View Uses Current Live Balance Even When Viewing Historical Months
- **Severity**: Code Quality / UI Inconsistency
- **Location**:
  - **File**: `packages/ui/src/ProjectionsView.tsx`
  - **Function / Component / Symbol**: `ProjectionsView`
- **Description & Root Cause**:
  `ProjectionsView` computes `liquidNow` from current live account balances (`data.accounts.reduce(...)`), while generating projection point month labels starting from `parseMonthKey(month)` (the active month in view). If the user views a historical month (e.g. `2024-01`), month 0 of the forecast is labeled `Jan 24` but starts with the 2026 live balance.
- **Reproduction / Scenario**:
  1. Select a past month in Budget view.
  2. Navigate to Projections view.
  3. Month 0 is labeled with the historical month, but the dollar amount is today's current balance.
- **Potential Impact**:
  Temporal mismatch between the projection chart labels and the starting balance data.
- **Recommended Resolution**:
  Anchor the projection forecast to `todayISO()`'s current month by default, or compute historical liquid balances up to `month` when viewing past dates.

---

### [BUG-17] Bulk Edit Modal Allows Submitting Reconciled Transactions Despite Warning Banner
- **Severity**: Code Quality / UX Flaw
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/BulkEditModal.tsx`
  - **Function / Component / Symbol**: `BulkEditTransactionsModal` (`isValid`, `handleSave`)
- **Description & Root Cause**:
  `BulkEditTransactionsModal` displays a warning notice when `hasReconciled` is true (`"One or more selected transactions are reconciled and locked"`), but it does not disable the submit button or exclude reconciled transaction IDs from `transactionIds`. When the user confirms the update, the backend rejects the entire batch with 422, creating a failed mutation toast.
- **Potential Impact**:
  Frustrating user experience when trying to bulk-edit mixed selections of cleared and reconciled transactions.
- **Recommended Resolution**:
  Either automatically filter out reconciled transactions (`status === "r"`) from the update payload with a notice (`"X reconciled transactions will be skipped"`), or disable the "Review Changes" button when all selected transactions are reconciled.

---

### [BUG-18] Pre-Indexed Cache in `budget-engine.ts` Not Invalidated on In-Place Data Mutation
- **Severity**: Code Quality / Cache Invalidation
- **Category**: Core Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `budgetDataIndexCache`, `getOrBuildIndex()`
- **Description & Root Cause**:
  `budgetDataIndexCache` stores indexed budget computations in a `WeakMap<BudgetData, IndexedBudgetData>`. If a consumer modifies properties or arrays on an existing `BudgetData` object reference without constructing a new object identity, `getOrBuildIndex()` returns the stale cached index. While `BudgetAppShell` creates new object references on state updates, direct consumers of `@ynab/logic` risk silent calculation errors if objects are reused.
- **Potential Impact**:
  Stale cache reads if budget data is mutated in-place by external tools or unit tests.
- **Recommended Resolution**:
  Provide an explicit cache invalidation helper `invalidateBudgetIndex(data: BudgetData)` or attach the index directly to `data.budgetIndex`.

---

## Production Readiness Assessment & Next Steps

### Summary Assessment
The application core has a robust foundation:
- Clean monorepo architecture separating pure logic (`@ynab/logic`), persistence (`@ynab/server`), design system (`@ynab/theme`), and presentation (`@ynab/ui`).
- Integer cent representation across database schema and logic prevents binary floating-point drift.
- Atomic SQL write transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) guard against partial database corruption on multi-table writes.
- High-fidelity visual styling faithful to YNAB4's original design language.

However, **the application is not yet ready for production deployment with real financial data** until the Critical and High severity bugs are resolved. Specifically, running into an automatic recurring investment post will crash the budget API, and the client-side reconciliation flow will fail on any account with split transactions.

### Recommended Remediation Priority:
1. **Fix Recurring Boundary Transfers ([BUG-01], [BUG-02])**: Allow `categoryId` on recurring transfers and recurring split transfer legs that cross into off-budget accounts.
2. **Fix Client Reconciliation State ([BUG-03])**: Correct `reconcileState` in `BudgetApp.tsx` to include inbound transfers, exclude split parents, and respect statement dates.
3. **Guard Empty Database Updates ([BUG-04])**: Add empty-patch guards to `updateCategory()`, `updateAccount()`, and `updateTransaction()`.
4. **Fix Category Carryover Clearing ([BUG-05])**: Ensure `CategoryModal` sends `0` instead of `undefined` when opening carryover is unchecked.
5. **Fix Frequency Clamping Math ([BUG-06])**: Anchor monthly and semimonthly date calculations to an immutable day-of-month anchor.
6. **Separate CC Overspending from Cash TBB ([BUG-07])**: Align credit card overspending with YNAB4 debt mechanics to prevent phantom cash buffers.
