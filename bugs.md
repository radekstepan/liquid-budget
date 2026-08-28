# Codebase Audit & Bug Report

**Audit Date**: 2026-08-27
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness
**Method**: Full read of `packages/logic`, `packages/server`, `packages/ui`, `apps/web` (API + shell), plus dynamic verification of the budget engine, date math, and SQLite query layer against an in-memory database (scratch harness; no source files were modified). Existing test suites (`packages/logic`: 342 tests, `packages/server`: 421 tests) pass — the findings below live in edge paths the suites do not cover. Findings marked **[verified]** were reproduced by executing the code. Every finding includes an `Introduced In` field (commits from the linear 50-commit history, `dc3579a`..`67a298c`) and a `Regression Risk` note describing what to watch for when fixing.

---

## Executive Summary

The codebase is architecturally sound for its stated goal: a single-user, local-first YNAB4 clone. The pure-logic budget engine is genuinely well-designed — cumulative carryover, cash-vs-credit overspending split, the CC payment buffer, red-arrow carryover, and the TBB surplus chain all behave correctly across contiguous months, gap months, and funded/unfunded credit-card spending (empirically verified). Integer-cent discipline is maintained end-to-end, and the split/transfer/reconcile locking rules are enforced consistently at the query layer.

The weaknesses concentrate in three areas: **(1) failure isolation around recurring auto-posting** — a single un-postable recurring rule throws inside `GET /api/budget`, making the entire app unusable; **(2) import/export fidelity** — the YNAB4 importer can create transactions that violate the app's own accounting invariants (uncategorized boundary outflows, unbalanced scheduled splits, mis-locked reconciled splits), and the roundtrip loses CC-payment assignments, boundary-transfer categories, and reconciliation rounds; **(3) silent API/UX divergence** — the PATCH route silently drops `transferAccountId`, CSV refunds on credit cards become TBB income, and bulk edits fail atomically on split children.

| Severity | Count | Primary Areas |
| :--- | :--- | :--- |
| **Critical** | 3 | Recurring auto-post failure isolation, account deletion vs. recurring splits, YNAB4 import budget-identity breach |
| **High** | 7 | API silent field drops, CSV import income misclassification, split-child edit dead-end, schedule drift, reconcile round corruption |
| **Medium** | 12 | Locked-row mutation on category delete, CC category deletion cascade, evalAmount locale parsing, optimistic balance staleness, roundtrip data loss |
| **Low** | 12 | Error-code ergonomics, dead code, duplicated helpers, report filter inconsistencies |
| **Code Quality / Inconsistency** | 6 | Duplicated boundary-transfer rules (6 copies), cache-invalidation convention, index hydration duplication |

---

## Detailed Bug Findings

### [BUG-01] One un-postable recurring rule bricks the entire application on every data load
- **Severity**: Critical
- **Category**: Recurring | Database & API
- **Introduced In**: `fcf6007` (2026-08-16) — `autoPostDueRecurringTransactions` was introduced with no per-item error isolation. The try/catch blocks inside `postRecurringTransaction` only cover the UPDATE phase, not the creation/validation phase. Later fix `e69e11b` moved `postRecurringTransaction` inside `withTransaction` but still without per-item isolation. The root cause — lack of try/catch around each rule's post loop — has been present since the function's inception.
- **Regression Risk**: If wrapping each rule's post in try/catch, ensure truly fatal errors (DB corruption) still propagate. Do not silently swallow validation errors — surface them in a per-rule failures list. Also ensure the outer `withTransaction` in `autoPostDueRecurringTransactions` does not roll back already-posted rules when one fails — either commit per-rule or move the transaction inside each post.
- **Location**:
  - **File**: `packages/server/src/queries/recurring.ts`
  - **Function / Component / Symbol**: `autoPostDueRecurringTransactions()` → `postRecurringTransaction()`; consumed by `apps/web/src/app/api/budget/route.ts` (`GET`)
- **Description & Root Cause**:
  `GET /api/budget` calls `autoPostDueRecurringTransactions(db)` **outside any per-item error isolation**. Inside, each due rule is posted via `postRecurringTransaction`, which routes through `createSplitWithChildren` / `createTransfer` / `createTransaction`. Those functions **re-validate at post time** (`assertSplitsBalanced`, the "Boundary transfer outflow requires a category" rule, `assertValidAmount`). If any active rule with `nextDate <= today` is un-postable, the thrown `TransactionError`/`RecurringError` propagates out of the GET, which returns a 500. `BudgetAppShell` sets `error` and renders the full-screen `Notice tone="danger"` error page — the app never loads, so the user **cannot open the UI to fix or delete the offending rule**. Several code paths can produce an invalid-but-active rule (see BUG-02, BUG-08, and the YNAB4 importer which inserts scheduled splits with **no** balance validation, `import-ynab4.ts` step 7). **[verified]**: a recurring split reduced to <2 children throws `"split must have at least two sub-transactions"` at post time.
- **Reproduction / Scenario**:
  1. Import a YNAB4 backup whose `scheduledTransactions` include a split whose sub-amounts do not sum to the parent (the importer does not validate this), **or** delete an account that is the transfer target of a recurring split child (BUG-02).
  2. Wait until the rule's `nextDate <= today` (or import a rule already overdue).
  3. Load `/` → `GET /api/budget` → 500 → permanent "Error" screen.
- **Potential Impact**: Total application unavailability; requires manual SQLite surgery to recover. Any automated catch-up loop also amplifies the damage (see BUG-09).
- **Recommended Resolution**: Wrap each rule's auto-post in its own `withTransaction` + try/catch inside `autoPostDueRecurringTransactions`, collecting per-rule failures into the response; move auto-post out of the budget GET (or make it best-effort with a `failures[]` list); mark a rule `active = false` (or surface a banner) after repeated post failures. Additionally, validate scheduled splits at import time in `importYnab4`.

---

### [BUG-02] `deleteAccount` silently corrupts recurring split rules whose children transfer to the deleted account
- **Severity**: Critical
- **Category**: Splits & Transfers | Recurring
- **Introduced In**: `3954b1f2` (2026-08-16) — the `deleteAccount` recurring cleanup was written to delete only `recurring.transferAccountId = id` (transfer rules) and `recurringSubTransactions.transferAccountId = id` (split sub-rows). The problem — deleting a sub-row from a split without rebalancing or deleting the parent — was never addressed. Present since the function was introduced (`0d9d63f`, bug 8).
- **Regression Risk**: A fix must handle all three cases: (a) single recurring transfer rule → delete entire rule (current behavior is correct), (b) recurring split where one child transfers to the deleted account → either delete the entire split or rebalance the parent amount and re-validate children count, (c) recurring split where multiple children transfer → same as (b). Ensure the fix runs inside the same `withTransaction` as the rest of `deleteAccount`. Do NOT widen the deletion to delete every recurring that merely references the deleted account anywhere (e.g. in a memo/note).
- **Location**:
  - **File**: `packages/server/src/queries/accounts.ts`
  - **Function / Component / Symbol**: `deleteAccount()` — step 3 cleanup
- **Description & Root Cause**: Step 3 executes
  `db.delete(recurring).where(eq(recurring.transferAccountId, id))` and
  `db.delete(recurringSubTransactions).where(eq(recurringSubTransactions.transferAccountId, id))`.
  For a **split** recurring rule where only *one* child transfers to the deleted account, this deletes that child row but leaves the parent recurring rule intact with (a) fewer than 2 children and (b) a parent `amount` that no longer equals the remaining children's sum. The rule passes no validation until it is posted. **[verified]**: creating a 2-child recurring split (one transfer leg → account X, one plain leg), deleting account X, then posting fails with `"split must have at least two sub-transactions"`; the rule is left permanently un-postable in the DB.
- **Reproduction / Scenario**: Checking account → recurring split "Loan payment" with sub-rows [transfer $60 → Loan(off-budget), $40 categorized]; `DELETE /api/accounts/{loanId}`; next auto-post cycle throws (feeding BUG-01).
- **Potential Impact**: Orphaned, unbalanced recurring rules; application brick via BUG-01; silent loss of the scheduled transfer leg.
- **Recommended Resolution**: Either (a) delete the *entire* recurring rule when any of its sub-transaction transfer targets is the deleted account (mirroring the transfer-rule cleanup), or (b) refuse account deletion while referenced by recurring sub-transactions (422, like the reconciled-transaction guard), or (c) rebalance/delete the affected rule atomically within the same transaction.

---

### [BUG-03] YNAB4 import creates boundary outflow transfers with no category, silently breaking the core budget identity
- **Severity**: Critical
- **Category**: Budget Engine | CSV & Import
- **Introduced In**: `25cf72f` (2026-08-23, "fix: 2.3") — the `finalTransferCatId` computation was added as part of the YNAB4 import transfer-pair branch. The logic `finalTransferCatId = !isCrossBoundaryTransfer ? null : isSpecialIncomeCat ? null : catId` was written to match the server's `createTransaction` boundary rules, but the OUTFLOW case was never guarded — `catId` can be null when the YNAB4 category is missing, and `finalTransferCatId` becomes null, bypassing the "Boundary transfer outflow requires a category" invariant that `createTransaction`/`createTransfer` enforce. Earlier import commits (`0a91525c`, 2026-08-15) wrote a simpler transfer import that also lacked this guard; the `25cf72f` refactor preserved the gap.
- **Regression Risk**: The fix must make the importer enforce the same boundary-transfer category requirement as the live API. Two approaches: (a) route ALL imported transactions through `createTransaction` (preferred — single code path), or (b) replicate the guard in the importer. If (a) is chosen, ensure `createTransaction` handles all edge cases the importer currently handles (transfer-pair orientation normalization, split children with transferAccountId). Test that an existing backup with missing categories does not fail the entire import — either auto-assign a category or warn and skip. Do NOT make the importer stricter than the API: if the API allows it, the importer should too.
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `importYnab4()` — transfer-pair branch, line computing `finalTransferCatId`
- **Description & Root Cause**: The write path (`createTransaction` / `createTransfer`) enforces "Boundary transfer outflow requires a category" (400) because an on-budget → off-budget transfer with `categoryId == null` is otherwise **completely invisible** to the budget engine: `buildRawIndexData` only records outflow when `categoryId != null`, and `isIncomeTransaction` returns `false` for it — no category outflow, no TBB deduction, money simply leaves the on-budget accounts. The importer does **not** enforce this rule: `finalTransferCatId = !isCrossBoundaryTransfer ? null : isSpecialIncomeCat ? null : catId` writes `categoryId: null` for an on→off transfer whose YNAB4 category is missing/unmapped. **[verified]**: with such a row, `computeBudget` shows the category and TBB unchanged while the checking account drops — `sum(categoryAvailable) + TBB ≠ sum(onBudget balances)`; `verifyBudgetIntegrity` reports a non-zero difference.
- **Reproduction / Scenario**: Import a backup containing a transfer from an on-budget account to a tracking/off-budget account with no category (common when the YNAB4 category was deleted or the payee/transfer mapping is unmapped). View any month from the transfer onward: TBB and category balances overstate reality by the transfer amount.
- **Potential Impact**: Silent breach of the fundamental identity the app itself audits (`difference ≠ 0` in `/api/diagnostics/budget-integrity`); TBB and envelope balances become untrustworthy after import; no error or warning is surfaced.
- **Recommended Resolution**: At import time, require/derive a category for on→off boundary outflows (map to a synthetic "Transfers Out" category, or reuse YNAB4's original category when present), or post them through `createTransaction` so the invariant is enforced once, in one place. Reject-or-fix rather than silently inserting rule-violating rows.

---

### [BUG-04] Editing a transfer's destination account in the transaction modal is silently ignored
- **Severity**: High
- **Category**: Splits & Transfers | UI & State
- **Introduced In**: `4ca23180` (2026-08-03, "feat: transfer and split") — the PATCH route was created with an explicit field whitelist that omitted `transferAccountId`. The server's `updateTransaction` also documents the restriction. The route's field list was later refactored in `e69e11b` (bug 19) and again in `e490ebe` (bug 14) but `transferAccountId` was never added. The omission is by design (server blocks it), but the UI never communicates this restriction to the user. Fix `8f48f0b` (BUG-14 BUG-15) touched the route but did not add `transferAccountId`.
- **Regression Risk**: Simply adding `transferAccountId` to the PATCH route's field list would break the server's immutability contract. Instead, the fix should be in the UI: disable the destination dropdown when editing an existing transfer (matching the "Single" button disable for split parents). If server-side delete+recreate semantics are added later, ensure the route forwards the field AND the server implements the balance re-routing correctly (reverse old, apply new, update both accounts).
- **Location**:
  - **File**: `packages/ui/src/Modals.tsx` (`TransactionModal.save()` — transfer mode), `packages/ui/src/BudgetApp.tsx` (`onSave` → `api.updateTransaction(id, rest)`), `apps/web/src/app/api/transactions/route.ts` (`PATCH` — builds `patch` without `transferAccountId`), `packages/server/src/queries/transactions.ts` (`updateTransaction` — documents "Transfers may not change transferAccountId")
- **Description & Root Cause**: The modal's transfer mode shows a "Transfer to" dropdown that remains editable when editing an existing transfer, and its save payload includes `transferAccountId`. `TransactionPatchSchema` even validates it. But the PATCH route constructs `patch` from an explicit field whitelist that **omits `transferAccountId`**, and `updateTransaction` would reject the change anyway ("would require re-routing the mirrored balance"). The client shows "Transaction updated." while the destination is unchanged. **[verified]**: after `updateTransaction(id, { transferAccountId: c4 })`, the stored row still points at the original account. The optimistic client state also does not apply `transferAccountId`, so the UI does not even lie consistently.
- **Reproduction / Scenario**: Register → click a transfer row → change "Transfer to" from Account B to Account C → Save → toast "Transaction updated." → row still transfers to B; B/C balances unchanged.
- **Potential Impact**: Silent data loss / user intent divergence in a financial register; the user believes money is routed to a different account.
- **Recommended Resolution**: Either disable the destination `Select` when `initial?.transferAccountId` is set (matching the disabled "Single" toggle for splits), or implement delete-and-recreate semantics server-side when `transferAccountId` changes on a non-split transfer row.

---

### [BUG-05] CSV import turns credit-card refunds into TBB income instead of reducing card debt
- **Severity**: High
- **Category**: CSV & Import | Budget Engine
- **Introduced In**: `da18db59` (2026-08-19) — `importCsvTransactions` was introduced with `const isIncome = categoryId == null && amount > 0 && !!account.onBudget`. This binary rule predates per-account-kind handling. The CSV import bypasses `createTransaction` (which handles boundary/income rules correctly for CC accounts via `netOnBudgetDelta` checks). No later commit added account-kind branching.
- **Regression Risk**: Fix by checking `account.kind === "credit"` — for credit cards, an uncategorized positive amount should NOT be income. Ensure this does NOT break CSV import for regular liquid accounts (where uncategorized positive amounts ARE income, e.g. deposits). Do NOT route CSV rows through `createTransaction` wholesale, since that would apply boundary-transfer rules and reject plain CSV rows that happen to look like transfers.
- **Location**:
  - **File**: `packages/server/src/import-csv.ts`
  - **Function / Component / Symbol**: `importCsvTransactions()` — `const isIncome = categoryId == null && amount > 0 && !!account.onBudget`
- **Description & Root Cause**: CSV import bypasses `createTransaction` and applies a single income rule for all on-budget accounts: positive + uncategorized ⇒ `isIncome = true`. For a **credit card** account, a statement credit/refund is not income — in YNAB semantics it reduces the card balance (and should flow back through the CC payment category). Importing a CC statement therefore converts every refund into TBB income while the card's negative balance improves without any budget movement — widening the account-vs-envelope gap exactly like BUG-03. **[verified]**: importing rows `-5000` (purchase) and `+2000` (refund) into a credit account yields `isIncome = true` on the refund row.
- **Reproduction / Scenario**: Import a credit-card CSV containing a refund/credit line with no category; open the budget for that month → TBB increased by the refund; CC payment category unchanged.
- **Potential Impact**: Inflated income and TBB on every CC statement import; incorrect "Income" in cash-flow reports.
- **Recommended Resolution**: In `importCsvTransactions`, branch on account kind: for `kind === "credit"`, either leave uncategorized credits to be handled by the CC payment logic (post through `createTransaction` so boundary/isIncome rules apply uniformly), or require a category for inflows on cards.

---

### [BUG-06] Split children can never be uncategorized — any such bulk edit fails the entire batch (422)
- **Severity**: High
- **Category**: Splits & Transfers | UI & State
- **Introduced In**: `2bf8d93` (2026-08-26, "fix: BUG-10 BUG-11") — the `assertSplitsBalanced` call in `bulkUpdateTransactions`'s post-verification loop was added to enforce split balance after bulk edits. However, `assertSplitsBalanced` requires every negative-amount child to have a category. This validation is correct for `updateSplit`/`createSplitWithChildren` where the caller is building a new split, but wrong for `bulkUpdateTransactions` where the caller may be fixing a single field (date, status) on a child. Earlier versions of `bulkUpdateTransactions` (e.g. `e69e11b`) did not re-validate split balance.
- **Regression Risk**: The fix should either (a) remove the `assertSplitsBalanced` call from `bulkUpdateTransactions` (balance is enforced at split creation/update time), or (b) only re-validate when the `amount` or `categoryId` of a child actually changed. If (a), add a test that bulk-editing split children (setting date or status) does not re-validate balance. Do NOT relax `assertSplitsBalanced` itself — it is correct for its original call sites (`createSplitWithChildren`, `updateSplit`, `createRecurring`).
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function / Component / Symbol**: `assertSplitsBalanced()` (called from `updateTransaction` and `bulkUpdateTransactions` post-checks)
- **Description & Root Cause**: `assertSplitsBalanced` requires every child with `amount <= 0` to have a category or transfer account. `bulkUpdateTransactions` applies the patch to each row and then re-validates the parent. Setting `categoryId: null` ("Income: Available this month" / clear-category in `BulkEditModal`) on selected split children therefore fails validation, and because the whole batch is one transaction, **every** selected row is rejected. **[verified]**: `bulkUpdateTransactions(childIds, { categoryId: null })` → `"sub-transaction 1 must have a category or transfer account"`. Single-row `updateTransaction` on a child behaves identically. The UI offers this operation without warning (the modal does not exclude split children from the category field).
- **Reproduction / Scenario**: Register → select rows including two legs of a split → Bulk Edit → set Category = "Income: Available this month" → confirm → error toast, nothing saved.
- **Potential Impact**: All-or-nothing bulk edits fail with an opaque error; users cannot uncategorize split legs (a legitimate correction flow after mis-splitting).
- **Recommended Resolution**: Either relax the invariant so a negative uncategorized child is permitted (the engine already skips uncategorized negative children harmlessly — they just become unbudgeted spend, same as any uncategorized transaction), or have `BulkEditModal` exclude split children from category edits and tell the user why.

---

### [BUG-07] Recurring schedules permanently drift when `anchorDay` is NULL (YNAB4 import fallback / explicit patch)
- **Severity**: High
- **Category**: Recurring
- **Introduced In**: `dc3579a` (2026-08-25, "fix: bug 6") — the `anchorDay` parameter was added to `nextDateFor` as part of a BUG-06 anti-drift fix. The fix correctly persists and uses the anchor when available, but the fallback `anchorDay = d.getUTCDate()` re-derives the anchor from the *current, already-clamped* `nextDate` every time — which re-introduces the drift whenever `anchorDay` is NULL. The `postRecurringTransaction` code (written in `fcf6007`) was updated in `160f5b2` (BUG-02) to use `r.anchorDay ?? parseInt(r.nextDate.slice(8,10), 10)` — the same re-derivation. The `import-ynab4.ts` step 7 may write `anchorDay: null` when the YNAB4 scheduled transaction lacks `anchorDay`/date. The drift was present before the fix for rules without anchors; the fix made it conditional on `anchorDay` being NULL.
- **Regression Risk**: The fix must ensure every month-based frequency rule has a persisted anchor. At insert time (`createRecurring`), default `anchorDay` from `nextDate` if not provided (already done — line ~225). At import time (`importYnab4` step 7), always compute an anchor from the available `st.date` or `st.anchorDay`. For existing NULL anchors in the database, a migration or lazy backfill is needed. Do NOT change `nextDateFor`'s fallback behavior — it is correct when `anchorDay` is intentionally set to the current date (the "drift as desired" case).
- **Location**:
  - **File**: `packages/logic/src/format.ts` (`nextDateFor()` — anchor fallback `anchorDay = d.getUTCDate()`), `packages/server/src/queries/recurring.ts` (`postRecurringTransaction` — `const anchor = r.anchorDay ?? parseInt(r.nextDate.slice(8,10), 10)`), `packages/server/src/import-ynab4.ts` (anchorDay may be `null`)
- **Description & Root Cause**: The BUG-06 anti-drift fix only works when a stable `anchorDay` is persisted. When `anchorDay` is NULL, the anchor is re-derived from the *current, already-clamped* `nextDate` on every post. **[verified]**: `monthly` from `2025-01-31` without anchor → `2025-02-28 → 2025-03-28 → 2025-04-28 …` (permanently the 28th); `semimonthly` from `2025-01-31` without anchor → `2025-02-16 → 2025-03-01 → 2025-03-16 → 2025-04-01 …` (15-day shift of both occurrences). With a persisted anchor (31) both recover correctly. Import writes `anchorDay: null` whenever the YNAB4 scheduled transaction lacks `anchorDay`/date, and `updateRecurring` accepts `anchorDay: null`.
- **Reproduction / Scenario**: Import a backup with a monthly scheduled transaction on the 29th–31st (no anchorDay) → let it auto-post across February → schedule permanently lands on the 28th; semimonthly end-of-month rules shift to the 1st/16th.
- **Potential Impact**: Bills silently post on wrong dates month after month; with catch-up auto-posting (BUG-09) this multiplies into many mis-dated transactions.
- **Recommended Resolution**: Never allow a NULL anchor for month-based frequencies — default it to the day-of-month of `nextDate` **at insert time** (the importer already knows `st.date` in most cases; make `null` fallback compute and persist an anchor), and refuse `anchorDay: null` patches for month-clamped frequencies.

---

### [BUG-08] Imported reconciled splits are stored with cleared parents and reconciled children — permanently locked rows
- **Severity**: High
- **Category**: Reconcile | Splits & Transfers | CSV & Import
- **Introduced In**: `0a91525c` (2026-08-15) — the split-parent insert in the importer was originally written with `status: t.cleared === "Uncleared" ? "u" : "c"`, never mapping to `"r"` for parents. The child status mapping (introduced in the same commit) used the full `t.cleared` mapping including `"r"`. This mismatch was the origin. Fix `8f48f0b` (BUG-14 BUG-15, 2026-08-26) refactored the parent status to `t.cleared === "Uncleared" ? "u" : "c"` — still never `"r"`. The reconciliation-record creation logic (also in `8f48f0b`) only creates a record when the account has `lastReconciledDate` or top-level Reconciled transactions — split children are not top-level, so accounts whose only reconciled data is inside splits get no reconciliation record, creating orphaned `'r'` rows.
- **Regression Risk**: The fix must either (a) set the parent status to `'r'` when all children are reconciled (matching `reconcileAccount`'s parent flip), or (b) strip `'r'` from children when no reconciliation record exists. Option (a) is more faithful to the data. Additionally, the reconciliation-record creation must include split children in its count. Do NOT change the existing `reconcileAccount` parent flip query — that is correct for the online reconcile flow.
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts` (split parent insert uses `status: t.cleared === "Uncleared" ? "u" : "c"` while children use the full mapping including `"r"`), combined with `packages/server/src/queries/transactions.ts` (`updateTransaction`, `updateSplit`, `deleteTransaction` 422 guards) and `packages/server/src/queries/reconcile.ts` (`unreconcileAccount` — only flips rows matching `reconciliationId = lastRec.id`)
- **Description & Root Cause**: The importer inserts split **parents** with status `"c"` (or `"u"`) and split **children** with `"r"` when the YNAB4 parent was Reconciled. This inverts the app's own invariant (a parent is reconciled only when *all* children are, per `reconcileAccount`'s flip query). Consequences:
  1. Every mutation path on the split (`updateTransaction` on the parent → "children.some(status 'r') → 422"; `updateSplit` → 422; `deleteTransaction` → 422; editing a child → parent/'r' checks → 422) is blocked, yet the parent *displays* as cleared — the "Unreconcile" escape hatch requires an account `reconciliationId` linkage.
  2. If the account has no imported reconciliation record (the importer only creates one when the account has `lastReconciledDate` **or top-level** Reconciled transactions — split children are not top-level), the children get `status='r'` with `reconciliationId = null` → **orphaned R rows** that `unreconcileAccount` can never target: permanently locked, undeletable, un-editable.
- **Reproduction / Scenario**: Import a backup where an account's only Reconciled transactions are inside splits and the account has no `lastReconciledDate`; attempt to edit or delete the split in the register.
- **Potential Impact**: Permanently locked historical data; reconcile-state counts and working balance include rows the user cannot correct.
- **Recommended Resolution**: In the importer, mark the parent `"r"` when all children are reconciled (matching `reconcileAccount`), and ensure a reconciliation record is created whenever *any* imported row (including split children) is Reconciled. Alternatively, strip `"r"` to `"c"` when no reconciliation record exists for the account.

---

### [BUG-09] Catch-up auto-posting materializes every overdue occurrence silently, on every data load
- **Severity**: High
- **Category**: Recurring | UI & State
- **Introduced In**: `fcf6007` (2026-08-16) — the while-loop in `autoPostDueRecurringTransactions` (`while (currentNextDate <= validatedAsOfDate)`) was part of the original function design. The loop's lack of a per-occurrence cap and its placement inside `GET /api/budget` (added in `ac548ddc`, 2026-08-20) means every reload posts every backlogged occurrence. No later fix added a cap or confirmation. The `reload()`-after-every-mutation pattern (`2c1b409`, 2026-08-26) amplifies this: even a simple assignment change triggers auto-post evaluation.
- **Regression Risk**: Adding a cap (e.g. max 5 occurrences per rule per call) is safe, but ensure it does not silently skip occurrences — log them as "capped" and surface in the response. If adding per-rule isolation (BUG-01), ensure the cap applies per-rule, not globally. Consider adding a user confirmation step (e.g. "Post 14 overdue occurrences of 'Rent'?").
- **Location**:
  - **File**: `apps/web/src/app/api/budget/route.ts` (`GET`), `packages/server/src/queries/recurring.ts` (`autoPostDueRecurringTransactions` while-loop), `apps/web/src/components/BudgetAppShell.tsx` (`reload()` runs after **every** mutation)
- **Description & Root Cause**: `autoPostDueRecurringTransactions` loops `while (currentNextDate <= asOfDate)` — one posted transaction per elapsed interval — and this runs inside `GET /api/budget`, which the client calls on initial load **and after every single mutation**. There is no user confirmation, no cap, and no per-item failure isolation (any failure aborts the whole batch — see BUG-01). Combined with BUG-07 (drift) a drifted daily/weekly rule that was left unopened for weeks can post dozens of transactions in one request; the only feedback is a toast with a count after the fact. A transient failure mid-loop rolls back nothing of the already-committed outer transaction... in fact the entire run is one transaction, so one bad rule blocks *all* due rules from posting (head-of-line blocking), and the count toast can mislead.
- **Reproduction / Scenario**: Create a daily recurring entry, set the system clock forward two weeks, reload → 14+ transactions appear at once with no confirmation; if any other rule is corrupt, none post.
- **Potential Impact**: Silent mass insertion of transactions; wrong category outflows for a whole backlog period; user confusion and difficult cleanup.
- **Recommended Resolution**: Cap catch-up occurrences per rule (or require explicit confirmation for >N), isolate per-rule failures, and surface skipped/failed rules in the response payload instead of failing the entire budget GET.

---

### [BUG-10] Reconcile/unreconcile corrupts split-parent status across reconciliation rounds
- **Severity**: High
- **Category**: Reconcile | Splits & Transfers
- **Introduced In**: `5af5c113` (2026-08-26, "fix: BUG-25 BUG-26") — the parent flip and flip-back queries were added as part of the first reconcile implementation. The parent flip-back query `IN (SELECT parent_id ... AND status = 'c')` flips any parent whose *any* child is now `'c'` — including parents that were reconciled in an **earlier** round. The parent flip condition `NOT IN (SELECT parent_id ... AND status != 'r')` can leave parents unreconciled when children have divergent dates (children accept their own date patches per `updateTransaction`). The parent `reconciliationId` is not checked in either query. Both defects were present in the initial implementation (`5af5c113`, `2fc1607`).
- **Regression Risk**: The primary fix: include `eq(transactions.reconciliationId, lastRec.id)` in both the flip and flip-back parent queries so only rows from the round being processed are touched. Additionally, forbid children dates from diverging from the parent (in `updateTransaction`, propagate date changes to children as already done for parent date edits — line 769-774). If the date-divergence fix is not feasible (children can have independent dates by design), the parent flip condition must be removed entirely (derive parent status from children at read time).
- **Location**:
  - **File**: `packages/server/src/queries/reconcile.ts`
  - **Function / Component / Symbol**: `reconcileAccount()` (parent flip query) and `unreconcileAccount()` (parent flip-back query)
- **Description & Root Cause**: Two related defects:
  1. **Partial-date splits**: children of a split can have divergent dates (children accept their own `date` patches; only parent date edits propagate). `reconcileAccount` flips only children with `date <= statementDate`, so a split can end up with some children `'r'` (this round) and some `'c'`, while the parent stays `'c'`. The parent is now *effectively* locked (`updateSplit`/`deleteTransaction` check `children.some(c => c.status === 'r')` → 422) but displays as editable, and `unreconcileAccount`'s parent flip-back (`IN (SELECT parent_id … AND status = 'c')`) can never fully restore it.
  2. **Cross-round downgrade**: `unreconcileAccount` flips parents whose *any* child is now `'c'` after the round's child flip — including parents that were reconciled in an **earlier** round (`reconciliationId` pointing at an older round). The parent is set to `'c'` and its `reconciliationId` cleared even though that round is not being undone, so the account's restored `lastReconciledAt/Balance` (previous round) no longer matches the row states.
- **Reproduction / Scenario**: Reconcile account (round 1, statement date d1) covering a split; later add a child-dated-after-d1 case or reconcile again (round 2); undo round 2 → parent from round 1 flips to `'c'` while the account claims round-1 reconciliation.
- **Potential Impact**: Split rows stuck between states; reconciled history no longer corresponds to any reconciliation round; unreconcile no longer restores a consistent prior state.
- **Recommended Resolution**: Track split-parent reconciliation through the children (derive parent status), or include the parent's `reconciliationId` in the flip-back predicate (`eq(transactions.reconciliationId, lastRec.id)`) so only rows from the round being undone are touched; forbid children dates from diverging from the parent.

---

### [BUG-11] `deleteCategory` / `deleteCategoryGroup` silently re-categorize *reconciled* (locked) transactions
- **Severity**: Medium
- **Category**: Reconcile | Database & API
- **Introduced In**: `966d1625` (2026-08-16) — the `moveToCategoryId` update blocks in `deleteCategory` and `deleteCategoryGroup` were written to move ALL transactions referencing the doomed category, with no `status != 'r'` filter. The reconciled-lock guards in `updateTransaction`/`bulkUpdateTransactions` were present from earlier commits, but the category-deletion paths were never taught about them. Fix `e69e11b` (bug 19) touched these files but did not add the guard.
- **Regression Risk**: The simplest fix is to add `and(eq(transactions.status, "c"), eq(transactions.status, "u"))` to the move-to UPDATE WHERE clause, leaving reconciled rows with the old category (which will be deleted, so their `categoryId` goes to NULL via the schema's `onDelete: set null` — acceptable). Alternatively, block deletion when reconciled rows reference the category. Do NOT add the guard only to one of `deleteCategory` and `deleteCategoryGroup` — both must be updated.
- **Location**:
  - **File**: `packages/server/src/queries/categories.ts`
  - **Function / Component / Symbol**: `deleteCategory()`, `deleteCategoryGroup()` — `moveToCategoryId` update blocks
- **Description & Root Cause**: Both functions move **all** transactions referencing the doomed category to the replacement category with `db.update(transactions).set({ categoryId: ... })` — including rows with `status = 'r'`, which every other write path refuses to touch (422 "reconciled and locked"). Locked history is mutated without any guard, breaking the reconcile immutability contract the rest of the system enforces.
- **Reproduction / Scenario**: Reconcile an account; delete the category used by reconciled transactions choosing a replacement → reconciled rows change category silently.
- **Potential Impact**: Locked, statement-verified history changes category; reports and budgets shift for closed periods.
- **Recommended Resolution**: Exclude `status = 'r'` rows from the move (leave their category via `SET NULL`, or block deletion until unreconciled), or require explicit user consent for migrating locked rows.

---

### [BUG-12] Deleting an account wipes its Credit-Card payment category and **all** assignments ever made to it
- **Severity**: Medium
- **Category**: Budget Engine | Database & API
- **Introduced In**: `3954b1f2` (2026-08-16) — the `deleteAccount` step 4 (`db.delete(categories).where(eq(categories.linkedAccountId, id))`) was part of the original `deleteAccount` implementation. The schema cascade on `assignments.categoryId → categories.id` means deleting the category cascades to all assignments. No later fix added a guard.
- **Regression Risk**: The fix should either (a) null out `linkedAccountId` and move the category to a retained group (e.g. "Deleted Accounts") instead of deleting, or (b) block deletion while the category carries assignments. Option (a) is more user-friendly — it preserves history. If (a) is chosen, ensure `normalizeBudgetData` does not recreate a new CC payment category for an account whose old one was merely unlinked (it checks `!validLinkedAccountIds.has(a.id)` — unlinked accounts still trigger recreation, which is correct for active cards).
- **Location**:
  - **File**: `packages/server/src/queries/accounts.ts` (`deleteAccount` step 4: `db.delete(categories).where(eq(categories.linkedAccountId, id))`) and `packages/server/src/schema.ts` (`assignments … onDelete: "cascade"`)
- **Description & Root Cause**: A credit card's payment category is hard-deleted when the account is deleted; the schema cascades `assignments.categoryId → categories` on delete, destroying every historical "budgeted toward the card" assignment. Transactions that referenced the category are silently un-categorized (`onDelete: set null`). Budget history for the card (months of debt-paydown allocations) disappears irrecoverably, and prior-month TBB/surplus chains recompute differently.
- **Reproduction / Scenario**: Budget $200/mo to the Visa payment category for a year → delete the Visa account → all Visa-pay assignments vanish; historical months' assigned totals change.
- **Potential Impact**: Irreversible loss of budgeting history; retroactive change to past TBB/surplus values.
- **Recommended Resolution**: Null out `linkedAccountId` and move the category to a retained group instead of deleting, or block deletion while the category carries assignments; consider archiving CC payment categories with the account.

---

### [BUG-13] `evalAmount` silently inflates single-digit European decimal input ("1,5" → 15)
- **Severity**: Medium
- **Category**: UI & State
- **Introduced In**: `e490ebef` (2026-08-25, "fix: bug 14") — the comma-normalization regex `.replace(/,(\d{2})(?!\d)/g, ".$1")` was added as part of `evalAmount`'s European-comma support. The regex only converts exactly-2-digit decimals, so a single-digit decimal comma (e.g. `12,5`) has its comma stripped as a thousands separator. The `parseAmount` function (used by CSV import) handles `1,5` correctly with its own multi-branch logic written in the same commit. The `evalAmount` path (used by interactive amount fields) was not given the same breadth.
- **Regression Risk**: The fix should extend the comma handling in `evalAmount` to match `parseAmount`'s behavior: treat `digits,digits{1,2}` (not followed by a 3-digit group pattern) as a decimal comma. Do NOT import `parseAmount`'s branching wholesale — `evalAmount` must also handle arithmetic expressions. Ensure the fix does not break existing users who type `1,234.56` (thousands comma in US format).
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `evalAmount()` — comma normalization regex `.replace(/,(\d{2})(?!\d)/g, ".$1")`
- **Description & Root Cause**: The comma→dot conversion only fires for **exactly two** digits after the comma; a single digit (the common European decimal form, e.g. `12,5`) has its comma stripped as a thousands separator, yielding `125` — a 10× error. It then flows through `dollarsToCents` into real amounts. (The CSV importer's `parseAmount` handles `1,5` correctly; the interactive amount fields do not.)
- **Reproduction / Scenario**: In any amount field (transaction, assignment cell, reconcile statement balance), type `12,5` → preview/commit evaluates as `$125.00`.
- **Potential Impact**: Silent 10× over-assignment or over-charging for users whose keyboard layout produces decimal commas.
- **Recommended Resolution**: Treat `digits,digits{1,2}` (not followed by a 3-digit group pattern) as a decimal comma, mirroring `parseAmount`'s rules; or normalize based on the YNAB4-imported `decimalSeparator` setting.

---

### [BUG-14] Deferred income month is hardcoded to "next month" and is reset when editing imported deferrals
- **Severity**: Medium
- **Category**: Budget Engine | UI & State
- **Introduced In**: `54ad8597` (2026-08-16) — the `incMonth = isDeferred ? nextMonthKey(date.slice(0, 7)) : null` line was part of the original `TransactionModal.save()` implementation. The `BulkEditModal` was later added (`c7422d9`, 2026-08-26) with the same hardcoded `nextMonthKey`. The UI was never extended to allow arbitrary `incomeMonth` values, even though the data model (and the YNAB4 importer) supports them. Fix `c7422d9` (BUG-27 BUG-28) touched `Modals.tsx` and `BulkEditModal.tsx` but did not add arbitrary month selection.
- **Regression Risk**: The fix must preserve `initial.incomeMonth` when the user does not explicitly change the deferral target month. Add a month picker for the deferred option. Ensure editing a non-deferred transaction does not accidentally set an incomeMonth (it already doesn't — `incMonth` is only set when `isDeferred` is true). For `BulkEditModal`, the same preservation rule applies.
- **Location**:
  - **File**: `packages/ui/src/Modals.tsx`
  - **Function / Component / Symbol**: `TransactionModal.save()` — `incMonth = isDeferred ? nextMonthKey(date.slice(0, 7)) : null` (single mode, line ~315; transfer mode line ~257; `BulkEditModal.handleSave` line ~158)
- **Description & Root Cause**: The UI can only express "deferred to next month", but the data model (and the YNAB4 importer) supports arbitrary `incomeMonth`. Editing any other field of an imported deferred-income transaction (e.g. its memo) recomputes `incomeMonth` as `nextMonthKey(date)`, silently moving income recognized several months out back to the following month and changing TBB for the months in between.
- **Reproduction / Scenario**: Import a backup containing income deferred three months out; open the transaction, edit the memo, save → `incomeMonth` becomes next month.
- **Potential Impact**: Silent mis-timing of income recognition for imported data; TBB changes in unattended months.
- **Recommended Resolution**: Preserve `initial.incomeMonth` when the user does not explicitly change the deferral; add a month picker for the deferred option.

---

### [BUG-15] Optimistic updates never adjust `account.balance`, so register running balances are wrong until reload
- **Severity**: Medium
- **Category**: Register & Balance | UI & State
- **Introduced In**: `1cb34881` (2026-08-17) — the optimistic `addTransaction` block was introduced with `newTx` construction that copied transaction fields but never adjusted `accounts[].balance`. The same pattern was used for `updateTransaction` (`2c1b409`, 2026-08-26) and `deleteTransaction`/`bulkDeleteTransactions` (same commit). Every optimistic mutation since the shell's creation has omitted balance adjustment. Fix `2c1b409` (BUG-23 BUG-24) rewrote the shell but did not add balance updates.
- **Regression Risk**: Adding balance updates to optimistic mutations requires tracking the signed delta for each affected account (source and transfer destination). For splits, the parent amount should NOT be applied (only children contribute). For transfers, both source and destination balances change. Ensure the optimistic delta exactly mirrors what `applyBalance` does server-side. Consider using the same `applyBalance` logic on the client (re-exported from the server) rather than hand-rolling.
- **Location**:
  - **File**: `apps/web/src/components/BudgetAppShell.tsx`
  - **Function / Component / Symbol**: `api.addTransaction/updateTransaction/deleteTransaction/bulkDeleteTransactions` optimistic `setData` blocks
- **Description & Root Cause**: The optimistic mutations add/remove/patch `data.transactions` but never touch `data.accounts[].balance`. `computeRunningBalances` anchors the walk at the (now stale) account balance, so immediately after adding a transaction the newest row shows the pre-transaction balance and every running balance in the register is shifted by the row's amount until the post-mutation `reload()` completes. If the reload fails (the code only shows a "failed to refresh" toast), the register stays internally inconsistent (rows' signed deltas don't reconcile to the anchor) until the next successful reload.
- **Reproduction / Scenario**: Add a $50 expense while on a slow/throttled connection; observe the new row's Balance column equal to the pre-add balance and every older row shifted by $50.
- **Potential Impact**: "Will it bounce" readings — the register's stated purpose — are wrong in the exact window users are entering transactions; sustained inconsistency if refresh fails.
- **Recommended Resolution**: Apply the signed delta(s) to the affected `account.balance` in the same optimistic update (source and transfer destination), mirroring `applyBalance`.

---

### [BUG-16] `POST /api/reset` irreversibly wipes the live budget and reseeds demo data, with no confirmation
- **Severity**: Medium
- **Category**: Database & API
- **Introduced In**: `8b2d9639` (2026-07-29) — the `/api/reset` route was introduced as a development convenience. Fix `ace23d4b` (BUG-03, 2026-08-26) rewrote the doc comment to say "Wipes all budget data" but did not add a confirmation guard. It ships in every build.
- **Regression Risk**: Gate behind an env variable (`RESET_ENABLED` or check `NODE_ENV === "development"`). If a "typed confirmation phrase" UI is added, ensure the frontend sends it and the backend validates it — do not rely on a simple boolean toggle that a CSRF/extension request can set.
- **Location**:
  - **File**: `apps/web/src/app/api/reset/route.ts`; `packages/server/src/seed.ts` (`resetAndSeedDatabase`)
- **Description & Root Cause**: A single unauthenticated, unconfirmed POST deletes all real data and replaces it with the demo fixture (IDs also reset via `sqlite_sequence`). It ships in the production build and is trivially reachable (any prefetch/extension/devtools request). There is no export-before-wipe guard even though `/api/export` exists.
- **Reproduction / Scenario**: `curl -X POST http://localhost:3000/api/reset` → months of real budgeting replaced by demo data.
- **Potential Impact**: Total, unrecoverable data loss of real financial data from a single accidental request.
- **Recommended Resolution**: Gate behind an env flag (`NODE_ENV=development`) or require a typed confirmation phrase + a pre-reset automatic `.y4backup`/SQLite export.

---

### [BUG-17] YNAB4 export/import roundtrip loses CC-payment assignments, boundary-transfer categories, and reconciliation rounds
- **Severity**: Medium
- **Category**: CSV & Import
- **Introduced In**: `629a980c` (2026-08-23) — the export's `nonInternalGroups` filter was introduced to exclude `isCreditCardPayments` groups from the master categories export. This was intentional (YNAB4 does not have a dedicated CC Payments group type), but the consequence — their categories' monthly budgets are not exported, and on re-import they map to nothing — was overlooked. The boundary-transfer category loss has been present since the first export implementation. Fix `852173a` (BUG-17 BUG-18) and later `cacae86` (BUG-47 BUG-48 BUG-49) touched the export but did not add CC-payment category export.
- **Regression Risk**: The fix for CC-payment categories: export them under a synthetic "Income" or custom "Credit Card Payments" master category with a YNAB4-compatible entity ID that the importer recognizes and maps back to the CC Payments group. For boundary-transfer categories: carry the category ID on the transfer row (as YNAB4 itself does — YNAB4 transfers to tracking accounts store the category on the on-budget leg). For reconciliation rounds: serialize `reconciliations` rows and re-create them on import. Each fix should be independently revertible.
- **Location**:
  - **Files**: `packages/server/src/export-ynab4.ts`, `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `exportYnab4()` (master-category assembly skips `isCreditCardPayments` groups; transfer rows exported with `categoryId: null`), `importYnab4()` (single reconciliation record per account)
- **Description & Root Cause**: Roundtrip fidelity gaps:
  1. Categories inside the Credit-Card Payments group are never exported as subcategories, so monthly budgets **assigned to CC payment categories** (debt-paydown plan) produce `monthlySubCategoryBudgets` entries whose `categoryId` has no mapping on import and are silently dropped.
  2. Categorized boundary transfers (e.g., sale proceeds from an off-budget account into a category) are exported with `categoryId: null` on both legs; on re-import the categorized inflow degrades to generic income.
  3. All reconciliation rounds per account collapse into one synthetic record (statement date = latest reconciled activity, balance approximated), losing statement dates/balances and `reconciliationId` audit trail.
  4. Split-children payees are not persisted (children re-export under the parent payee), so per-leg payee information is lost on re-import.
- **Reproduction / Scenario**: Export `.y4backup` → re-import → CC payment category budgets vanish; categorized boundary transfers become income; reconcile history reduced to one round.
- **Potential Impact**: "Backup" exports are lossy; restore-after-wipe produces a materially different budget.
- **Recommended Resolution**: Export CC-payment categories under a reserved master category and map them back; carry the category id on boundary transfers; serialize `reconciliations` rows (or at minimum preserve per-round statement metadata).

---

### [BUG-18] CC payment-category carryover seed heuristic can latch onto an arbitrary old transaction
- **Severity**: Medium
- **Category**: CSV & Import | Budget Engine
- **Introduced In**: `371dea1d` (2026-08-17) — the CC starting-balance heuristic was part of the original `importYnab4` implementation. The fallback to the oldest uncategorized transaction was added in `8db2725f` (2026-08-27, "fix: BUG-06") to handle non-English payee names. The heuristic predates both the budget engine's own back-calculation logic (`computeNetWorthReport` in `reports.ts`) and the account-delta computation, which could directly derive the opening debt without payee matching.
- **Regression Risk**: Replace the heuristic with `account.balance - sum_of_all_transactions_deltas` (the same back-calculation `computeNetWorthReport` uses). This is exact: the card's opening debt = current balance - lifetime net transactions. Ensure the calculation excludes split parents (matching the balance computation elsewhere). If the heuristic is kept as a fallback for edge cases (e.g. fresh import with transactions from before the backup), document that it is inexact and log a warning.
- **Location**:
  - **File**: `packages/server/src/import-ynab4.ts`
  - **Function / Component / Symbol**: `importYnab4()` — step 6b "Initialize Credit Card Payment category carryover"
- **Description & Root Cause**: The seed looks for payees matching `%starting balance%/%opening balance%/%initial balance%`; the fallback selects the **oldest uncategorized, non-transfer transaction** on the card. In localized YNAB4 installs (or renamed starting-balance payees) this can pick a random ancient purchase and set `carryover = |amount|`, corrupting the CC payment category's starting envelope (and thus month-one availability).
- **Reproduction / Scenario**: Import a backup whose card's opening transaction was renamed (e.g. "Solde initial" or edited to a vendor name); the payment category seeds with a wrong positive balance.
- **Potential Impact**: Wrong CC payment category availability in early months; user sees phantom money (or missing money) to pay the card.
- **Recommended Resolution**: Derive the card's opening debt from the account balance minus lifetime transaction delta (the same back-calculation `computeNetWorthReport` uses) instead of payee heuristics.

---

### [BUG-19] `overspentPrevious` reads 0 across gap months even though the overspend still suppresses TBB
- **Severity**: Medium
- **Category**: Budget Engine | Reports & Analytics
- **Introduced In**: `f207ad4d` (2026-08-25, "fix: bug 7") — the `buildCarryoverMap` function was introduced with the condition `mostRecentPrior === prevCalendarMonth` for reporting overspentPrevious. This was part of a broader rewrite of how carryover maps are constructed for gap months. Prior to this commit, `overspentPrevious` may have been computed differently. The condition was written to avoid double-counting overspend across months, but it incorrectly zeros the report when the previous calendar month has no data even though the surplus chain still carries the deduction. Fix `f207ad4d` touched `budget-engine.ts` and introduced this behavior.
- **Regression Risk**: The fix should report the most recent prior *data* month's overspent value (or compute the residual deficit contribution from the surplus chain). Do NOT simply remove the `prevCalendarMonth` check — that would report overspend from two months ago in the current month even when an intervening month had no data (the surplus chain already applies the deduction at the right point). Instead, walk back through `orderedMonths` from `targetMonth` and pick the last non-zero `overspentByMonth` entry, which is the last data month's overspend.
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `buildCarryoverMap()` (condition `mostRecentPrior === prevCalendarMonth`)
- **Description & Root Cause**: The reported "cash overspending from the previous month" is zeroed whenever the immediately-previous *calendar* month has no data, even though `computeAllMonths`/`computePriorTBBSurplus` correctly keep deducting that overspend from the running surplus chain. **[verified]**: overspend in Jan, no Feb data → `computeBudget('2025-03').overspentPrevious === 0` while `priorSurplus` still embeds the −119,000.
- **Reproduction / Scenario**: Overspend in January; skip February entirely; open March — no "overspent last month" indication although TBB is suppressed by that amount.
- **Potential Impact**: User-facing explanation of a reduced TBB is wrong in gap months (informational field, but it's the UI's only overspend-carry signal).
- **Recommended Resolution**: Report the most recent prior *data* month's overspent value (or compute the residual deficit contribution), and label it accordingly.

---

### [BUG-20] Split full-replace overwrites each child's payee with the parent's
- **Severity**: Medium
- **Category**: Splits & Transfers
- **Introduced In**: `11c27fe8` (2026-08-16, "fix: logic") — the child-insert loop in `createSplitWithChildren` and `updateSplit` was written with `let payee = parent.payee` for every child. The original implementation (`4ca23180`, 2026-08-03) already had this pattern. No later commit added per-child payee support. The `updateTransaction` path for split children (`updateTransaction` line ~501) also does not preserve child payee.
- **Regression Risk**: If per-child payees are added, the change must touch `createSplitWithChildren`, `updateSplit`, and `updateTransaction` (single-child update). The `updateSplit` full-replace should match children by index/amount/memo rather than by id, because the new children may not have ids yet. Preserve the existing child payee when the patch does not explicitly change it. The `TransactionModal` does not expose per-child payees, so this is a low-priority fix unless the API is used directly.
- **Location**:
  - **File**: `packages/server/src/queries/transactions.ts`
  - **Function / Component / Symbol**: `createSplitWithChildren()` and `updateSplit()` (child insert loops: `let payee = newPayee`)
- **Description & Root Cause**: On split creation and on every full-replace (`updateSplit` via PATCH `subTransactions`), non-transfer children are re-stamped with the parent's payee; any per-leg payee previously stored on a child (possible via direct API writes or the CSV/import paths) is destroyed. Memos and categories are preserved, payees are not.
- **Reproduction / Scenario**: `PATCH /api/transactions` with `{id, subTransactions:[...]}` on a split whose children had custom payees → all children revert to the parent payee.
- **Potential Impact**: Silent loss of payee detail on split legs; rename-rule learning and duplicate fingerprints keyed on payee drift.
- **Recommended Resolution**: Preserve the existing child payee when the patch does not explicitly change it (match children by position/id), or expose per-leg payees in the modal so the behavior is at least visible.

---

### [BUG-21] Net-worth reconstruction creates phantom accounts for transactions referencing deleted accounts
- **Severity**: Medium
- **Category**: Reports & Analytics
- **Introduced In**: `e490ebe` (2026-08-25, "fix: bug 14") — `computeNetWorthReport` was rewritten with the current delta-by-month algorithm. The bug — `runningBalances.set(accId, ...)` for every key in `deltasByMonth` inserts entries for account ids not in `data.accounts` — was present in the original algorithm as well. The function was first introduced earlier in the repo history. Fix `e490ebe` touched `reports.ts` but did not add the account-id guard.
- **Regression Risk**: The fix is straightforward: before applying a delta, check `data.accounts.some(a => a.id === accId)` or use a Set of valid ids. If the check fails, log a warning (helpful for debugging import issues). Do NOT silently skip the delta — a phantom account with a zero base balance still contributes non-zero deltas across months. Also consider using `accountMap.has(accId)` which is already available.
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function / Component / Symbol**: `computeNetWorthReport()` — delta application into `runningBalances` (steps 4–5)
- **Description & Root Cause**: `runningBalances` is seeded from `data.accounts`, but the month-delta application (`runningBalances.set(accId, …)` for every key in `deltasByMonth`) will **insert new entries** for account ids that appear in transactions but not in `data.accounts` (e.g. rows referencing accounts removed outside the guarded deletion path, or importer fallbacks). Those phantom accounts (base balance 0) are then summed into `assets`/`debts`, distorting history.
- **Reproduction / Scenario**: Any transaction row referencing an account id absent from `accounts` (corrupt import or manual DB edit) → net worth series shifts by that amount from its transaction month onward.
- **Potential Impact**: Net worth report silently includes balances for accounts that no longer exist.
- **Recommended Resolution**: Iterate `data.accounts` when applying deltas (skip unknown ids), and log/flag orphan references.

---

### [BUG-22] `updatePayee` cascades payee renames onto transfer rows and split legs by raw text match
- **Severity**: Medium
- **Category**: Database & API
- **Introduced In**: `e490ebe` (2026-08-25, "fix: bug 14") — the `updatePayee` function's text-match fallback `eq(transactions.payee, oldName)` was part of the original implementation. It was written to handle legacy transactions whose `payeeId` was null but whose `payee` text matched the renamed payee. The side effect — matching split children and transfer rows that happen to share the same payee text — was never guarded against.
- **Regression Risk**: The fix should restrict the text-match to `transactions.parentId IS NULL AND transactions.transferAccountId IS NULL` (only regular, non-transfer, non-child rows). Alternatively, drop the text-match fallback entirely after a data migration sets `payeeId` on all rows. If the text-match is kept, ensure it is documented as a best-effort cascade. Do NOT make the fix too narrow — there may be legitimate legacy rows (pre-payeeId era) that need the rename.
- **Location**:
  - **File**: `packages/server/src/queries/payees.ts`
  - **Function / Component / Symbol**: `updatePayee()` — `tx.update(transactions).set({ payee: newName }).where(or(eq(payeeId, id), eq(payee, oldName)))`
- **Description & Root Cause**: The rename matches **any** transaction whose payee *text* equals the old name, across all accounts, including split children and (textually colliding) transfer rows — not just rows actually linked by `payeeId`. A payee named like a transfer label or a reused string gets rewritten wholesale, changing duplicate fingerprints and rename-rule learning inputs.
- **Reproduction / Scenario**: Rename payee "Landlord" while a split child on another account also says "Landlord" without any payee linkage → the child's payee changes too.
- **Potential Impact**: Broader-than-intended mutation of historical rows; fingerprint churn in duplicate detection.
- **Recommended Resolution**: Restrict the text-match fallback to non-transfer, non-child rows, or drop it entirely in favor of `payeeId` linkage.

---

### [BUG-23] Register footer Inflow/Outflow totals are computed over rows that include transfer legs visible only in filtered views
- **Severity**: Low
- **Category**: Register & Balance
- **Introduced In**: `e69e11b` (2026-08-25, "fix: bug 19") — the `totals` useMemo was introduced in the `TransactionsView` rewrite that added virtualization and the current row-filtering architecture. The loop iterates `filtered` (which includes split parents) without an explicit parent exclusion. Prior to this rewrite, the totals may have been computed differently. Fix `e69e11b` and subsequent commits (`810abfe` BUG-44 BUG-45 BUG-46) touched `TransactionsView` but did not add the parent exclusion.
- **Regression Risk**: Explicitly exclude split parents from the totals walk (`splitParentIds.has(t.id)`). This matches the balance walk's behavior in `computeRunningBalances`. The same exclusion should be applied to `totals`, `inflow`/`outflow` column calculations, and any other aggregate computation over `filtered`.
- **Location**:
  - **File**: `packages/ui/src/TransactionsView.tsx`
  - **Function / Component / Symbol**: `totals` useMemo (iterating `filtered`)
- **Description & Root Cause**: The totals loop applies the incoming-transfer sign inversion per row (`isIncoming ? -amount : amount`) but does not exclude split parents from lists where both a parent and its inbound transfer-child can be visible simultaneously (single-account filter + child transferring *into* the account while the parent's account also matches via another leg). In the common paths the visibility filter (`isRowVisible`) prevents double counting, but the invariant is implicit and breaks whenever a child's `transferAccountId` equals the filtered account while the parent is also present (possible after category-less child transfers created via import fallbacks).
- **Reproduction / Scenario**: Construct a split whose child transfers into the filtered account while the parent row also matches the filter (possible after BUG-03-style imports) → totals double count the cluster.
- **Potential Impact**: Header totals disagree with row sums in edge cases.
- **Recommended Resolution**: Exclude split parents from the totals walk explicitly (as the balance walk does).

---

### [BUG-24] `DELETE /api/transactions` (single) reports success for nonexistent ids
- **Severity**: Low
- **Category**: Database & API
- **Introduced In**: `4ca23180` (2026-08-03, "feat: transfer and split") — the single DELETE handler was written with `await deleteTransaction(db, id); return Response.json({ ok: true });`, ignoring the return value. Present in every subsequent refactor (`e69e11b` bug 19, `87d0ddc` BUG-41 BUG-42 BUG-43).
- **Regression Risk**: Check the return value of `deleteTransaction` and return 404 when null. Ensure the same fix is applied to `deleteRecurring` in the recurring route (which checks the return value correctly).
- **Location**:
  - **File**: `apps/web/src/app/api/transactions/route.ts` (`DELETE`), `packages/server/src/queries/transactions.ts` (`deleteTransaction` returns `null`)
- **Description & Root Cause**: `deleteTransaction` returns `null` when the row is missing; the route ignores the result and answers `{ ok: true }`.
- **Reproduction / Scenario**: `DELETE /api/transactions?id=999999` → 200 `{ok:true}`.
- **Potential Impact**: Silent no-ops for API consumers; optimistic state and server state can diverge silently.
- **Recommended Resolution**: Return 404 when the id does not resolve.

---

### [BUG-25] Bulk-update detection on `POST /api/transactions` misroutes any create payload containing a `patch` key
- **Severity**: Low
- **Category**: Database & API
- **Introduced In**: `e69e11b` (2026-08-25, "fix: bug 19") — the `("patch" in json)` heuristic was added as part of a route refactoring to support bulk operations via POST. Prior to this, bulk-update may have been routed differently. The heuristic is ambiguous — any create payload with a `patch` key (even `patch: null`) is misrouted.
- **Regression Risk**: Replace the `in` check with an explicit `action` discriminator (the `action=bulk-update` query param already exists). Ensure the `BulkEditModal` and `BudgetAppShell` send the action parameter consistently.
- **Location**:
  - **File**: `apps/web/src/app/api/transactions/route.ts` (`POST` — `("patch" in json)` heuristic)
- **Description & Root Cause**: Any create payload that happens to include a top-level `patch` property is interpreted as a bulk update and fails Zod validation with a misleading error, instead of being processed as a create.
- **Reproduction / Scenario**: `POST /api/transactions` with `{ patch: null, accountId: …, amount: … }` → 400 bulk-update error instead of create.
- **Recommended Resolution**: Require the explicit `action` discriminator for bulk routes (the `action=bulk-update` query param already exists) instead of shape sniffing.

---

### [BUG-26] Zod schemas accept `status: "r"` on transaction/recurring patches while the server rejects it
- **Severity**: Low
- **Category**: Database & API
- **Introduced In**: `4ca23180` (2026-08-03, "feat: transfer and split") — the original schema had `z.enum(["u","c","r"])`. The reconcile flow is the only legitimate path to set `"r"`, but the schema was never narrowed. Fixes `e490ebe` (bug 14) and `b4933cb` (BUG-38 BUG-39 BUG-40) touched schemas.ts but did not tighten the enum.
- **Regression Risk**: Change `status` in request schemas to `z.enum(["u", "c"])`. The `"r"` value is only ever set internally by the reconcile flow. Ensure no API consumer depends on sending `"r"` (the `createTransaction` server function already rejects it with a clear error). Add a separate `ReconcileStatusSchema` for internal use if needed.
- **Location**:
  - **File**: `apps/web/src/app/api/schemas.ts` (`TransactionPatchSchema`, `TransactionBulkUpdateSchema`, `TransactionCreateSchema`)
- **Description & Root Cause**: `z.enum(["u","c","r"])` lets `"r"` through validation; the server then rejects with a 400/422. The validation layer and the domain layer disagree about the contract, producing avoidable round-trips and inconsistent error messages.
- **Recommended Resolution**: Restrict the enum to `["u","c"]` in request schemas (the reconcile flow sets `"r"` internally).

---

### [BUG-27] `computeMonthlyInsights` divides the "3-month average" by 3 even when fewer prior months exist
- **Severity**: Low
- **Category**: Reports & Analytics
- **Introduced In**: `e490ebe` (2026-08-25, "fix: bug 14") — the current `computeMonthlyInsights` implementation was introduced. The `divisor = priorMonths.size` (always 3) was part of the original design. Prior to this commit, a different insights computation may have existed. The function was first introduced earlier in the repo. Fix `9964e66` (BUG-35 BUG-36 BUG-37) touched `reports.ts` but did not address the divisor.
- **Regression Risk**: Change `divisor` to the number of prior months that actually have data: `mMap.size` (the number of months with at least one transaction for this category). If `mMap.size === 0`, skip the insight entirely. This makes the average more accurate for young budgets.
- **Location**:
  - **File**: `packages/logic/src/reports.ts`
  - **Function / Component / Symbol**: `computeMonthlyInsights()` (`divisor = priorMonths.size`)
- **Description & Root Cause**: For a budget with one prior month of history, the average divides the single-month spend by 3, deflating the baseline and inflating the reported `% vs 3-mo avg` change.
- **Reproduction / Scenario**: Brand-new budget with one prior month: a normal month shows a ~200% "spike".
- **Recommended Resolution**: Divide by the number of prior months that actually have data (`mMap.size`).

---

### [BUG-28] Reports view mini cash-flow counts off-budget account movement as income/spending
- **Severity**: Low
- **Category**: Reports & Analytics
- **Introduced In**: `e490ebe` (2026-08-25, "fix: bug 14") — the `ReportsView` income/outflow filter chains were introduced with the current report architecture. The filters never check `account.onBudget`. The `computeCashFlow` function in `reports.ts` correctly applies budget-boundary logic, but the UI panel uses its own filter. Fix `810abfe` (BUG-44 BUG-45 BUG-46) touched `ReportsView.tsx` but did not add the onBudget check.
- **Regression Risk**: The UI filters should use the same `isIncomeTransaction` / `netOnBudgetDelta` logic as `computeCashFlow`. Alternatively, simply call `computeCashFlow` for the month and use its result directly instead of re-filtering. The latter is simpler and guarantees consistency.
- **Location**:
  - **File**: `packages/ui/src/ReportsView.tsx`
  - **Function / Component / Symbol**: income/outflow `.filter(...)` chains (lines ~159–190)
- **Description & Root Cause**: The income filter (`categoryId == null && transferAccountId == null && amount > 0`) and outflow filter (`(transferAccountId == null || categoryId != null) && amount < 0`) never check `account.onBudget`, so dividends/valuations on off-budget tracking accounts count as income and off-budget outflows count as spending — inconsistent with `computeCashFlow` used elsewhere.
- **Reproduction / Scenario**: Record a dividend on an off-budget investment account → headline "Income" in the report includes it.
- **Potential Impact**: Cash-flow panels disagree with the Inspector's cash flow for the same month.
- **Recommended Resolution**: Apply the same `onBudget`/boundary logic as `computeCashFlow`.

---

### [BUG-29] `GET /api/export?format=sqlite` may omit WAL-resident transactions
- **Severity**: Low
- **Category**: Database & API
- **Introduced In**: `ac548ddc` (2026-08-20) — the SQLite export format was added with `db.$client.serialize()`. The function was written without consideration for WAL mode. No later fix addressed this.
- **Regression Risk**: Run `PRAGMA wal_checkpoint(TRUNCATE)` before serializing. This forces all WAL frames into the main DB file. Ensure the checkpoint is called inside a try/catch (it can fail if another connection holds a read lock, but in a single-user app this is unlikely). Alternatively, serialize inside a transaction (which implicitly checkpoints).
- **Location**:
  - **File**: `apps/web/src/app/api/export/route.ts` (`db.$client.serialize()`)
- **Description & Root Cause**: The connection runs in WAL mode (`client.ts`); `better-sqlite3`'s `serialize()` is documented as unsafe while other statements are in progress and with WAL there is a window where recently committed frames are not checkpointed into the serialized image, producing a backup that is missing the latest writes.
- **Reproduction / Scenario**: Enter a transaction then immediately download the SQLite export → the newest transaction may be absent.
- **Recommended Resolution**: Run `PRAGMA wal_checkpoint(TRUNCATE)` before serializing (or serialize inside a transaction).

---

### [BUG-30] Hidden/internal category groups are identified by display name, not a flag
- **Severity**: Low
- **Category**: Budget Engine | UI & State
- **Introduced In**: `0a91525c` (2026-08-15) — the `isHiddenGroup`/`isInternalGroup` functions in `BudgetView` and the importer's name-based hidden-group detection were part of the initial YNAB4 import implementation. The name-based approach was chosen for simplicity, but no schema-level `isHidden` flag was ever added. Fix `c7422d9` (BUG-27 BUG-28) touched `BudgetView.tsx` but did not change the detection mechanism.
- **Regression Risk**: Adding an `isHidden` flag to the `categoryGroups` schema requires a migration. The flag must default to `false`. The importer must set it when the YNAB4 group name matches "Hidden Categories". The `BudgetView` must use the flag instead of name matching. Ensure the flag is preserved across export/import roundtrips.
- **Location**:
  - **Files**: `packages/ui/src/BudgetView.tsx` (`isHiddenGroup`/`isInternalGroup`), `packages/server/src/import-ynab4.ts` (name-based hidden-group detection)
- **Description & Root Cause**: The YNAB4 "Hidden Categories" group is filtered/sorted by `name.toLowerCase() === "hidden categories"`. A user-created group with the same name is swallowed; a renamed or localized hidden group leaks into the visible budget.
- **Reproduction / Scenario**: Create a group literally named "Hidden Categories" → it disappears from the budget grid while its categories still consume assignments.
- **Recommended Resolution**: Persist an `isHidden`/`isInternal` boolean like `isCreditCardPayments`.

---

### [BUG-31] `normalizeBudgetData` fabricates in-memory category ids that can collide with future DB ids
- **Severity**: Low
- **Category**: Budget Engine
- **Introduced In**: `dc3579a` (2026-08-25, "fix: bug 6") — `normalizeBudgetData` was first introduced as part of the budget-engine rewrite (it may have existed earlier under a different name). The `maxCatId + 1` loop for auto-creating CC payment categories uses positive integers that live in the same space as DB-assigned ids. Prior to this commit, a different normalization mechanism may have existed. Fix `6737b29` (BUG-15) touched `normalizeBudgetData` but did not change the id allocation strategy.
- **Regression Risk**: Use a negative id space (e.g. `-1, -2, …`) for synthesized categories. Ensure the rest of the engine (budget-index caching, carryover tracking) handles negative ids correctly — `Map<number, ...>` keys accept negative keys without issue. Also ensure the UI does not render negative ids as category identifiers.
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `normalizeBudgetData()` (`maxCatId + 1` loop)
- **Description & Root Cause**: Auto-created CC payment categories get ids `max(categories.id) + 1…n` within the in-memory copy. If a real category insert reuses those ids between two client renders (possible with optimistic state held across a failed reload), client-side keying/memoization can conflate the phantom category with the real one. Transient because any successful mutation reloads fresh data.
- **Reproduction / Scenario**: Create a credit account (auto category id = max+1 in memory), then create a real category before the next successful reload → both report id `max+1`.
- **Recommended Resolution**: Use a negative id space (e.g. `-1, -2, …`) for synthesized categories so they can never collide with persisted ids.

---

### [BUG-32] `POST /api/transactions` contains unreachable status-normalization helper (dead code)
- **Severity**: Code Quality
- **Category**: Database & API
- **Introduced In**: `4ca23180` (2026-08-03, "feat: transfer and split") — `parseStatus` was defined as part of the original transactions route. It was never wired into any request handler — the schema validation handles status directly. No later fix removed it.
- **Regression Risk**: Simply delete the function. Ensure no other file imports it (it is not exported).
- **Location**:
  - **File**: `apps/web/src/app/api/transactions/route.ts`
  - **Function / Component / Symbol**: `parseStatus()`
- **Description & Root Cause**: `parseStatus` (boolean→`u`/`c` coercion) is defined but never invoked; request status handling goes exclusively through `TransactionCreateSchema`. It suggests support for YNAB4-style boolean `cleared` payloads that the schema does not actually accept.
- **Potential Impact**: Misleading surface area; risk of someone "fixing" the schema to route through dead semantics.
- **Recommended Resolution**: Delete it or wire it intentionally with a schema change and tests.

---

### [BUG-33] `recomputeAccountBalances` exists twice with diverging shapes
- **Severity**: Code Quality
- **Category**: Register & Balance
- **Introduced In**: `3954b1f2` (2026-08-16) — the import-ynab4.ts version was written first (as part of the import). The diagnostics.ts version was added later in `b4933cb` (BUG-38 BUG-39 BUG-40, 2026-08-26) as a transactional implementation. The duplication was never reconciled.
- **Regression Risk**: Keep the diagnostics (transactional) implementation and re-export it from the importer. Delete the import-ynab4.ts version. Ensure the importer's import path is updated to reference the diagnostics version.
- **Location**:
  - **Files**: `packages/server/src/import-ynab4.ts` (`recomputeAccountBalances`, exported "for testability") and `packages/server/src/queries/diagnostics.ts` (`recomputeAccountBalances`)
- **Description & Root Cause**: Two implementations of the same balance recomputation (one row-by-row with `await`, one set-based inside a transaction). Future fixes to one (e.g., parent-row exclusion subtleties) can silently miss the other; import uses the non-transactional variant.
- **Recommended Resolution**: Keep the diagnostics (transactional) implementation and re-export it from the importer.

---

### [BUG-34] The boundary-transfer classification rule is implemented six times and has already diverged
- **Severity**: Code Quality
- **Category**: Budget Engine | Splits & Transfers
- **Introduced In**: `4ca23180` (2026-08-03, "feat: transfer and split") — the first copy was written in `createTransaction`/`createTransfer`. Each subsequent function (`createSplitWithChildren`, `updateSplit`, `updateTransaction`, `bulkUpdateTransactions`) introduced its own copy. The importer's copy (`importYnab4.ts`) was added in `25cf72f` (2026-08-23). Fixes `99068d9` (BUG-08 BUG-09), `2bf8d93` (BUG-10 BUG-11), and `32927a1` (BUG-19 BUG-20) each touched multiple copies without consolidating them.
- **Regression Risk**: Extract a single `classifyBoundaryTransfer(srcAcc, destAcc, amount, categoryId)` function into `@ynab/logic` and use it everywhere, including the importer. Ensure the shared function handles all four states: (a) internal transfer → `{ categoryId: null, isIncome: false, incomeMonth: null }`, (b) boundary inflow with category → `{ categoryId, isIncome: false }`, (c) boundary inflow without category → `{ categoryId: null, isIncome: true }`, (d) boundary outflow → `{ categoryId: required, isIncome: false }` (throws if category is null). Test the shared function with every copy's existing test data to ensure no behavior change.
- **Location**:
  - **Files**: `packages/server/src/queries/transactions.ts` (`createTransaction`, `createTransfer`, `createSplitWithChildren`, `updateSplit`, `updateTransaction`, `bulkUpdateTransactions`), plus the engine's own mirror in `buildRawIndexData` and the importer's in `importYnab4`
- **Description & Root Cause**: The `isBoundaryCrossing` + `netOnBudgetDelta` + "requires a category" block is copy-pasted across six server functions (and an importer variant that BUG-03 shows is inconsistent with the rest). Signs, income flags, and error statuses differ subtly between copies (e.g. `netOnBudgetDelta > 0` vs `< 0` ordering, 400 vs 422).
- **Potential Impact**: Any future rule change must touch six sites; divergence is precisely how BUG-03 escaped.
- **Recommended Resolution**: Extract a single `classifyBoundaryTransfer(srcAcc, destAcc, amount, categoryId)` into `@ynab/logic` and use it everywhere, including the importer.

---

### [BUG-35] Budget-index cache invalidation relies on an unwritten immutability convention; `invalidateBudgetIndex` is dead code
- **Severity**: Code Quality
- **Category**: Budget Engine | UI & State
- **Introduced In**: `dc3579a` (2026-08-25, "fix: bug 6") — the WeakMap-based budget index cache and `invalidateBudgetIndex` were introduced as part of the budget engine rewrite. The function is exported but never called by the app. The shell's use of immutable object replacement (`{...prev, ...}`) happens to keep the cache valid, but nothing enforces this.
- **Regression Risk**: Either wire `invalidateBudgetIndex` into the shell's mutation helpers (call it before setData to invalidate the old object's cache), or freeze BudgetData objects in development to catch mutations. If wiring it in, ensure it is called with the OLD data object before setData replaces it.
- **Location**:
  - **Files**: `packages/logic/src/budget-engine.ts` (`budgetDataIndexCache` WeakMaps, `invalidateBudgetIndex()`), `apps/web/src/components/BudgetAppShell.tsx`
- **Description & Root Cause**: Correctness of the memoized index depends on every caller replacing the `BudgetData` object immutably (which the shell happens to do). The exported `invalidateBudgetIndex()` is never called anywhere in the app, and nothing documents the invariant; any future in-place mutation of `data.transactions` would silently serve stale aggregates with no error.
- **Recommended Resolution**: Either wire `invalidateBudgetIndex` into the mutation helpers or document/enforce the immutability contract (e.g. freeze in dev).

---

### [BUG-36] `hydrateBudgetIndex` re-implements the month-rolling engine with a simpler (divergent) model
- **Severity**: Code Quality
- **Category**: Budget Engine
- **Introduced In**: `dc3579a` (2026-08-25, "fix: bug 6") — `hydrateBudgetIndex` was introduced as part of the serialized index support. It re-derives `endingBalanceByMonth` from serialized maps using a simplified clamp model that must be kept in sync with `computeAllMonths`. Fix `6737b29` (BUG-15) modified `normalizeBudgetData` but not the hydration path.
- **Regression Risk**: Remove `hydrateBudgetIndex`'s `endingBalanceByMonth` reconstruction and instead recompute it by calling `computeAllMonths` (or a lightweight equivalent). The serialized index already contains all the raw data (`assignedByMonth`, `outflowByMonth`, `spendByAccountMonth`, `carryoverByMonth`) — `computeAllMonths` can operate on these directly without re-scanning transactions. If performance is a concern (the hydration path exists to avoid the O(n) transaction scan), the fix can still compute `endingBalanceByMonth` from the serialized `carryoverByMonth` + raw maps without duplicating the clamp/CC-buffer logic — just derive it the same way as `computeAllMonths` does.
- **Location**:
  - **File**: `packages/logic/src/budget-engine.ts`
  - **Function / Component / Symbol**: `hydrateBudgetIndex()` endingBalance reconstruction
- **Description & Root Cause**: The hydration path re-derives `endingBalanceByMonth` from serialized maps with a simplified clamp model. It currently matches `computeAllMonths`, but any future change to the carryover rules (red arrow, CC buffer split between passes) must be replicated here or the server-provided index and the client-rebuilt index will disagree — a subtle, hard-to-diagnose class of "wrong numbers only on first render" bugs.
- **Recommended Resolution**: Store only the raw per-month aggregates in the serialized index and derive carryover/ending/surplus exclusively through `computeAllMonths` (single source of truth).

---

### [BUG-37] `num()` silently coerces unparseable input to 0 and truncates decimal "cents" strings
- **Severity**: Code Quality
- **Category**: UI & State
- **Introduced In**: `dc3579a` (2026-08-25, "fix: bug 6") — `num()` existed before this commit, but the current behavior (silent coercion of unparseable input to 0 and truncation of decimal strings) has been present since the first version of the file. The function is used extensively throughout the codebase (budget-engine, reports, TransactionsView, Inspector). No fix has attempted to make it strict.
- **Regression Risk**: The safest approach is to add a new strict function `numCents()` that throws on non-integer/NaN input, and use it in all critical paths (budget-engine, reports, server queries). Keep the permissive `num()` for display purposes. Do NOT change `num()` itself — too many callers depend on its current behavior (e.g., `num(null)` returning 0). A migration from `num` to `numCents` should be done methodically, function by function, with tests.
- **Location**:
  - **File**: `packages/logic/src/format.ts`
  - **Function / Component / Symbol**: `num()`
- **Description & Root Cause**: `num("abc") → 0` and `num("12.34") → 12` (the parser treats inputs as integer cents and silently rounds). Every dollar/cents unit bug in a caller becomes a silent, plausible-looking number instead of an error. Current call sites happen to be consistent, but the coercion makes the unit contract unenforceable (contrast with `dollarsToCents`, which throws on overflow).
- **Recommended Resolution**: Split into `numCents()` (strict, throws on non-integer/NaN) and a forgiving display parser; or at minimum log/throw on lossy decimal input in dev builds.

---

## Production Readiness Assessment & Next Steps

**Overall**: The accounting core (envelope math, TBB chain, register anchoring, reconcile locking, cent-integer discipline) is genuinely solid and unusually well-tested for the happy paths — 763 passing unit tests back it. However, I would **not** yet trust this with real financial data. The blocking concerns, in priority order:

1. **Failure isolation for recurring auto-posting (BUG-01, BUG-02, BUG-09)** — a single bad rule renders the app permanently unbootable. This is the single highest-leverage fix: isolate per-rule posting, validate rules at every mutation/import, and never let posting failures escape `GET /api/budget`.
2. **Import integrity (BUG-03, BUG-08, BUG-17, BUG-18)** — the YNAB4 importer currently writes rows that the app's own write API would reject, and silently breaches the accounts = envelopes + TBB identity. Post-import, run `verifyBalanceIntegrity` + `verifyBudgetIntegrity` and either auto-heal or refuse with a report.
3. **Silent UI/API divergence (BUG-04, BUG-05, BUG-06, BUG-13)** — each one lets a user believe a financial edit happened when it did not (or did something else). Every silent drop in the PATCH route should become either a 4xx or an explicit UI no-op.
4. **Destructive endpoints (BUG-16)** — `/api/reset` must not ship enabled in production builds.
5. **Reconcile invariants (BUG-08, BUG-10, BUG-11)** — the `'r'` lock should be enforced at the schema level (e.g. a trigger preventing category/status changes on `'r'` rows outside the reconcile flow) rather than by convention across eight mutation paths.

**Recommended hardening sequence**: (a) add the missing server-side invariant tests (boundary-transfer category, split balance at post, anchor-day persistence); (b) route *all* transaction creation/migration through one validated code path; (c) make optimistic updates balance-consistent; (d) add a pre-release diagnostic gate that runs both integrity checks on every `/api/budget` response in dev builds. With those in place, the engine itself — the hardest part to get right — is already in good shape.