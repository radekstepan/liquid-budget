# Codebase Review & Bug Audit Prompt

You are an expert Principal Software Engineer and Financial Systems Architect performing a rigorous, comprehensive code review and bug audit of this codebase.

Your mission is to perform an exhaustive, end-to-end audit of the entire repository to find **all bugs, glitches, accounting flaws, edge-case failures, calculation errors, data integrity risks, and state inconsistencies**—with special focus on the **core budgeting and financial logic**.

The target deployment target is a **production-grade local single-user application** (running locally on SQLite with Next.js/React). You must evaluate the app for bulletproof reliability, financial correctness, and rock-solid stability for a single user. (You can skip multi-tenant authentication, CSRF tokens, rate limiting, and multi-user concurrency).

> **CRITICAL INSTRUCTION**: **DO NOT MODIFY OR FIX ANY SOURCE CODE FILES.**
> Your sole output is to produce a comprehensive report saved as **`bugs.md`** in the repository root.

---

## 1. Codebase Architecture & Domain Overview

This project is a high-fidelity web-based alternative to **YNAB4 (You Need A Budget 4)** built as a TypeScript monorepo (`yarn` + `turbo`):

- **`packages/logic`**: Pure TypeScript domain logic (no React, no DB). Contains:
  - `budget-engine.ts`: Envelope budgeting calculations (To Be Budgeted / TBB, cumulative category carryovers, cash vs credit card overspending, "Red Arrow to the Right", credit card payment buffers, deferred income).
  - `register.ts`: Running balance calculations for registers (single account and All Transactions views, transfer reflections, split clusters).
  - `recurring.ts`: Recurring transaction intervals, frequency math, month-end clamping, liquid flow calculations, schedule projections.
  - `split.ts`: Split transaction balancing, validation, parent-child relations.
  - `reports.ts`: Net worth history back-calculation from current balances and lifetime deltas, cash flow, spending trends multi-level drilldown.
  - `duplicates.ts`: Duplicate detection fingerprints and grouping.
  - `rename-rules.ts`: Payee pattern matching (`[N]` wildcard) and automated rule inference.
  - `csv-import.ts`: CSV parsing, date format detection (DMY vs MDY), amount normalization.
  - `format.ts`: Currency formatting (`fmt`), integer cent coercion (`num`, `dollarsToCents`), inline math expression evaluation (`evalAmount`), date shortcuts.

- **`packages/server`**: Backend persistence and business operations using SQLite (`better-sqlite3`) & Drizzle ORM:
  - `schema.ts`: Database schema (`accounts`, `categoryGroups`, `categories`, `assignments`, `transactions`, `reconciliations`, `recurring`, `recurringSubTransactions`, `renameRules`). Monies are stored as integer **cents**.
  - `queries/`: CRUD operations and transactional queries (`transactions.ts`, `accounts.ts`, `categories.ts`, `assignments.ts`, `reconcile.ts`, `recurring.ts`, `diagnostics.ts`, `duplicates.ts`, `rename-rules.ts`, `budget.ts`).
  - `import-ynab4.ts` & `export-ynab4.ts`: YNAB4 `.ynab4` zip and JSON import/export roundtrip.
  - `import-csv.ts`: Transaction CSV ingestion with duplicate skipping and auto-rename rules.

- **`packages/ui`**: React component library:
  - `BudgetApp.tsx`: Central coordinator managing views, modals, optimistic state, and deep linking.
  - `BudgetView.tsx`, `TransactionsView.tsx`, `RecurringView.tsx`, `ReportsView.tsx`, `CalendarView.tsx`, `ProjectionsView.tsx`, `SettingsView.tsx`.
  - `Modals.tsx`, `BulkEditModal.tsx`, `CsvImportModal.tsx`, `ReconcileModal.tsx`, `Inspector.tsx`, `Sidebar.tsx`.

- **`apps/web`**: Next.js App Router host application:
  - `src/components/BudgetAppShell.tsx`: Client-side data provider, optimistic mutation manager, toast notifications, API coordinator.
  - `src/app/api/`: REST API endpoints and Zod schemas (`schemas.ts`).

---

## 2. In-Depth Audit Checklist

Thoroughly inspect every subsystem, tracing execution paths between UI, Logic, Server, and DB layers:

### A. Core Budget Engine & Envelope Calculations (`packages/logic/src/budget-engine.ts`)
- **TBB Invariant**: Does `TBB = Total Income - Total Assigned + Prior Surplus - Prior Overspent` strictly hold across all month transitions?
- **Cumulative Carryovers**:
  - Is `available(N) = available(N-1) + assigned(N) + outflow(N) + ccBuffer(N)` computed accurately?
  - Initial seed carryover (`category.carryover`) vs dynamic rolling balances.
  - Non-contiguous months: What happens if there are months with no transactions or assignments (gaps in history)?
- **Cash Overspending vs "Red Arrow to the Right" (`overspendCarriesOver`)**:
  - Default behavior: Is negative available balance in non-CC categories clamped to 0 in carryover and accurately deducted from next month's TBB?
  - Red Arrow enabled: Does negative available roll over into the category's next-month starting balance *without* deducting from next month's TBB?
  - CC Payment categories: Do negative balances persist as debt without clamping and without deducting from cash TBB?
- **Credit Card Buffer Logic**:
  - Does spending on a credit card account accurately transfer money into the linked CC Payment category?
  - Does a refund/return on a credit card account draw down the CC buffer properly?
  - Are credit card payments (transfers from checking to credit card) correctly isolated from budget category outflows while drawing down CC payment category available balances?
  - Mixed scenarios: What happens if a credit card has no linked CC category, or is an off-budget account?
- **Income Classification & Boundary Crossings (`isIncomeTransaction`)**:
  - Direct income to on-budget accounts (`categoryId === null`, `amount > 0`).
  - Deferred income (`incomeMonth` set to a future or specific month).
  - Boundary transfers (between on-budget and off-budget accounts):
    - Off-budget to on-budget: Treated as income if no category, or category inflow if category is set.
    - On-budget to off-budget: Treated as outflow requiring a budget category.
    - On-budget to on-budget: Pure transfer (zero net budget impact, not income).
  - Split transaction income: Are split children with income properly aggregated without double-counting parent rows?
- **Indexing & Memoization Cache**:
  - Are WeakMaps or cached indexes in `buildRawIndex`, `buildBudgetIndex`, and `getOrBuildIndex` safely invalidated when data changes?
  - Is there any risk of stale cache reads or memory leaks?

### B. Register, Accounts & Balance Integrity
- **Running Balance Calculations (`packages/logic/src/register.ts`)**:
  - Date-descending walk anchored at account balance: Does it correctly handle same-day transactions, secondary sorting by ID, and date edits?
  - Anchor account view vs "All Transactions" view.
  - Transfers: Does the destination side reverse the signed delta?
  - Split Clusters: Does the split parent row properly reflect the cluster's newest balance while child rows reflect their individual steps?
- **Account Balance Tracking (`packages/server/src/queries/accounts.ts`, `transactions.ts`)**:
  - Do `account.balance` values remain perfectly in sync with the sum of active transactions (`verifyBalanceIntegrity`)?
  - Starting balances: Is starting balance creation atomic with account creation?
  - Account deletion: Does deleting an account clean up counterparty transfer rows and reverse balances on counterparties without leaving orphan half-transfers or corrupting split parents?
  - Archived accounts: Are archived accounts properly filtered from dropdowns/views while preserving historical reports and balances?

### C. Split & Transfer Integrity (`packages/logic/src/split.ts`, `packages/server/src/queries/transactions.ts`)
- **Split Invariants**:
  - `sum(children.amount) === parent.amount`: Is this enforced for both positive, negative, and mixed-sign splits (e.g. Paycheck with 401k/tax deductions)?
  - Are split parents completely excluded from balance sums, category outflows, and duplicate checks?
  - Can a split child be a transfer to another account? Is the transfer balance applied to both accounts?
  - Editing/deleting split children: Does editing a child update the parent amount or validate balanced splits? Does deleting a child leave an unbalanced parent?
  - Full-replace splits (`updateSplit`): Are old child balances cleanly reversed before new child balances are applied?

### D. Recurring Transactions & Scheduling (`packages/logic/src/recurring.ts`, `packages/server/src/queries/recurring.ts`)
- **Interval Mathematics & Date Math (`nextDateFor`, `nextMonthKey`)**:
  - Are short month endings (Jan 31 -> Feb 28, Aug 31 -> Sep 30) clamped properly without skipping months or jumping days?
  - "Twice a month" / "Semimonthly": Does jumping from the 15th to the 30th/31st or 1st work across leap years and varying month lengths?
  - Frequencies: `daily`, `weekly`, `biweekly`, `every4weeks`, `monthly`, `everyothermonth`, `every3months`, `every4months`, `twiceayear`, `yearly`, `every2years`, `never`/`once`.
- **Auto-Posting & Materialization**:
  - When a recurring transaction is posted (`postRecurringTransaction`), does it accurately copy splits, transfers, flags, categories, and memos?
  - Does `autoPostDueRecurringTransactions` correctly post all overdue instances when multiple intervals have elapsed (catch-up posting)?
  - Is `active` correctly toggled to `false` for one-off frequencies (`never`, `once`) upon posting?

### E. Reconciliation Flow (`packages/server/src/queries/reconcile.ts`, `packages/ui/src/ReconcileModal.tsx`)
- **Working Balance Formula**:
  - Does working balance include all Cleared (`"c"`) and Reconciled (`"r"`) transactions up to `statementDate`?
  - Are Uncleared (`"u"`) rows properly excluded?
- **Locking & Reconcile Immutability**:
  - Are reconciled transactions (`status === "r"`) strictly locked from edits or deletion in `updateTransaction`, `deleteTransaction`, `bulkUpdateTransactions`, and `bulkDeleteTransactions`?
  - Are split parents locked if any child is reconciled?
- **Synthetic Adjustment Balancing**:
  - When `statementBalance !== workingBalance`, is a balancing transaction created with `RECONCILE_ADJUSTMENT_MEMO` and the selected adjustment category?
  - Does the adjustment amount accurately close the diff?
- **Unreconcile Logic (`unreconcileAccount`)**:
  - Does unreconciling accurately target only the transactions from that specific reconciliation round (`reconciliationId`)?
  - Is the synthetic adjustment transaction cleanly deleted and its balance reversed?
  - Is the account's `lastReconciledAt` and `lastReconciledBalance` restored to the previous round?

### F. CSV Import, YNAB4 Backup Ingestion & Duplicate Rules (`packages/logic/src/csv-import.ts`, `packages/server/src/`)
- **CSV Parser Robustness**:
  - Escaped quotes (`""`), commas within quotes, multi-line notes, CRLF/LF line endings, BOM markers (`\uFEFF`).
  - Date heuristics: DMY vs MDY auto-detection voting, single-digit months/days, 2-digit vs 4-digit years.
  - Amount parsing: currency symbols (`$`, `€`, `£`), thousand separators (commas vs periods), parenthesis accounting format `(123.45)` for negatives, separate inflow/outflow columns vs unified amount column.
- **Payee Rename Rules & Wildcard Inference (`rename-rules.ts`)**:
  - Wildcard pattern `[N]` matching digits.
  - Regex escaping of special characters in payee names (`+`, `*`, `(`, `)`, `[`, `]`, `?`).
  - Learning and generalisation: Does `learnRenameRule` avoid corrupting rules or infinitely duplicating rules?
- **Duplicate Detection (`duplicates.ts`)**:
  - Fingerprint normalization (trim, lowercase, whitespace collapsing).
  - Are transfers and split parents/children correctly exempt from false-positive duplicate flags?
- **YNAB4 Backup Roundtrip (`import-ynab4.ts`, `export-ynab4.ts`)**:
  - Entity ID mapping and foreign key resolution.
  - Zero-balance accounts, hidden category groups, starting balance reconstruction.

### G. Reports, Trends & Financial Insights (`packages/logic/src/reports.ts`)
- **Net Worth Timeline Reconstruction (`computeNetWorthReport`)**:
  - Does it accurately back-calculate starting balances from current balances and lifetime transaction deltas?
  - Are off-budget accounts without transactions (property, mortgage) preserved at their fixed balance across history?
  - Assets vs Debts separation.
- **Cash Flow & Spending Trends**:
  - Multi-level drilldown: All Categories -> Category Group -> Single Category.
  - Handling of credit card payment groups (should be excluded from spending trends).
  - Division by zero / negative denominator guards in savings rate, funded percentage, and percentage change.

### H. UI State, Optimistic Updates & Unit Coercion
- **Cents vs Dollars Unit Coercion**:
  - Are all amounts consistently converted between float dollars in UI inputs and integer cents in DB/Logic?
  - Trace `evalAmount`, `dollarsToCents`, `num`, `fmt` across `BudgetAppShell.tsx`, `Modals.tsx`, `AmountInput.tsx`, and `BudgetView.tsx`.
- **Optimistic State & Rollback**:
  - When an API request fails, does `BudgetAppShell` correctly roll back optimistic state and alert the user?
  - Are negative amounts, zero assignments, and decimal rounding handled seamlessly?
- **Browser State & Deep Linking**:
  - URL routing (`/budget/YYYY-MM`, `/transactions/accountId`, `/reports`, `/recurring`).
  - `localStorage` corruption handling (`useLocalStorage`).

### I. Database, Schema & API Validation (`packages/server/src/schema.ts`, `apps/web/src/app/api/`)
- **Database Transactions & Concurrency**:
  - Are multi-table writes properly wrapped in `db.run(sql\`BEGIN\`)` and `db.run(sql\`COMMIT\`)` / `db.run(sql\`ROLLBACK\`)`?
  - Are read-then-write races avoided in `sort` assignment?
- **API Request Validation (`schemas.ts`)**:
  - Do Zod schemas in `apps/web/src/app/api/schemas.ts` match the types and invariants expected by `@ynab/server` and `@ynab/logic`?
  - Proper HTTP error status codes (400 for bad input, 404 for not found, 422 for unprocessable/reconciled locked).

---

## 3. Required Output Format: `bugs.md`

Your output file `bugs.md` must be formatted strictly according to the following template:

```markdown
# Codebase Audit & Bug Report

**Audit Date**: [Current Date]
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary
[Provide a concise, high-level summary of the overall codebase health, total issues identified by severity, and primary risk areas.]

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | N | ... |
| **High** | N | ... |
| **Medium** | N | ... |
| **Low** | N | ... |
| **Code Quality / Inconsistency** | N | ... |

---

## Detailed Bug Findings

### [BUG-01] <Descriptive Title>
- **Severity**: Critical | High | Medium | Low | Code Quality
- **Category**: Budget Engine | Register & Balance | Splits & Transfers | Recurring | Reconcile | CSV & Import | Reports & Analytics | UI & State | Database & API
- **Location**:
  - **File**: `packages/.../filename.ts` (or `apps/...`)
  - **Function / Component / Symbol**: `functionName()` or `ComponentName`
- **Description & Root Cause**:
  [Explain clearly what is wrong and why the bug occurs in the code logic.]
- **Reproduction / Scenario**:
  [Provide concrete steps or data conditions that trigger the bug.]
- **Potential Impact**:
  [Explain the consequence: data corruption, incorrect TBB calculation, orphan records, crash, etc.]
- **Recommended Resolution**:
  [Provide a specific, conceptual solution or architectural fix. Do NOT apply the fix in code yet.]

---

### [BUG-02] ...
[Repeat for all discovered bugs]

---

## Production Readiness Assessment & Next Steps
[Provide an honest assessment of what must be addressed before this application can be safely used with real personal financial data.]
```

---

## 4. Execution Directives
1. **Be Specific**: Always reference the exact file paths and function/component/class names. Avoid relying purely on volatile line numbers.
2. **Be Thorough**: Do not stop at surface-level syntax; analyze the mathematical correctness, boundary edge cases, floating point / cent rounding, and multi-month accounting mechanics.
3. **No Code Edits**: Do not touch or modify existing source code files.
4. **Deliverable**: Write the entire audit report to `bugs.md`.
