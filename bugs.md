# Codebase Audit & Bug Report

**Audit Date**: August 25, 2026  
**Revision**: Reviewed & re-verified August 25, 2026 — every finding re-checked against source; key claims reproduced empirically against an in-memory migrated SQLite database (Drizzle + better-sqlite3). Two previously unreported findings added ([BUG-19], [BUG-20]); [BUG-04] scope corrected; `money()` added to [BUG-09].  
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

An exhaustive code review and financial logic audit was conducted across the entire monorepo (`packages/logic`, `packages/server`, `packages/theme`, `packages/ui`, and `apps/web`). The application implements a zero-based envelope budgeting system designed as a high-fidelity alternative to YNAB4 (You Need A Budget 4).

While the repository demonstrates strong software engineering practices (TypeScript strict mode, Drizzle ORM migrations, atomic SQL write transactions, automated testing fixtures, and optimistic UI updates), several critical financial accounting flaws, state inconsistencies, date calculation bugs, and API edge-case failures were identified.

The most severe issues include:
1. **Uncaught exceptions during auto-posting of recurring transfers to off-budget accounts** that cause the primary `GET /api/budget` endpoint to fail with HTTP 500 ([BUG-01], [BUG-02]; reproduced).
2. **Silent data corruption from API-route patch reconstruction** ([BUG-19]; reproduced): route handlers rebuild patch objects with *all keys present* (`value: undefined`), while the query layer uses JavaScript `in` presence checks — so routine actions like clicking a transaction's cleared marker, setting a flag, or drag-reordering a category **erase `categoryId`, `incomeMonth`, `goalTarget`, and `overspendCarriesOver` values in the database**.
3. **Client-side reconciliation working balance corruption** in `BudgetApp.tsx` that double-counts split transaction parents and omits inbound transfers, breaking the reconciliation modal and causing false 422 errors ([BUG-03]).
4. **Empty patch object crashes in database update queries** (`updateCategory`, `updateAccount`) which produce invalid SQL (`UPDATE ... SET  WHERE`) ([BUG-04]). Correction: `updateTransaction` was originally reported here but is **not** vulnerable — see the revised entry.
5. **Permanent schedule drift in recurring transaction frequency math** (`nextDateFor`) where monthly and semimonthly schedules get irreversibly stuck after encountering February or short months ([BUG-06]; reproduced).

| Severity | Count | Findings |
| :--- | :--- | :--- |
| **Critical** | 4 | [BUG-01] Recurring Auto-Posting, [BUG-02] Boundary Split Transfers, [BUG-03] Reconcile UI Working Balance, [BUG-19] Route Patch Reconstruction Data Loss |
| **High** | 4 | [BUG-04] Empty-Patch Updates (`updateCategory`/`updateAccount`), [BUG-05] Category Carryover Persistence, [BUG-06] Recurring Schedule Drift, [BUG-07] Credit Card Cash/Debt Overspending Segregation |
| **Medium** | 6 | [BUG-08] Reconciled Account Deletion Guard, [BUG-09] Negative Zero Formatting, [BUG-10] Calendar Internal Transfer Accounting, [BUG-11] Expense Display Formatting, [BUG-12] Disconnected Engine Code, [BUG-20] CC-Originating Transfers Ignore Payment Buffer |
| **Low** | 3 | [BUG-13] CSV Text Month Parsing, [BUG-14] Comma Coercion in Math Evaluator, [BUG-15] Populated Calendar Day Add Affordance |
| **Code Quality / Inconsistency** | 3 | [BUG-16] Projections Anchor vs View Month, [BUG-17] Bulk Edit Validation on Reconciled Selection, [BUG-18] WeakMap Cache Invalidation |

---

## Detailed Bug Findings

### [BUG-01] Recurring Transfer to Off-Budget Account Crashes Auto-Posting and Breaks Budget Loading
- **Severity**: Critical *(confirmed; reproduced)*
- **Category**: Recurring / Database & API
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `normaliseInput()` (L146–147), `postRecurringTransaction()` (transfer branch L364–375)
  - Enforcement point: `packages/server/src/queries/transactions.ts` `createTransfer()` (throw at L380)
  - Trigger path: `apps/web/src/app/api/budget/route.ts` L12 (`autoPostDueRecurringTransactions(db)` runs on every budget fetch)
- **Description & Root Cause**:
  In `normaliseInput()` (`recurring.ts` L146–147), when a recurring rule is a transfer (`isTransfer` is true), the category is unconditionally forced to `null`:
  ```ts
  const effectiveCategoryId =
    isTransfer || isSplit ? null : (explicitCategoryId ?? null);
  ```
  Consequently, `recurring.categoryId` is stored as `NULL`, even when the transfer targets an off-budget account (e.g. monthly savings contributions to Wealthsimple TFSA, RRSP, or mortgage principal). This happens even when the caller *supplies* a category: the create schema (`apps/web/src/app/api/schemas.ts` `RecurringCreateSchema`) accepts `categoryId` alongside `transferAccountId`, and it is silently discarded. The type's JSDoc (`recurring.ts` L31–37) documents the null-forcing as intentional, but does not account for the off-budget-boundary case.
  
  When `postRecurringTransaction()` executes, it calls `createTransaction()` with `categoryId: r.categoryId` (which is `null`, L367) and `transferAccountId: r.transferAccountId`. `createTransaction()` delegates to `createTransfer()`, which detects the budget boundary crossing; for an outflow from an on-budget account to an off-budget account it strictly enforces that a category be provided:
  ```ts
  // Outflow from budget to off-budget (transactions.ts L377–381)
  if (baseInput.categoryId == null) {
    throw new TransactionError("Boundary transfer outflow requires a category", 400);
  }
  ```
  Verified empirically: posting throws exactly this error. Because `GET /api/budget` automatically triggers `autoPostDueRecurringTransactions(db)` on every request, any due recurring transfer to an off-budget account crashes the entire budget fetch endpoint with HTTP 500. The rule also wedges permanently: since the failure occurs before `nextDate` advances (`recurring.ts` L409–416 never executes), every subsequent request retries and re-fails on the same rule.
- **Reproduction / Scenario** *(empirically reproduced against an in-memory migrated DB)*:
  1. Create an off-budget investment account (e.g. "TFSA Investment").
  2. Create a recurring monthly transfer from "Chequing" to "TFSA Investment".
  3. Set `nextDate` to today or a past date.
  4. Reload the app or execute `GET /api/budget`. The request fails with HTTP 500.
- **Potential Impact**:
  Total application denial of service. The user cannot load the budget once a scheduled investment or mortgage transfer becomes due, and cannot fix it through the UI because rendering never completes.
- **Recommended Resolution**:
  Update `normaliseInput()` in `packages/server/src/queries/recurring.ts` to inspect whether `transferAccountId` represents an off-budget boundary crossing (via `isAccountOnBudget()`). If the source account is on-budget and the target is off-budget, preserve `explicitCategoryId` rather than forcing it to `null`; additionally validate at rule-creation time (422 if no category supplied for such rules) so failures cannot be deferred to auto-post time.

---

### [BUG-02] Recurring Split with Off-Budget Transfer Child Throws Uncaught Exception on Materialization
- **Severity**: Critical *(confirmed; reproduced)*
- **Category**: Splits & Transfers / Recurring
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `createRecurring()` (child insert at L200), `updateRecurring()` (child insert at L310); child validation `assertSplitsBalanced()` (L99–101)
  - Enforcement point: `packages/server/src/queries/transactions.ts` `createSplitWithChildren()` (throw at L498–501)
- **Description & Root Cause**:
  When inserting sub-transactions for a recurring split in `createRecurring()` and `updateRecurring()`, `categoryId` is forced to `null` whenever `transferAccountId` is present:
  ```ts
  const categoryId = transferAccountId ? null : (onBudget && c.categoryId ? Number(c.categoryId) : null);
  ```
  When a recurring split represents a paycheck with deductions (e.g. gross pay income, tax deduction, and a transfer deduction into an off-budget 401k/RRSP account), the transfer sub-transaction's category is saved as `NULL`.
  
  When `postRecurringTransaction()` materializes the recurring entry (children mapped at `recurring.ts` L388–394), each child whose `transferAccountId` crosses into an off-budget account hits, inside `createSplitWithChildren()`:
  ```ts
  if (categoryId == null) {
    throw new TransactionError("Boundary transfer outflow requires a category", 400);
  }
  ```
  Verified empirically: posting throws this error, aborting transaction posting and crashing `autoPostDueRecurringTransactions()`.
  
  **Additional constraint found during review**: even if persistence were fixed, `assertSplitsBalanced()` (`recurring.ts` L99–101) currently *rejects* any child carrying both a category and a transfer account:
  ```ts
  if (c.categoryId && c.transferAccountId) {
    throw new RecurringError(`sub-transaction ${i + 1} cannot have both a category and transfer account`);
  }
  ```
  A complete fix must relax this validation for boundary-crossing legs only, and update the recurring form UI, which presently hides category selection once a leg has a transfer target.
- **Reproduction / Scenario** *(empirically reproduced)*:
  1. Create an on-budget Chequing account and an off-budget Pension/RRSP account.
  2. Create a recurring split transaction on Chequing with a category expense child and an off-budget transfer child.
  3. Trigger "Enter Now" or let `nextDate` elapse.
  4. Posting fails with a 400/500 error.
- **Potential Impact**:
  Scheduled split transactions containing investment or debt transfer legs fail to auto-post and crash background queue execution.
- **Recommended Resolution**:
  In `createRecurring()` and `updateRecurring()`, do not force `categoryId` to `null` for transfer sub-transactions that cross into an off-budget account — allow `categoryId` to persist on `recurringSubTransactions` — and relax `assertSplitsBalanced()` accordingly.

---

### [BUG-03] Client-Side Reconcile Working Balance Double-Counts Split Parents and Omits Inbound Transfers
- **Severity**: Critical *(confirmed)*
- **Category**: Reconcile / UI & State
- **Location**:
  - **File**: `packages/ui/src/BudgetApp.tsx`
  - **Function / Component / Symbol**: `reconcileState` memo (L631–661; quoted block at L635–648)
  - Server reference implementation: `packages/server/src/queries/reconcile.ts` `getReconcileState()` (L63–110); 422 rejection at L133–139
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
  This implementation suffers from three critical flaws (which also corrupt the modal's `unclearedTotal` figure):
  1. **Double-counting split transactions**: `txns` includes both the split parent row (`parentId === null`, e.g., -$100) and the split child rows (`parentId !== null`, e.g., -$60 and -$40). Both are summed into `clearedSum`, doubling the split's balance impact (-$200 instead of -$100).
  2. **Omitting inbound transfers**: transfers are stored as a single row on the *source* account (`accountId = source, transferAccountId = dest`). Filtering only `t.accountId === acct.id` makes funds transferred *into* this account (`t.transferAccountId === acct.id`) invisible to the sum — there is no counterparty row to compensate.
  3. **Ignoring statement date boundary**: future-dated cleared transactions beyond the statement date are included.
  
  The server's `getReconcileState()` handles all three correctly: it selects rows where `account_id = X OR transfer_account_id = X`, negates amounts on counterparty rows (`case when account_id = X then amount else -amount end`), excludes split parents via `id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`, and filters `date <= statementDate`.
  
  Because the client computes an incorrect working balance, the `ReconcileModal` shows a false difference. If the user accepts or balances the modal and submits to `/api/reconcile`, the backend re-computes the true working balance via `getReconcileState()`. The backend detects a non-zero difference and, finding no adjustment category selected, rejects the request with HTTP 422: `"Statement balance does not match the working balance; provide an adjustment category to absorb the difference."` (`reconcile.ts` L135–138).
- **Reproduction / Scenario**:
  1. Have an account with at least one split transaction or one inbound transfer from another account.
  2. Click "Reconcile" on the account.
  3. Observe that the displayed "Working Balance" does not match the register balance or the actual sum of cleared transactions.
  4. Attempt to reconcile with the true statement balance; the modal submission fails with a 422 error.
- **Potential Impact**:
  Users cannot reconcile any account containing split transactions or inbound transfers.
- **Recommended Resolution**:
  Align `reconcileState` in `BudgetApp.tsx` with the server's `getReconcileState()` query:
  - Exclude split parent IDs (`splitParentIds`, derivable client-side from `parentId` links).
  - Include inbound transfers (`t.transferAccountId === acct.id`), negating `t.amount`.
  - Filter transactions by `t.date <= statementDate`.
  Alternatively, expose a `GET /api/reconcile?accountId=…` endpoint returning the server state and consume it in the modal.

---

### [BUG-04] `updateCategory` and `updateAccount` Throw "No values to set" on Empty Patch *(scope corrected)*
- **Severity**: High *(confirmed for two of the three originally reported functions)*
- **Category**: Database & API
- **Location**:
  - **Files**: `packages/server/src/queries/categories.ts` (`updateCategory`, L108–131; unprotected `db.update(...).set(p)` at L129), `packages/server/src/queries/accounts.ts` (`updateAccount`, L84–94; unprotected update at L92)
  - **NOT affected (correction)**: `packages/server/src/queries/transactions.ts` `updateTransaction()` — see below.
- **Description & Root Cause**:
  When these query functions receive an empty patch object (or fields that evaluate to `undefined`), the internal dictionary `p` remains `{}`. Unlike `updateCategoryGroup()` (`categories.ts` L96–99) and `updateRenameRule()` (`rename-rules.ts` L64), which explicitly guard:
  ```ts
  if (Object.keys(p).length === 0) return current;
  ```
  `updateCategory()` and `updateAccount()` directly execute:
  ```ts
  const [row] = await db.update(table).set(p).where(eq(table.id, id)).returning();
  ```
  Passing an empty object `{}` to Drizzle ORM's SQLite builder raises `Error: No values to set` (Drizzle refuses to compile `UPDATE <table> SET  WHERE id = ?`; verified empirically — the original report's raw `SqliteError: near "WHERE"` phrasing was approximate), resulting in an unhandled 500 error.
  
  **Correction**: `updateTransaction()` cannot reach its `db.update(transactions).set(p)` (transactions.ts L740) with an empty `p`. Its boundary/split/off-budget/income normalization chain (L685–738) writes at least `categoryId`/`isIncome`/`incomeMonth` into `p` on *every* code path, so `p` is never empty when the UPDATE executes. Additionally, `bulkUpdateTransactions()` already contains an explicit empty-set guard (`if (Object.keys(setFields).length > 0)`, transactions.ts L1302). Verified empirically: `updateTransaction(db, id, {})` completes without error. The safety here is incidental rather than guarded, but there is no runtime failure — the original report overstated the blast radius. The reproduction below remains valid because `CategoryPatchSchema` / `AccountPatchSchema` (`apps/web/src/app/api/schemas.ts` L104–112 / L69–77) accept a body containing only `id`.
  
  Note: while `updateTransaction` survives an empty patch, partial patches cause a worse problem via key-presence checks — see new finding [BUG-19].
- **Reproduction / Scenario** *(empirically reproduced)*:
  1. Send a request `PATCH /api/categories` with body `{"id": 10}` (or `PATCH /api/accounts` with `{"id": 3}`).
  2. Zod validation passes (only `id` required), `p` stays empty, and the server returns HTTP 500 with `No values to set`.
- **Potential Impact**:
  API requests sending no-op patches cause server 500 errors instead of cleanly returning the unchanged entity.
- **Recommended Resolution**:
  Add an early return guard in `updateCategory()` and `updateAccount()`, mirroring `updateCategoryGroup()`:
  ```ts
  if (Object.keys(p).length === 0) {
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return row ?? null;
  }
  ```

---

### [BUG-05] Unchecking Opening Carryover in Category Edit Modal Fails to Clear Carryover
- **Severity**: High *(confirmed)*
- **Category**: UI & State / Core Budget Engine
- **Location**:
  - **Files**: `packages/ui/src/Modals.tsx` (`CategoryModal` save handler, L858–863), `packages/server/src/queries/categories.ts` (`updateCategory`, carryover check at L124)
- **Description & Root Cause**:
  In `CategoryModal`, when a user unchecks "Set opening carryover balance" (`hasCarryover = false`), `onSave` evaluates (Modals.tsx L861):
  ```ts
  carryover: hasCarryover && evalAmount(carryover) != null ? Math.round((evalAmount(carryover) ?? 0) * 100) : undefined,
  ```
  `JSON.stringify` then drops the `undefined` key entirely, so the server never receives a `carryover` field. On the server, `updateCategory()` inspects:
  ```ts
  if (patch.carryover != null) p.carryover = assertValidAmount(patch.carryover);
  ```
  Because `patch.carryover` is `undefined`, `p.carryover` is omitted and the database column retains its previous non-zero carryover value. The user cannot reset an opening category balance back to zero. (Contrast with `goalTarget` on the adjacent line L860, which correctly sends an explicit `null` and *is* clearable — only carryover is affected.)
- **Reproduction / Scenario**:
  1. Create a category with a $50 opening carryover.
  2. Open the edit modal for the category and uncheck "Set opening carryover balance".
  3. Click "Save Changes".
  4. Inspect the budget or reload; the category still carries the $50 opening balance.
- **Potential Impact**:
  Category seed carryover balances cannot be removed or cleared through the UI once set; first-month envelope math stays permanently distorted by stale seed balances.
- **Recommended Resolution**:
  In `CategoryModal`, send an explicit `0` when unchecked (`… : 0`), which passes the server's `!= null` check and overwrites the column. Optionally also make `updateCategory` accept an explicit null/clear sentinel for API consumers. Related: any *partial* category PATCH silently destroys sibling fields — see [BUG-19b].

---

### [BUG-06] Permanent Schedule Drift in `nextDateFor()` After February or Short Months
- **Severity**: High *(confirmed; reproduced)*
- **Category**: Recurring / Core Domain Math
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `nextDateFor()` (L354–452; monthly branch L441–449; semimonthly branch L369–384)
  - Feedback loop: `packages/server/src/queries/recurring.ts` `postRecurringTransaction()` L411 feeds each output back in as the next input
- **Description & Root Cause**:
  `nextDateFor()` advances an ISO date string without storing or referencing the original recurring rule anchor day; every month-based branch derives `originalDay` from the previous output string.
  1. **Monthly clamping drift** *(empirically reproduced)*: `2026-01-31 → 2026-02-28 → 2026-03-28 → 2026-04-28`. Once February clamps the 31st down to the 28th, `originalDay` reads 28 forever and every subsequent month lands on the 28th.
  2. **Semimonthly drift** *(empirically reproduced)*: starting from `2026-01-28`: `→ 2026-02-13 → 2026-02-28 → 2026-03-13 → 2026-03-28`. The short-month clamp permanently shifts the schedule to the 13th/28th pair.
  3. The same anchor-less pattern applies to the `everyothermonth`, `every3months`/`quarterly`, `every4months`, `twiceayear`, and `every2years` branches (L388–431): any clamped occurrence permanently rewrites the day-of-month.
- **Reproduction / Scenario** *(empirically reproduced)*:
  1. Create a monthly recurring transaction on `2026-01-31`.
  2. Post occurrences through April 2026.
  3. Observe that the March and April occurrences are scheduled for March 28 and April 28 instead of March 31 and April 30.
- **Potential Impact**:
  Recurring bills and paychecks scheduled for month-end or semimonthly intervals drift to incorrect calendar days and never recover.
- **Recommended Resolution**:
  Store an immutable `anchorDay` (or anchor ISO date) on the `recurring` row at creation and pass it into `nextDateFor()` so monthly calculations clamp against the anchor rather than the previous output string. A pure-logic alternative is advancing on a "virtual" unclamped date (year/month arithmetic only) and clamping only for display/storage.

---

### [BUG-07] Budget Engine Does Not Distinguish Between Cash Overspending and Credit Card Debt Overspending
- **Severity**: High *(confirmed)*
- **Category**: Core Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildRawIndex()` (categorised CC spend into `spendByAccountMonth` at L248–255; card payments at L257–270), `buildCarryoverMap()` (clamping + `monthOverspent` at L566–586), `computePriorTBBSurplus()` (overspent deducted from TBB at L692–700)
- **Description & Root Cause**:
  In YNAB4's envelope model, overspending behaves differently depending on whether it was incurred on Cash/Checking (Cash Overspending) or a Credit Card (Credit Card Overspending):
  - **Cash Overspending**: Deducted from next month's To Be Budgeted (TBB) and clamped to 0 in the category.
  - **Credit Card Overspending**: Adds to the debt on the Credit Card account, does *not* move cash into the CC Payment buffer beyond what was funded, does *not* deduct from next month's TBB, and category balance resets to 0.
  
  In `budget-engine.ts`, when spending occurs on a Credit Card in an unfunded category (e.g. $100 charged to AMEX in Groceries with $0 budgeted):
  1. `buildRawIndex` transfers the full +$100 into the AMEX CC Payment buffer (`spendByAccountMonth`, L248–255).
  2. In `buildCarryoverMap`, Groceries' available balance (-$100) is clamped to 0 and added to `monthOverspent` (L572–580).
  3. `computePriorTBBSurplus` deducts that overspend from next month's cash TBB (L697) while the AMEX CC Payment category retains +$100 of phantom backed funds.
  
  This double-penalizes cash TBB while creating phantom funds in the Credit Card Payment category for debt that was never backed by cash. (The engine does honour the per-category "Red Arrow" `overspendCarriesOver` escape hatch for non-CC categories at L570–583, but CC overspending itself has no equivalent treatment.)
- **Reproduction / Scenario**:
  1. Start with $0 TBB and $0 assigned in all categories.
  2. Charge a $100 transaction on a Credit Card categorized to "Groceries".
  3. In the current month, the CC Payment category shows $100 Available to pay the card, despite no cash existing to back it.
  4. In the next month, TBB becomes -$100 (cash-overspending deduction), while CC Payment still holds $100.
- **Potential Impact**:
  Severe divergence from YNAB4 credit card accounting principles; artificial inflation of credit card payment available balances and incorrect cash TBB deductions.
- **Recommended Resolution**:
  In `buildRawIndex()` and `buildCarryoverMap()`, calculate credit card buffer transfers based on the *funded* portion of category spending: limit the buffer credit to the available cash, record the unfunded remainder as credit card debt (negative CC Payment available), and exclude it from `monthOverspent` so cash TBB is not deducted.

---

### [BUG-08] `deleteAccount` Bypasses Reconciled Transaction Lock for Own Transactions
- **Severity**: Medium *(confirmed)*
- **Category**: Register & Balance / Reconcile
- **Location**:
  - **File**: `packages/server/src/queries/accounts.ts`
  - **Function / Component / Symbol**: `deleteAccount()` (L105–253; reconciled guard covers only counterparty rows at L131–136 plus their split parents at L140–149/L174–179; cascade delete at L245)
- **Description & Root Cause**:
  `deleteAccount()` checks whether any counterparty transactions (`transferAccountId = id`, i.e. rows living on *other* accounts) are reconciled (`status === 'r'`) and throws a 422 error if so. However, it does not inspect transactions residing directly on the account being deleted (`accountId = id`).
  When `db.delete(accounts).where(eq(accounts.id, id))` executes (L245, commented *"SQLite cascade handles own transactions/recurring"*), the `ON DELETE CASCADE` foreign key rule deletes all transactions on that account — including reconciled ones — bypassing the reconciliation lock. Step 2 (L213–235) even reverses counterparty balance effects for the account's own transfers without checking their status first.
- **Reproduction / Scenario**:
  1. Reconcile an account with 50 cleared transactions (all become `status = 'r'`).
  2. Delete the account.
  3. The account and all 50 reconciled transactions are deleted without error.
- **Potential Impact**:
  Locked audit history and historical financial records can be destroyed without warning or un-reconciling.
- **Recommended Resolution**:
  In `deleteAccount()`, before mutating anything, query `transactions` where `accountId = id and status = 'r'`. If any exist, throw an `AccountError("Account contains reconciled transactions. Unreconcile before deleting.", 422)`.

---

### [BUG-09] `fmt()` Formats Small Negative Cents as Negative Zero (`-$0.00`)
- **Severity**: Medium *(confirmed; scope extended)*
- **Category**: Register & Balance / UI Formatting
- **Location**:
  - **File**: `packages/logic/src/format.ts` — `fmt()` (L31–38), `fmtSigned()` (L40–43)
  - **Additional location found in review**: `packages/theme/src/primitives.tsx` — `money()` (L16–23) uses the same sign test (`n < 0 ? "-" : ""`) and produces the identical artefact across every UI surface that formats currency via `@ynab/theme` (Inspector, TransactionsView totals, Sidebar, reports).
- **Description & Root Cause**:
  In `fmt(cents: number)`:
  ```ts
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cents < 0 ? "-$" : "$") + s;
  ```
  If `cents` is a negative number between `-0.49` and `-0.01` (e.g. from fractional math such as division-based averages or floating point calculation before rounding), `abs` formats to `"0.00"`, but `cents < 0` evaluates to `true`, returning `-$0.00`. Verified: `fmt(-0.2)` and `fmtSigned(-0.01)` both return `-$0.00`. Under normal operation amounts are integer cents, so exposure is limited to computed/fractional inputs — but these are the app's universal currency printers and should be defensively correct.
- **Reproduction / Scenario** *(empirically reproduced)*:
  1. Call `fmt(-0.2)` or `fmtSigned(-0.01)`.
  2. Output is `-$0.00`.
- **Potential Impact**:
  Confusing visual glitch where zero balances display with a negative sign.
- **Recommended Resolution**:
  Round `cents` to an integer before checking the sign (apply to both formatters):
  ```ts
  const rounded = Math.round(cents);
  if (rounded === 0) return "$0.00";
  const abs = Math.abs(rounded) / 100;
  return (rounded < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ```

---

### [BUG-10] Calendar View Net Month and Day Net Treat Internal Transfers as Cash Losses
- **Severity**: Medium *(confirmed)*
- **Category**: Reports & Analytics / UI & State
- **Location**:
  - **File**: `packages/ui/src/CalendarView.tsx`
  - **Function / Component / Symbol**: `CalendarView` — `monthTotal` (L56–58), per-day aggregation `byDay` (L38–49) feeding day badges via `dayNet` (L120)
- **Description & Root Cause**:
  `CalendarView` calculates `monthTotal` and day totals by summing `t.amount` for all non-split-parent transactions:
  ```ts
  const monthTotal = data.transactions
    .filter((t) => t.parentId == null && t.date.startsWith(month))
    .reduce((s, t) => s + num(t.amount), 0);
  ```
  For transfers between two on-budget accounts (e.g. $500 from Checking to Savings, stored as a single row `amount: -50000, transferAccountId: 2`), that one row contributes `-$500` to the month's net total and the source day's badge, falsely displaying a cash deficit on a pure asset transfer. The destination side gets no compensating entry because counterparty rows do not exist in this single-row transfer model.
- **Reproduction / Scenario**:
  1. Create an on-budget transfer of $1,000 between Checking and Savings.
  2. Switch to Calendar View.
  3. Observe that "Net this month" is reduced by $1,000 and the day cell shows a -$1,000 pill.
- **Potential Impact**:
  Misleading cash flow totals in the calendar view for users who perform routine account transfers. Note: `computeCashFlow()` in `packages/logic/src/reports.ts` (L206–213) already implements the correct on-budget netting pattern — reuse it here instead of raw summation.
- **Recommended Resolution**:
  In `CalendarView.tsx`, identify internal on-budget transfers (`t.transferAccountId != null` where both source and destination accounts are on-budget, using a `data.accounts` lookup) and exclude them from `monthTotal` and day net totals.

---

### [BUG-11] Inspector Expenses Display Double-Minus `--$X.XX` on Net Category Refunds
- **Severity**: Medium *(confirmed)*
- **Category**: Reports & Analytics / UI & State
- **Location**:
  - **Files**: `packages/ui/src/Inspector.tsx` — Net Monthly panel outflow line (L282–287; hardcoded dash at L285); formatter `money()` from `@ynab/theme` (`primitives.tsx` L16–23)
  - Enabling condition: `computeCashFlow()` in `packages/logic/src/reports.ts` (L218–220) accumulates refunds negatively (`outflow -= netOnBudgetDelta`), so `outflow` genuinely can fall below zero when the `cashFlow` prop is supplied
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
  Render the sign conditionally: `effectiveCashFlow.outflow >= 0 ? \`-${money(...)}\` : \`+${money(Math.abs(...))}\``.

---

### [BUG-12] Disconnected / Dead Function in `budget-engine.ts`
- **Severity**: Medium *(confirmed)*
- **Category**: Code Quality / Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `computeOverspentForMonth()` (L606–653)
  - Export surface: `packages/logic/src/index.ts` (L7–12) exports only `computeBudget`, `buildBudgetIndex`, `isIncomeTransaction`, `getMonthsWithData`
- **Description & Root Cause**:
  `computeOverspentForMonth()` was implemented (budget-engine.ts L606) to compute overspending for a single month with memoization into `index.overspentByMonth`, but it is not called by any function in `budget-engine.ts`, nor is it exported in `packages/logic/src/index.ts`. All overspent computation is instead performed inline in `buildCarryoverMap()` (L551–593), duplicating the same non-CC/clamp/"Red Arrow" rules that must now be kept in sync manually across two implementations.
- **Potential Impact**:
  Dead code maintenance hazard and confusion regarding where overspending calculations occur.
- **Recommended Resolution**:
  Either export and reuse `computeOverspentForMonth()` to DRY up overspent calculation or remove the unused function.

---

### [BUG-13] CSV Importer Rejects Standard Text Month Dates (e.g., "15-Aug-2026", "Aug 15, 2026")
- **Severity**: Low *(confirmed)*
- **Category**: CSV & Import
- **Location**:
  - **File**: `packages/logic/src/csv-import.ts`
  - **Function / Component / Symbol**: `parseDate()` (L125–141); `detectDateFormat()` (L103–123) likewise only votes on purely numeric patterns
- **Description & Root Cause**:
  `parseDate()` only parses dates conforming to purely numeric regular expressions (`/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/` and `/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/`). CSV bank statements using English three-letter month abbreviations (e.g., `15-AUG-2026`, `Aug 15 2026`) fail parsing, return `null`, and are rejected as `"Invalid date"` (row error at L235).
- **Reproduction / Scenario**:
  1. Import a CSV file with date column `15-Aug-2026`.
  2. The preview displays "Invalid date" on every row and disables the import button.
- **Potential Impact**:
  Inability to import bank exports from financial institutions that format dates with text month abbreviations.
- **Recommended Resolution**:
  Add support for 3-letter month abbreviations (`Jan`, `Feb`, `Mar`, etc.) in `parseDate()` before rejecting the string, mapping through the existing `MONTHS` table in `format.ts` and honouring the resolved dmy/mdy convention.

---

### [BUG-14] `evalAmount` Indiscriminately Strips Decimal Commas
- **Severity**: Low *(confirmed)*
- **Category**: Core Domain Math / Format
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `evalAmount()` (comma stripping at L106; the `_VALID` charset at L99 excludes commas from expressions entirely)
- **Description & Root Cause**:
  `evalAmount()` strips commas via `raw.replace(/[$,_]/g, "")`. For users entering amounts with European decimal commas (e.g., `12,50`), the string becomes `1250` ($12.50 becomes $1,250.00). (The same stripping occurs in `num()` at L70, though there inputs are already cent-denominated integers so comma-as-thousands is the expected reading.)
- **Reproduction / Scenario**:
  1. Type `12,50` into an amount input field wired to `evalAmount` (`AmountInput.tsx`).
  2. The input evaluates to $1,250.00 instead of $12.50.
- **Potential Impact**:
  Accidental 100x multiplication of financial amounts for European-format user input.
- **Recommended Resolution**:
  In `evalAmount()`, if a comma is followed by exactly two digits at the end of the expression/token (e.g. `,50`), treat it as a decimal separator (`.50`) rather than stripping it; otherwise continue treating commas as thousands separators.

---

### [BUG-15] Calendar View Day Click Prevents Adding Transactions on Populated Days
- **Severity**: Low *(confirmed)*
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/CalendarView.tsx`
  - **Function / Component / Symbol**: `CalendarView` day cell `onClick` handler (L134–138)
- **Description & Root Cause**:
  The `onClick` handler for day cells in `CalendarView` checks:
  ```ts
  if (items.length === 0) onAdd(dateIso(d));
  else setExpandedDay(expanded ? null : d);
  ```
  Once a day has even one transaction, clicking anywhere on that day cell toggles row expansion rather than opening the "Add Transaction" modal. Users cannot use the calendar to add transactions to dates that already have activity. The empty-state banner (L103: *"Click any day to add a transaction"*) actively misleads once days are populated.
- **Reproduction / Scenario**:
  1. Navigate to Calendar View.
  2. Click a date that already has a transaction.
  3. The day expands/collapses instead of opening the Add Transaction modal.
- **Potential Impact**:
  Impaired workflow when adding multiple transactions on the same date from the Calendar view.
- **Recommended Resolution**:
  Add an explicit "+" button inside the day cell header (next to the day number) that calls `onAdd(dateIso(d))` regardless of existing items (with `stopPropagation`).

---

### [BUG-16] Projections View Uses Current Live Balance Even When Viewing Historical Months
- **Severity**: Code Quality / UI Inconsistency *(confirmed)*
- **Location**:
  - **File**: `packages/ui/src/ProjectionsView.tsx`
  - **Function / Component / Symbol**: `ProjectionsView` — `liquidNow` from live balances (L19–21), forecast labels anchored to the view month via `parseMonthKey(month)` (L17) and the point loop (L32–42)
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
- **Severity**: Code Quality / UX Flaw *(confirmed)*
- **Category**: UI & State
- **Location**:
  - **File**: `packages/ui/src/BulkEditModal.tsx`
  - **Function / Component / Symbol**: `BulkEditTransactionsModal` — `hasReconciled` (L85–88), `isValid` (L100–109; no reconciled check), `handleSave` (L123–152; sends all IDs), "Review Changes" button gated only by `!isValid` (L188); warning banner at L332–334
  - Caller passes the full ID list through unfiltered: `packages/ui/src/BudgetApp.tsx` L937–939
- **Description & Root Cause**:
  `BulkEditTransactionsModal` displays a warning notice when `hasReconciled` is true ("One or more selected transactions are reconciled and locked…"), but it does not disable the submit button or exclude reconciled transaction IDs from the payload. When the user confirms, the backend throws on the first reconciled row inside `bulkUpdateTransactions()` (`transactions.ts` L1151–1156) and rolls back the entire batch, creating a failed mutation toast.
- **Potential Impact**:
  Frustrating user experience when trying to bulk-edit mixed selections of cleared and reconciled transactions; the whole batch fails rather than partially succeeding.
- **Recommended Resolution**:
  Either automatically filter out reconciled transactions (`status === "r"`) from the update payload with a notice ("X reconciled transactions will be skipped"), or disable the "Review Changes"/confirm buttons when all selected transactions are reconciled.

---

### [BUG-18] Pre-Indexed Cache in `budget-engine.ts` Not Invalidated on In-Place Data Mutation
- **Severity**: Code Quality / Cache Invalidation *(confirmed)*
- **Category**: Core Budget Engine
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `budgetDataIndexCache` (WeakMap at L128), `getOrBuildIndex()` (L339–356)
- **Description & Root Cause**:
  `budgetDataIndexCache` stores indexed budget computations in a `WeakMap<BudgetData, IndexedBudgetData>` keyed on object identity (including hydrated `data.budgetIndex` snapshots). If a consumer modifies properties or arrays on an existing `BudgetData` object reference without constructing a new object identity, `getOrBuildIndex()` returns the stale cached index. While `BudgetAppShell` creates new object references on state updates (and clears `budgetIndex` optimistically), direct consumers of `@ynab/logic` risk silent calculation errors if objects are reused. Note also that `buildBudgetIndex()` (L285) bypasses the cache entirely and always rebuilds from scratch.
- **Potential Impact**:
  Stale cache reads if budget data is mutated in-place by external tools or unit tests.
- **Recommended Resolution**:
  Provide an explicit cache invalidation helper `invalidateBudgetIndex(data: BudgetData)` or attach the index directly to `data.budgetIndex`.

---

### [BUG-19] API Routes Reconstruct Patches With All Keys Present, So `"key" in patch` Checks Treat Omitted Fields as Explicit Nulls *(new finding; empirically verified)*
- **Severity**: Critical — silent, irreversible data loss triggered by routine actions
- **Category**: Database & API / Data Integrity
- **Location**:
  - Route layer (constructs full-key patch objects):
    - `apps/web/src/app/api/transactions/route.ts` PATCH handler (L204–214)
    - `apps/web/src/app/api/categories/route.ts` PATCH handler (L76–82)
    - `apps/web/src/app/api/recurring/route.ts` PATCH handler (L186–203) and bulk-update branch (L167–171)
  - Query layer (key-presence checks that misfire):
    - `updateTransaction()` — `if ("categoryId" in patch)` at transactions.ts L613–615; `if ("incomeMonth" in patch)` at L626
    - `updateCategory()` — `if ("goalTarget" in patch)` at categories.ts L121–123; `if ("overspendCarriesOver" in patch)` at L126–128
    - `updateRecurring()` — `if ("categoryId" in patch) p.categoryId = norm.effectiveCategoryId` at recurring.ts L271 (with `normaliseInput` coercing the undefined to `null`)
  - UI triggers:
    - Status toggle & flag setter send single-field patches: `packages/ui/src/BudgetApp.tsx` `cycleStatus` (L544–552) and `setFlag` (L554–559)
    - Category drag-reorder sends `{ id, sort }`: `apps/web/src/components/BudgetAppShell.tsx` `reorderCategory` (L543–551); invoked from drag-drop in `packages/ui/src/BudgetView.tsx` (L566–574)
    - Recurring flag/active toggles and bulk-update: `BudgetAppShell.tsx` `updateRecurring` (L346–388) / `bulkUpdateRecurring` (L431–441), wired at `packages/ui/src/BudgetApp.tsx` L776/L812/L778
- **Description & Root Cause**:
  The client correctly serializes partial patches (`JSON.stringify({ id, ...t })` drops keys whose value is `undefined`, and Zod leaves absent keys absent from `body`). However, each route handler then rebuilds the patch as an **object literal containing every key**, with explicit `undefined` values for fields the caller omitted. At runtime, `{ categoryId: undefined }` *has* the key `categoryId`, so every `"categoryId" in patch` presence check in the query layer evaluates true and writes `patch.categoryId ?? null` — i.e. `NULL` — into the database. Verified empirically against an in-memory migrated database:
  
  a) **Transactions — status toggle or flag change erases the category.** Sending the route-shaped patch `{ accountId: undefined, categoryId: undefined, …, status: "c", … }` for a transaction categorized to Groceries returned `categoryId: null`. Consequences: clicking the cleared/uncleared marker or applying any flag in the register silently uncategorizes the transaction in the DB (the optimistic UI hides it because status-only updates don't trigger a reload; the loss surfaces on next full reload). For positive-amount rows this also flips them to TBB income; for deferred income rows, `incomeMonth` is likewise nulled (deferral lost).
  
  b) **Categories — reordering wipes goals and Red Arrow settings.** The rename-only/sort-only route shape `{ name: "Renamed", goalTarget: undefined, carryover: undefined, sort: undefined, overspendCarriesOver: undefined }` persisted `goalTarget: null` and `overspendCarriesOver: false`. Every drag-reorder of a category (`{ id, sort }`) therefore destroys its funding goal target and resets its overspend-carryover preference. (The full `CategoryModal` save path is safe only because it happens to send every field.)
  
  c) **Recurring rules — flag/active toggles erase the category.** A flag-only patch (`{ flagColor: "red" }`, route-shaped with all keys present) persisted `categoryId: null`. The same applies to the active-toggle flow and to the `bulk-update` action, which passes `{ flagColor, active, categoryId }` with all keys present for every selected ID.
  
  Note the contrast: `bulkUpdateTransactions()` receives its patch straight from Zod (keys genuinely absent) and is unaffected; `updateAccount()` uses only `!= null` checks and is also safe. The bug is specifically the mismatch between route reconstruction and presence-based checks.
- **Reproduction / Scenario** *(all reproduced in tests)*:
  1. Categorize any expense; click its status marker in the register (or set a flag). Reload later — the category is gone from the transaction and its amount has leaked back into the envelope/TBB math.
  2. Set a funding goal on a category, then drag to reorder it. Reload — goal target is null and "Red Arrow" is off.
  3. Flag a categorized recurring rule (or bulk-toggle active on several). Reload — their categories are null.
- **Potential Impact**:
  Continuous, invisible corruption of the core financial dataset during normal use; envelope balances, TBB, income classification, and funding goals all drift from reality without any error surfaced.
- **Recommended Resolution**:
  Fix at one layer, consistently:
  - Preferred: routes should forward only the fields actually present, e.g. build the patch via conditional spreads (`...(body.categoryId !== undefined && { categoryId: body.categoryId })`) or pass `body` directly where schemas already align.
  - Alternatively: convert the query layer's `"key" in patch` checks to `!= null`/`!== undefined` semantics matching what routes send.
  Then add regression tests asserting that single-field PATCHes leave sibling columns untouched (the current suite exercises full-field patches only, which is why this went undetected).

---

### [BUG-20] Transfers Originating From a Credit Card Are Invisible to the CC Payment Buffer *(new finding)*
- **Severity**: Medium
- **Category**: Core Budget Engine / Credit Card Accounting
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildRawIndex()` transfer-payment rule (L257–270)
- **Description & Root Cause**:
  Rule 2 of `buildRawIndex()` adjusts the CC payment buffer via `receiving = amt < 0 ? t.transferAccountId : t.accountId`. This handles Checking→Card payments correctly (buffer decreases by the payment). But when the credit card is the *source* of an on-budget transfer (cash advance / balance transfer to checking: row stored on the card, `amount = -50000`, `transferAccountId = checking`), `receiving` resolves to the checking account, so the buffer entry is keyed under an account no CC category looks up. Net effect: card debt increases by $500 and checking's liquid balance rises by $500, yet no envelope is reduced, no TBB changes, and the CC Payment category's "Available to pay" does not reflect the new debt — understating the payoff requirement until the cash is separately spent.
- **Reproduction / Scenario**:
  1. Hold a balance on an on-budget credit card with a corresponding CC Payment buffer.
  2. Record a transfer from the card to checking (e.g. $500 cash advance).
  3. Observe: card debt grows by $500, checking grows by $500, but CC Payment "Available" is unchanged and no budget figure moves.
- **Potential Impact**:
  Silent divergence between account balances and envelope accounting; the headline "pay the card" figure under-reports what is owed after card-originated transfers.
- **Recommended Resolution**:
  In the transfer rule, treat transfers where the linked credit card is the source as debt-increasing: key the +amount into that card's buffer entry (mirroring a categorized charge) rather than keying the receiving side, or block/redirect card→on-budget transfers at the API layer pending proper categorization support.

---

## Production Readiness Assessment & Next Steps

### Summary Assessment
The application core has a robust foundation:
- Clean monorepo architecture separating pure logic (`@ynab/logic`), persistence (`@ynab/server`), design system (`@ynab/theme`), and presentation (`@ynab/ui`).
- Integer cent representation across database schema and logic prevents binary floating-point drift.
- Atomic SQL write transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) guard against partial database corruption on multi-table writes.
- High-fidelity visual styling faithful to YNAB4's original design language.
- The reconciliation engine (`getReconcileState`/`reconcileAccount`/`unreconcileAccount`) is correctly specified server-side, including counterparty row negation and split-parent exclusion.

However, **the application is not yet ready for production deployment with real financial data** until the Critical and High severity bugs are resolved. The newly verified [BUG-19] is arguably the most dangerous of all: it silently corrupts categories, income deferrals, funding goals, and recurring rules during completely ordinary interactions (status clicks, flagging, drag-reordering), with no error shown. Combined with the recurring auto-post crash ([BUG-01]/[BUG-02]) that takes down `GET /api/budget`, and the client-side reconciliation failure on any account with splits ([BUG-03]), the app would both corrupt and strand real financial data in normal use.

A process gap worth noting: the existing test suite passes full-field patches only, which is exactly why the [BUG-19] class of key-presence bugs went undetected. Regression tests should assert that single-field PATCHes leave sibling columns untouched.

### Recommended Remediation Priority:
1. **Fix Route Patch Reconstruction ([BUG-19])** — stop silent data loss first: forward only present fields from routes (or align query-layer checks to `!= null`), then add partial-patch regression tests for transactions, categories, and recurring rules.
2. **Fix Recurring Boundary Transfers ([BUG-01], [BUG-02])**: Allow `categoryId` on recurring transfers and recurring split transfer legs that cross into off-budget accounts; relax `assertSplitsBalanced()` accordingly and validate at rule-creation time.
3. **Fix Client Reconciliation State ([BUG-03])**: Correct `reconcileState` in `BudgetApp.tsx` to include inbound transfers, exclude split parents, and respect statement dates.
4. **Guard Empty Database Updates ([BUG-04])**: Add empty-patch guards to `updateCategory()` and `updateAccount()`.
5. **Fix Category Carryover Clearing ([BUG-05])**: Ensure `CategoryModal` sends `0` instead of `undefined` when opening carryover is unchecked.
6. **Fix Frequency Clamping Math ([BUG-06])**: Anchor monthly and semimonthly date calculations to an immutable day-of-month anchor stored on the `recurring` row.
7. **Separate CC Overspending from Cash TBB ([BUG-07])** and account for card-originating transfers ([BUG-20]): Align credit card overspending/debt mechanics with YNAB4 to prevent phantom cash buffers and understated payoff figures.
