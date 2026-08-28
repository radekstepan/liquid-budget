# Codebase Audit & Bug Report

**Audit Date**: 2026-08-27
**Re-verification Date**: 2026-08-27 — every finding re-checked against source, tests, and git history (introduction commits identified).
**Scope**: Core Logic, Accounting Correctness, Financial Invariants, Data Integrity, Single-User Production Readiness

---

## Executive Summary

After re-verification against the code, the test suite, and the commit history, **6 genuine bugs remain** (1 Medium, 5 Low). Each entry below includes the commit that introduced it; where a bug was introduced while fixing a previous bug, a **Regression Guard** section states what the earlier fix achieved and what any new fix must preserve.

Entries dropped during re-verification (not bugs): BUG-01, BUG-02, BUG-03, BUG-10, BUG-14 (working-as-designed or already handled, pinned by tests); BUG-04 (intentional YNAB4-matching design); BUG-11 (cosmetic error text, behavior correct); BUG-12 (latent API-design hazard, no current misbehaviour); BUG-13 (missing API surface — feature gap, not incorrect behaviour); NOTE-01 (intentional, test-pinned split-collapse on account deletion); NOTE-02 (dead prop, code-quality only).

| Severity | Count | Items |
| :--- | :--- | :--- |
| **Medium** | 1 | BUG-09 (diagnostic blind spot) |
| **Medium, conditional** | 1 | BUG-15 (requires out-of-band duplicate links) |
| **Low** | 4 | BUG-05, BUG-06, BUG-07, BUG-08 |

---

## Detailed Bug Findings

### [BUG-05] Legacy unreconcile fallback over-flips rows and can delete the wrong adjustment

- **Severity**: Low (reachability is narrow; see below)
- **Category**: Reconcile
- **Location**: `packages/server/src/queries/reconcile.ts:338–397` (`unreconcileAccount`, legacy `else` branch; flip filter at line 350, adjustment lookup at lines 370–381)
- **Description**:
  When the account has `lastReconciledAt` but no `reconciliations` row, unreconcile falls back to date-based matching: `reconciledAt <= lastDate OR (reconciledAt IS NULL AND date <= lastDate)`. For an account with **multiple** pre-migration reconciliation rounds this:
  1. flips rows reconciled in **earlier** rounds (their `reconciledAt < lastDate` also matches), and
  2. lets the adjustment lookup (memo `"Reconciliation balance"`, newest-first) match an **older round's** adjustment — or a user-typed transaction with that memo — and delete/reverse it,
  3. then nulls `lastReconciledAt` instead of restoring the previous round.
  Manually *cleared* (`'c'`) rows are not affected (the filter requires `status = 'r'`).
- **Reachability**: Narrow. The fallback only runs when `lastReconciledAt` is set without a `reconciliations` row, which today requires a database created before migration 0003 (added 2026-08-16, no backfill). The YNAB4 importer (`import-ynab4.ts:152–212`), `reconcileAccount`, and `unreconcileAccount` itself all create round rows going forward, and imported reconciled transactions carry `reconciliationId` since the old-BUG-14 fix.
- **Introduced in**:
  - `b2ce51e` 2026-08-04 *feat: reconciliation* — original date-based unreconcile with **equality** matching (`reconciledAt = lastDate`).
  - `d3452d6` 2026-08-16 *UNI-10 — add reconciliation round tracking* — introduced the `reconciliationId`-precise path and preserved the old date-based matching as the legacy `else` fallback for pre-migration accounts; migration 0003 shipped without a backfill.
  - **`8f48f0b` 2026-08-26 *fix: BUG-14 BUG-15* — the widening from `=` to `<=` (both the flip and the adjustment search) is what created the current over-flip/misfire risk.** It was made so imported reconciled rows (per-row `reconciledAt` dates, no round ID at the time) could be unreconciled — old-audit BUG-14 "Imported reconciled rows cannot reliably be unreconciled".
- **Regression guard**: The `<=` widening exists for old-BUG-14 (imported reconciled rows staying permanently locked while round metadata was cleared). The importer now creates a real reconciliation round and stamps `reconciliationId` on imported rows, so those rows take the precise path and no longer depend on the legacy branch. A fix may therefore safely tighten the legacy match back to `=` — **or better, add a one-time migration backfilling `reconciliations` rows for accounts with `lastReconciledAt` set and no rows, then delete the fallback entirely**. Do not simply delete the fallback: pre-migration accounts would then fail to unreconcile (the precise branch finds no row and the account is stuck reconciled), reintroducing the spirit of old-BUG-14 from the other direction.
- **Recommended resolution**: Backfill migration + delete the legacy branch (or tighten to `=` as a stopgap).

### [BUG-06] CC Payment category carryover seeded via fragile payee-text match

- **Severity**: Low
- **Category**: CSV & Import
- **Location**: `packages/server/src/import-ynab4.ts:723–747` (LIKE filter at line 731)
- **Description**: After import, the CC Payment category's `carryover` is seeded by finding the card's starting-balance transaction via `lower(payee) like '%starting balance%'`. YNAB4 always writes the English payee "Starting Balance", so the match succeeds in practice; it silently fails only if the payee was renamed, leaving the card's debt carryover at 0 and the card showing $0 available for payment. Nit: the `.limit(1)` has no `ORDER BY`, so multiple matches are nondeterministic.
- **Introduced in**: `371dea1` 2026-08-17 *fix(importer): initialize credit card payment category carryover from starting balance (UNI-25)* — **while fixing old-audit BUG-29** "Credit card payment categories created with `carryover: 0` instead of initial card balance on import" (plan.md: UNI-25/BUG-29). Before this commit, imported CC payment categories were always seeded with `carryover: 0` and cards with pre-existing debt showed $0 available.
- **Regression guard**: Any rework must keep seeding the carryover from the card's starting-balance debt — that is the behaviour UNI-25 added and its integration test pins (`packages/server/tests/import-ynab4.integration.test.ts`). Do not simply remove the payee lookup without an equivalent source for the opening balance (e.g. derive it from the account's oldest transaction / opening entry), otherwise old BUG-29 regresses: imported cards with starting debt would again show $0 available for payment.
- **Recommended resolution**: Derive the initial carryover from the account's oldest transaction balance instead of payee text; add `ORDER BY date` if the payee match is kept.

### [BUG-07] Optimistic assignment update stores a dollars-style string in a cents pipeline

- **Severity**: Low, cosmetic
- **Category**: UI & State
- **Location**: `apps/web/src/components/BudgetAppShell.tsx:152,156` (`amount.toFixed(2)` in `api.assign()`)
- **Description**: The optimistic update stores e.g. `"10000.00"` while the DB round-trips the integer-cent string `"10000"` (`AssignmentUpsertSchema` requires int cents; `getBudgetData` maps `String(a.amount)`). `num()` parses both to the same value, so budget math is unaffected; the only effect is a string-shape mismatch that can defeat referential-equality memoization until the next reload.
- **Introduced in**: `6308053` 2026-07-29 *feat: init* — the optimistic assign was written when the entire stack was dollar-denominated (`numeric(14,2)` columns, `amount.toFixed(2)` everywhere), where it was **correct**. `8b2d963` 2026-07-29 *feat: sqlite* migrated the schema and server to integer cents but left the client's optimistic `toFixed(2)` string behind; the mismatch went unnoticed because `num()` happens to parse both formats identically. Not introduced by a bug fix.
- **Recommended resolution**: Store `String(Math.round(amount))` to match the DB/`getBudgetData` format. The snapshot/rollback machinery around it (added by UNI-22, 1cb3488) must keep working — `setData(snapshot)` on failure remains the rollback path.

### [BUG-08] Posting a recurring rule with an empty memo stamps "Recurring"

- **Severity**: Low
- **Category**: Recurring
- **Location**: `packages/server/src/queries/recurring.ts:496,509,527` (`r.memo || "Recurring"`; split children are unaffected — line 517 uses `c.memo || undefined`)
- **Description**: A recurring rule with an intentionally blank memo produces posted transactions memoed "Recurring", which the user must clear by hand each time it posts.
- **Introduced in**: The hardcoded default dates to `6308053` 2026-07-29 *feat: init* (`memo: "Recurring"` on every posted rule). `11f1301` 2026-08-21 *feat: batch of changes* — which added the `memo` column to recurring rules (migration 0013) and first honoured the rule's memo when posting — kept the fallback for blank memos, creating the current defect. Not introduced by a bug fix.
- **Recommended resolution**: Drop the `|| "Recurring"` fallback and pass the memo through as-is. Preserve the part `11f1301` fixed: a **non-empty** rule memo must still be copied to the posted transaction (its reason for changing the line).

### [BUG-09] verifyBudgetIntegrity no longer compares against stored account balances

- **Severity**: Medium
- **Category**: Reports & Diagnostics
- **Location**: `packages/server/src/queries/diagnostics.ts:136–198` (`totalAccountBalance` accumulated from transaction deltas at lines 156–180; `accounts.balance` is never read)
- **Description**: Despite its docstring ("sum(on-budget account balances) − sum(category available) − TBB === 0"), the check recomputes the account side as a date-bounded cumulative **transaction delta**, not from stored balances. If a stored `account.balance` diverges from its transaction sum, this check passes. The per-account stored-vs-computed comparison exists separately in `verifyBalanceIntegrity` (same file, lines 30–73), so the gap is closed only if both diagnostics are run together.
- **Introduced in**:
  - `c2e4a39` 2026-08-16 *fix: audit* — introduced `verifyBudgetIntegrity` and **correctly** summed the real on-budget `accounts.balance` values.
  - `5c2bbf3` 2026-08-24 *fix: 6.2* — added `targetMonth`/latest-month evaluation (still using stored balances).
  - **`170a534` 2026-08-24 *fix: 6.2* — replaced the stored-balance sum with the transaction-delta walk, creating this blind spot.** It was made while fixing audit bug **6.2** "verifyBudgetIntegrity false-positives on deferred income and future-dated transactions": a paycheck deferred via `incomeMonth` (or a post-dated transaction) made the stored-balance version report a spurious difference exactly equal to that amount. The fix chose "recompute from transactions, bounded by month" over 6.2's lighter suggested remedy ("subtract future-dated and deferred-income amounts from the stored total"), which removed the false positives and the stored-balance coverage in one stroke.
- **Regression guard**: Whatever fix is applied must retain 6.2's false-positive elimination — evaluate at the latest month with data (or an explicit `targetMonth`), attribute income to `incomeMonth`, and exclude future-dated transactions. Do **not** simply revert to summing `accounts.balance` at the evaluated month: that is precisely the false positive 6.2 fixed. Safe options: (a) keep `verifyBudgetIntegrity` as the identity check and always run `verifyBalanceIntegrity` (per-account stored-vs-computed) alongside it, or (b) add the stored-vs-recomputed comparison using the same date bounding. The 6.2 tests in `packages/server/tests/diagnostics.test.ts` must keep passing.
- **Recommended resolution**: Option (a) — wire both checks into the same startup/scheduled diagnostic.

### [BUG-15] normalizeBudgetData duplicate-link dedup can leave a CC account with no payment category

- **Severity**: Medium, conditional (requires duplicate `linkedAccountId` values, which the DB unique index from migration 0015 makes hard to persist — reachable only via DB edits or hand-modified imports)
- **Category**: Budget Engine
- **Location**: `packages/logic/src/budget-engine.ts:161–253` (dedup at 212–222; `missingAccounts` at line 191)
- **Description**: When two categories link to the same CC account, `missingAccounts` is computed from the **pre-deduplication** link set, so the account is not considered missing and no new CC Payment category is created. Deduplication keeps the *first* category's link wherever it lives. If the surviving link sits in a non-Credit-Card-Payments group, the account ends up with **no** payment category: funded CC spending still drains the spending category's available (first pass) but is never credited to any CC Payment category (second pass only processes `ccGroupIds` categories), silently shrinking total category Available and tripping `verifyBudgetIntegrity`.
- **Introduced in**: `99068d9` 2026-08-26 *fix: BUG-08 BUG-09* — **the dedup logic is itself the fix for old-audit BUG-08** "Duplicate CC payment links double-count one card buffer" (two categories linked to one card each received the same `fundedCC + cardAdvance − cardPayment` buffer, overstating reserved money; the fix also validates account kind/on-budget in `getCCAccountIds` and added the DB unique index, migration 0015). The fix eliminated the double-count but left this residue case.
- **Regression guard**: The invariant the old-BUG-08 fix established — **at most one category per linked credit account participates in the CC buffer** (`seenLinked` guards in `normalizeBudgetData`/`computeAllMonths`/`getCCAccountIds`, plus the unique index) — must be preserved by any change. The correct repair keeps that invariant: when the surviving link's category is not in a Credit Card Payments group, clear its link too, so the account falls into `missingAccounts` and exactly one proper CC Payment category is synthesized. Do not merely "keep both links" or skip deduplication: that reintroduces the double-counted buffer.
- **Recommended resolution**: In the dedup pass, also clear the surviving link when its category's group is not a CC Payments group.

---

## Production Readiness Assessment & Next Steps

### What Works Well

1. **Budget engine core logic**: Cumulative carryover, TBB, credit-card buffer/funded-spend routing, and overspend handling are mathematically sound; the previously suspected register/gap-month/deletion issues were verified as intended, test-pinned behaviour.
2. **Account deletion**: Transfer and split-transfer cleanup in both directions is correct and thoroughly test-covered.
3. **Database schema**: Proper FKs, cascade deletes, unique constraints (`categories_linked_account_uniq`, migration 0015), CHECK constraints, indexed reconciliation lookups.
4. **Test coverage**: All 8 workspace suites pass (`yarn test`), including integration tests for import, reconcile, recurring, and account-deletion edge cases.

### Should Fix Before Production Use

1. **[BUG-09]** Run `verifyBalanceIntegrity` alongside `verifyBudgetIntegrity` (restores the stored-balance coverage lost in the 6.2 fix without reintroducing its false positives).
2. **[BUG-05]** Backfill `reconciliations` rows via migration, then remove or tighten the legacy unreconcile fallback.

### Nice to Have

1. **[BUG-06]** Derive CC starting carryover from the account's opening transaction instead of payee text (keep old BUG-29's seeding behaviour).
2. **[BUG-15]** Clear a surviving link that sits outside the CC Payments group (preserve old BUG-08's single-buffer invariant).
3. **[BUG-07]** Optimistic assignment update: store `String(Math.round(amount))`.
4. **[BUG-08]** Drop the `"Recurring"` memo fallback while still honouring non-empty memos.

### Monitoring & Operational Readiness

1. Schedule `verifyBalanceIntegrity` + `verifyBudgetIntegrity` (e.g. on startup) and log mismatches; `recomputeAccountBalances` (`diagnostics.ts:79–123`) exists as a self-heal safety net.
2. Add E2E coverage for multi-month gap navigation with a serialized `budgetIndex` attached (exercises the `buildCarryoverMap` fallback) and unreconcile roundtrips.
3. The cache epoch + WeakMap pattern in `budget-engine.ts` is fine for single-user session lifetimes; TTL eviction is unnecessary complexity here.