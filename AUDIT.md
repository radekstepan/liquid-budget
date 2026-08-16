# Logic & Math Audit

**Scope:** correctness of the budget/money computations and their persistence.
**Question asked:** is this ready for production use by a single local user?
**Verdict:** **No.** The architecture is sound and all 304 tests pass, but there are
confirmed defects in core budget math that a single user hits in ordinary use —
including one that makes the app's signature feature (the YNAB4 credit-card
buffer) monotonically wrong, and four that inflate "To Be Budgeted" with money
that does not exist.

Concurrency and multi-user concerns are deliberately excluded as out of scope.
Everything below affects one user on one machine.

---

## Method

- Read `packages/logic/src` (budget engine, reports, register, split, recurring,
  format), `packages/server/src` (schema, queries, client), and the API routes.
- Ran the existing suite: `yarn test` → 304 passed (logic 181 via `@ynab/ui`,
  server 123). None of the issues below are covered by it.
- Wrote throwaway tests against `packages/logic` whose assertions encode the
  **buggy** behavior. All 7 passed, confirming the defects. Scratch file removed.

Each finding is tagged:

- **[verified]** — reproduced by running code.
- **[read]** — established by reading the source; not executed.

---

## Research Supplement (added during fix planning)

### Codebase architecture

The project is a Yarn 4 monorepo with Turborepo:

- **`@ynab/logic`** (`packages/logic/`) — Pure business logic, no React, no DB.
  Budget engine, register, reports, recurring, format, split. 181 tests, vitest.
- **`@ynab/server`** (`packages/server/`) — SQLite via better-sqlite3 + Drizzle
  ORM. Schema, all queries (CRUD, reconcile, recurring). 123 tests, vitest.
- **`@ynab/ui`** (`packages/ui/`) — React components (ProjectionsView, charts).
  jsdom tests.
- **`apps/web`** — Next.js app. Playwright E2E tests only.

Key data flow: Server queries return rows → `getBudgetData()` massages types to
`BudgetData` → `computeBudget()` produces `BudgetResult` → UI renders.

### Issue inter-dependencies

Issues are not independent. The most impactful clusters:

- **#3, #4, #5, #13, #18** all stem from the same root cause: **"uncategorised"
  doubles as the income marker**. Any change to how income is identified fixes or
  affects all five.
- **#1 + #2** are two sides of the same CC model: the buffer is credited but
  never debited (#1), and the credit is excluded from TBB accounting (#2).
- **#6 (integer cents)** is a prerequisite for clean fixes to #8 (the `|| 0` bug
  is made worse by NaN-producing float arithmetic) and simplifies epsilon removal
  in #1, #5, #12.
- **#7 (DB transactions)** is a prerequisite for #9, #10, #11 — reconciliation
  bugs that can corrupt balances are made worse by the lack of atomicity.
- **#9 + #10** both need the same missing piece: per-reconciliation-batch
  tracking.
- **#19** contains dead code that reimplements buggy logic from the live path.
  Fixing the live path (#1-#5) without deleting #19 creates a maintenance hazard.

### Detailed fix plans

#### #1 — Credit-card buffer never draws down

**Root cause chain:** `buildCCBufferMap` only sums categorised negative rows on
the linked account. A card payment is a transfer → `categoryId` is null → the
payment is invisible. No other term in
`available = carryoverIn + assigned + rawFlow + ccBuffer` captures the payment.

**Fix:** In `buildCCBufferMap` and `buildSpendByAccountMonth`, add a second pass
that identifies transfers TO the linked credit account and subtracts them from
the buffer. Also, allow positive categorised rows (refunds) on the card to reduce
the buffer (currently skipped by `if (amt >= 0) continue`).

**Files:** `packages/logic/src/budget-engine.ts` — `buildCCBufferMap` (line 322),
`buildSpendByAccountMonth` (line 369), `computeCCBufferForMonth` (line 347 —
dead code, see #19).

**New test:** Charge $100 groceries to Visa, pay Visa from checking. Assert
`ccBuffer` is $0 after payment.

#### #2 — CC assignments are free + double-counted

**Root cause:** Two bugs compound:
1. `totalAssigned` in `computeBudget` (line 137) excludes CC groups, so assigning
   to a CC category costs nothing in TBB.
2. `computePriorTBBSurplus` (line 420) also excludes CC assignments from the
   carryforward chain.

**Analysis of the `ccBuffer` vs `assigned` question:** The `ccBuffer` represents
money implicitly moved from spending categories to the CC payment category. The
user's `assigned` is additional money they choose to budget directly. So
`available = carryoverIn + assigned + rawFlow + ccBuffer` is correct — the buffer
is a credit, not a replacement for assignment. The user assigning money to a CC
category is legitimate (e.g., paying down pre-existing debt). The real bugs are
just #1 (buffer never draws down) and the TBB exclusion of CC assignments.

**Fix:** Remove the `!ccGroupIds.has(g.group.id)` filter from both `totalAssigned`
(line 137) and `computePriorTBBSurplus` (line 420). CC assignments reduce TBB
like any other assignment. The `ccBuffer` term stays as-is.

**Files:** `packages/logic/src/budget-engine.ts` — lines 136-139, 413-421.

#### #3 — Off-budget inflows inflate TBB

**Root cause:** `computeMonthIncome` (line 390) filters on
`t.categoryId == null && num(t.amount) > 0`. It never joins to `accounts` and
never checks `onBudget`.

**Fix:** Folded into the shared `isIncome()` helper described in #4.

**Files:** `packages/logic/src/budget-engine.ts` — `computeMonthIncome` (line
390), `computePriorTBBSurplus` (line 404, calls `computeMonthIncome`).

#### #4 — Transfers counted as income

**Root cause:** `computeMonthIncome` uses `t.categoryId == null` as the income
test. Transfers also have `categoryId == null` (enforced by `createTransfer` at
`queries/transactions.ts:222`). So every transfer matches the income predicate.

Note the inconsistency: `reports.ts:183` in `computeCashFlow` **does** guard on
`t.transferAccountId == null` — two functions in the same codebase disagree about
what income is.

**Fix:** Create a shared `isIncome(t, accounts)` helper that checks ALL of:
- `t.categoryId == null`
- `t.transferAccountId == null`
- `t.parentId == null`
- `num(t.amount) > 0`
- account is on-budget (`account.onBudget === true`)

Replace `computeMonthIncome`'s filter with this helper. Also update
`computeCashFlow` in `reports.ts` to use the same helper, resolving the
inconsistency noted in the audit.

**Files:** `packages/logic/src/budget-engine.ts` — `computeMonthIncome` (line
390), `computePriorTBBSurplus` (line 404). `packages/logic/src/reports.ts` —
`computeCashFlow` (line 183).

#### #5 — Split parents double-counted

**Root cause:** `budget-engine.ts` is the only file in the codebase that doesn't
build a `splitParentIds` set. Every other consumer does: `reports.ts:68-71`,
`reports.ts:170-173`, `reports.ts:267-270`, `register.ts:88-91`. The parent's
`amount` is informational and should be skipped.

**Fix:** Build `splitParentIds` at the top of `computeBudget` and pass it to
`buildOutflowMap`, `buildCCBufferMap`, `buildSpendByAccountMonth`, and
`computeMonthIncome`. Skip rows where `splitParentIds.has(t.id)`.

**Files:** `packages/logic/src/budget-engine.ts` — `computeBudget` (line 54), all
four helpers.

#### #6 — Floating-point money

**Scope:** This is the most invasive fix. Every money column in the schema, every
parse/format function, and every balance mutation must switch from floats to
integer cents.

**Schema changes** (all `real()` → `integer()`):
- `accounts.balance` (line 16)
- `categories.carryover` (line 38)
- `assignments.amount` (line 53)
- `transactions.amount` (line 73)
- `recurring.amount` (line 95)
- `recurring_sub_transactions.amount` (line 116)

**`num()` in `format.ts`** (line 45): Parse as integer:
```ts
export function num(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const n = typeof s === "number" ? Math.round(s) : parseInt(String(s), 10);
  return Number.isNaN(n) ? 0 : n;
}
```

**`applyBalance` in `transactions.ts`** (line 67): Remove `toFixed(2)`:
```ts
async function applyBalance(db: Database, accountId: number, delta: number) {
  await db.update(accounts)
    .set({ balance: sql`${accounts.balance} + ${delta}` })
    .where(eq(accounts.id, accountId));
}
```

**`fmt()` in `format.ts`** (line 31): Divide by 100 for display:
```ts
export function fmt(cents: number): string {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return (cents < 0 ? "-$" : "$") + s;
}
```

**API boundary:** `getBudgetData()` in `queries/budget.ts` currently converts
`number` → `string` for the `BudgetData` type. With integer cents, the conversion
stays the same but the semantic meaning changes (cents instead of dollars). All
inputs from the UI that call server queries must also send cents.

**Migration:** Convert all existing data by multiplying money columns by 100 and
rounding. Requires a migration script that runs on startup.

**Epsilon removal:** Replace float epsilons with exact integer comparisons:
- `budget-engine.ts:146`: `tbb < -0.004` → `tbb < -1` (1 cent tolerance)
- `split.ts:70`: `Math.abs(sum - parentAmount) > 0.005` → `sum !== parentAmount`
- `split.ts:93`: same → `sum !== parentAmount`
- `queries/transactions.ts:131`: `Math.abs(sum - parentAmount) > 0.005` →
  `sum !== parentAmount`
- `reconcile.ts:131`: `Math.abs(diff) >= 0.005` → `diff !== 0`

**Files:** `packages/server/src/schema.ts`, `packages/logic/src/format.ts`,
`packages/server/src/queries/transactions.ts`,
`packages/server/src/queries/reconcile.ts`,
`packages/server/src/queries/budget.ts`, `packages/logic/src/budget-engine.ts`,
`packages/logic/src/split.ts`, `packages/logic/src/recurring.ts`,
`packages/server/src/queries/recurring.ts`, plus any UI code that passes money
values.

#### #7 — No DB transactions on money paths

**Root cause:** The codebase already knows the pattern
(`categories.ts:22-38` wraps `BEGIN`/`COMMIT`/`ROLLBACK` around
`createCategoryGroup` and `createCategory`) but only applies it to cosmetic sort
ordering.

**Fix:** Apply the same manual `BEGIN`/`COMMIT`/`ROLLBACK` bracket to these six
functions:
- `createSplitWithChildren` (transactions.ts:244)
- `updateSplit` (transactions.ts:391)
- `deleteTransaction` (transactions.ts:486)
- `updateTransaction` (transactions.ts:329)
- `reconcileAccount` (reconcile.ts:123)
- `unreconcileAccount` (reconcile.ts:216)

**Files:** `packages/server/src/queries/transactions.ts`,
`packages/server/src/queries/reconcile.ts`.

#### #8 — `|| 0` precedence bug

**Root cause:** `s + Number(c.amount) || 0` parses as
`(s + Number(c.amount)) || 0`. When `c.amount` is NaN the running sum becomes
NaN (falsy), resets to 0, and silently discards prior children.

**Fix:** In all 4 sites, validate each child's amount is finite first, then sum
without a fallback:
```ts
for (const c of children) {
  if (!Number.isFinite(c.amount)) {
    throw new Error("sub-transaction amount is not a valid number");
  }
}
const sum = children.reduce((s, c) => s + Number(c.amount), 0);
```

**Files:**
- `packages/logic/src/split.ts:92` (`validateSubTransactions`)
- `packages/logic/src/recurring.ts:201` (`validateRecurringSubTransactions`)
- `packages/server/src/queries/transactions.ts:130` (`assertSplitsBalanced`)
- `packages/server/src/queries/recurring.ts:79` (`assertSplitsBalanced`)

#### #9 — Unreconcile deletes wrong adjustment row

**Root cause:** `adjustmentRows[0]` with no `ORDER BY` returns whatever SQLite
happens to return first. In practice, the oldest adjustment row.

**Fix:** Add `ORDER BY date DESC, id DESC` and take the first:
```ts
const adjustmentRows = await db
  .select({ id: transactions.id, amount: transactions.amount })
  .from(transactions)
  .where(and(
    eq(transactions.accountId, accountId),
    eq(transactions.memo, RECONCILE_ADJUSTMENT_MEMO),
    sql`${transactions.date} <= ${lastDate}`
  ))
  .orderBy(sql`${transactions.date} DESC, ${transactions.id} DESC`)
  .limit(1);
```

**Files:** `packages/server/src/queries/reconcile.ts:249-259`.

#### #10 — Unreconcile undoes all reconciliation history

**Root cause:** The flip query matches ALL `"r"` rows with
`date <= lastReconciledAt`, which includes every reconciliation ever done.

**Fix:** Add a `reconciledAt` column (text, nullable) to the `transactions`
table. In `reconcileAccount`, stamp all flipped rows with `todayISO()`. In
`unreconcileAccount`, only flip rows where
`reconciledAt === acct.lastReconciledAt` (the most recent batch).

**Schema change:** Add `reconciledAt: text("reconciled_at")` to the
`transactions` table.

**Files:** `packages/server/src/schema.ts`,
`packages/server/src/queries/reconcile.ts`.

#### #11 — Reconcile marks future-dated rows

**Root cause:** The flip to `"r"` has no date bound — only filters on account and
status `"c"`.

**Fix:** Add `sql\`${transactions.date} <= ${todayISO()}\`` to the flip WHERE
clause.

**Files:** `packages/server/src/queries/reconcile.ts:149-155`.

#### #12 — updateTransaction breaks invariants

**Root cause:** Three create-time validations are not re-run on update:
1. Transfer category nullification: `createTransaction:173` forces
   `categoryId = null` for transfers, but `updateTransaction:339` copies
   `categoryId` through unconditionally.
2. Split child rebalancing: updating a child's amount doesn't re-check
   `assertSplitsBalanced`.
3. Self-transfer: `createTransaction:155` rejects
   `transferAccountId === accountId`, but `updateTransaction` doesn't check
   `patch.accountId === existing.transferAccountId`.

Also: `deleteTransaction:490-494` — deleting one child of a two-child split
leaves a "split" with a single child and a stale parent amount.

**Fix:**
1. In `updateTransaction`, if `existing.transferAccountId != null`, force
   `categoryId = null` in the patch (mirror `createTransaction:173`).
2. If the row is a split child (`existing.parentId != null`), after updating,
   query the parent and all siblings, re-validate with
   `assertSplitsBalanced(parent.amount, allChildren)`.
3. If `patch.accountId === existing.transferAccountId`, throw
   `TransactionError`.
4. In `deleteTransaction`, if deleting a child of a split, check remaining count.
   If 1 child remains, delete the parent too (a split with 1 child is invalid).

**Files:** `packages/server/src/queries/transactions.ts` — `updateTransaction`
(line 329), `deleteTransaction` (line 486).

#### #13 — Deleting a category rewrites history

**Root cause:** `ON DELETE SET NULL` on `transactions.categoryId` turns refunds
into uncategorised positive transactions, which match `computeMonthIncome`'s
predicate.

**Fix:** Add a dedicated `isIncome` column (boolean, default false) to the
`transactions` table. When a transaction is created, set it based on the income
rules (positive, uncategorised, non-transfer, on-budget account). `ON DELETE SET
NULL` on `categoryId` won't change this flag. `computeMonthIncome` then checks
`isIncome === true` instead of `categoryId == null`.

**Schema change:** Add `isIncome: integer("is_income", { mode: "boolean"
}).notNull().default(false)` to the `transactions` table.

**Files:** `packages/server/src/schema.ts`,
`packages/server/src/queries/transactions.ts` (insert paths),
`packages/server/src/queries/budget.ts`.

#### #14 — Running balances ignore transfers in "All Transactions"

**Root cause:** The no-anchor branch (`register.ts:107-125`) only buckets rows by
`r.accountId`. The destination side of a transfer (stored on the source account
via `transferAccountId`) is never added to the destination account's bucket.

**Fix:** In the no-anchor `else` branch, for each row also push it into the
`transferAccountId` bucket. Tag each entry with its role (source vs dest) so the
walker can apply the correct sign:
- Source account: `bal -= r.amount`
- Destination account: `bal -= -r.amount` (i.e., `bal += r.amount`)

**Files:** `packages/logic/src/register.ts:107-125`.

#### #15 — updateRecurring lockout

**Root cause:** Two bugs in `assertSplitsBalanced` (recurring.ts:67-85):
1. Requires `c.categoryId` for every child, rejecting transfer children. The
   transaction-side equivalent (`transactions.ts:123`) accepts
   `!c.categoryId && !c.transferAccountId` as the error condition. The two
   validators have different rules.
2. `categoryId` is `ON DELETE SET NULL` (schema.ts:113-115), so after a category
   is deleted, existing children have `categoryId: null`. The validation then
   throws "each sub-transaction must have a category" on every edit.

**Fix:**
1. Align `recurring.ts:74-78` with `transactions.ts:121-128`: accept transfer
   children (allow `!c.categoryId && c.transferAccountId`), reject rows with
   neither.
2. For the `ON DELETE SET NULL` case: if a child's `categoryId` is null, check if
   it has a `transferAccountId`. If neither, the child is orphaned — skip it from
   validation.

**Files:** `packages/server/src/queries/recurring.ts:67-85`.

#### #16 — Projections accuracy

**Root cause:** Three separate problems:
1. Archived accounts included: `ProjectionsView.tsx:18-20` only filters on
   `kind === "liquid"`.
2. Credit spending treated as liquid outflow: `recurring.ts:148-151` returns the
   amount for `sourceKind === "credit"`.
3. Timing averaged away: `ProjectionsView.tsx:23-29` converts every entry to a
   monthly average, ignoring `nextDate`.

**Fix:**
1. Add `&& !a.archived` to the filter.
2. Remove `sourceKind === "credit"` from the liquid flow condition — only
   `sourceKind === "liquid"` should affect liquid balance.
3. Replace the averaging approach with a month-by-month projection that uses
   `nextDate` and `frequency` to place entries at their actual dates. For each of
   the 12 months, compute which recurring entries fall in that month, sum their
   net liquid flow, and add to the running balance. This is a more significant
   rewrite of the projection logic.

**Files:** `packages/ui/src/ProjectionsView.tsx`,
`packages/logic/src/recurring.ts`.

#### #17 — 3-month average divides by 3

**Root cause:** `prior.reduce((a, b) => a + b, 0) / 3` — hard-coded divisor
regardless of how many months of data exist.

**Fix:** Change to `prior.reduce((a, b) => a + b, 0) / Math.max(prior.length, 1)`.

**Files:** `packages/logic/src/reports.ts:306`.

#### #18 — Deleting account converts transfers to income

**Root cause:** `ON DELETE SET NULL` on `transferAccountId` (schema.ts:77) turns
transfer rows into regular uncategorised rows. With the old income rule
(`categoryId == null && amount > 0`), they match as income.

**Fix:** Resolved by the `isIncome` flag from #13. Transfers are created with
`isIncome: false`, and `ON DELETE SET NULL` on `transferAccountId` doesn't
change that flag. The row remains a non-income row even after the destination
account is deleted.

**Files:** `packages/server/src/schema.ts`,
`packages/server/src/queries/transactions.ts`.

#### #19 — Dead code

**Root cause:** `computeTBB`, `computeCarryover`, `computeCCBufferForMonth`,
`computeGroups`, `summarize`, and `isSplitBalanced` are defined and exported but
never called by the application. Only tests reference them.

**Fix:** Delete all six functions and their exports. Remove from `compute.ts`.
Update or remove tests that reference them.

**Files:** `packages/logic/src/budget-engine.ts` (lines 155-222, 347-363,
461-475), `packages/logic/src/compute.ts`, `packages/logic/src/split.ts` (lines
67-71).

### Open questions

1. **Integer cents migration:** Should a migration script be created to convert
   existing `budget.db` data, or is a fresh DB acceptable? The conversion
   multiplies all money columns by 100 and rounds.

2. **`isIncome` flag (#13/#18):** The dedicated `isIncome` column is the cleanest
   fix for distinguishing income from uncategorised. The alternative is a system
   "Inflow: To Be Budgeted" category. The flag approach is simpler and doesn't
   require a special category.

3. **CC buffer vs assignment (#2):** The `ccBuffer` represents money implicitly
   moved from spending categories to the CC payment category. The user's
   `assigned` is additional money they choose to budget. `available = carryoverIn
   + assigned + rawFlow + ccBuffer` is correct — the buffer is a credit, not a
   replacement for assignment. The real bug is just #1 (buffer never draws down)
   and the TBB exclusion of CC assignments. Confirm this interpretation?

4. **Projections timing (#16 part 3):** The timing fix (using `nextDate` instead
   of averaging) is a significant rewrite. In scope for this round, or defer and
   just fix the archived accounts + credit outflow bugs?

5. **Dead code tests (#19):** Some dead functions (`computeTBB`,
   `computeCarryover`, `isSplitBalanced`) have tests. Update tests to test the
   live path instead, or just delete the tests?

### Plan Review Addendum (second-pass findings)

After deeper review of each fix against the live code, the following gaps,
refinements, and cross-cutting concerns were identified.

#### #6 — Missing pieces in integer cents migration

**`numSafe()` in `register.ts:156-160`** uses `parseFloat` and must be updated
identically to `num()`:
```ts
export function numSafe(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const n = typeof s === "number" ? Math.round(s) : parseInt(String(s), 10);
  return Number.isNaN(n) ? 0 : n;
}
```

**`round2()` in `reconcile.ts:279`** becomes a no-op after integer cents (all
values are already integers). Remove it and its call sites in
`getReconcileState`, `reconcileAccount`, `postAdjustment`.

**`evalAmount()` in `format.ts:55-246`** is an expression parser for budget
input fields. It currently evaluates to dollars. After migration, it must
evaluate to cents. The result must be multiplied by 100 and rounded, or the
interpretation of the input must change from "dollars" to "cents".

**UI input fields:** All number inputs across `packages/ui/` and `apps/web/`
that feed into server queries must send cents. This is a cross-cutting concern
touching every form and modal that creates or edits money values.

**`getBudgetData()` type conversion:** The function converts `number` → `string`
for `BudgetData`. After migration the DB values are integer cents. The conversion
stays the same syntactically but the semantic meaning changes. Downstream
consumers (budget engine, reports, register) all use `num()` to parse these
strings back to numbers — and `num()` will now return cents. This is correct as
long as `num()` is updated first.

#### #13 — Split parents could incorrectly get `isIncome = true`

A split parent row has `categoryId: null`, `parentId: null`,
`transferAccountId: null`. If the parent's amount is positive and the account is
on-budget, the `isIncome` determination logic would incorrectly flag it as
income.

**Fix:** In `createSplitWithChildren`, explicitly set `isIncome: false` on the
parent row. Split parents are created only via `createSplitWithChildren`, not
`createTransaction`, so this single-site fix is sufficient.

#### #4 — `computeCashFlow` does NOT need updating

The audit notes an inconsistency between `computeMonthIncome` and
`computeCashFlow`. These serve different purposes:
- `computeMonthIncome` = "money available to budget" (uncategorised inflows on
  on-budget accounts)
- `computeCashFlow` = "all money in vs all money out" (all non-transfer
  transactions on all accounts)

`computeCashFlow` already correctly excludes transfers. It should NOT exclude
off-budget accounts (cash flow tracks all money movement). Once transfers are
excluded from `computeMonthIncome` via the `isIncome` flag, the inconsistency is
resolved. No change needed to `computeCashFlow`.

#### #1 — Refined CC buffer fix

**Refund handling:** The current code has `if (amt >= 0) continue` which skips
positive categorised rows. Removing this guard alone is sufficient — for a refund
(`amt > 0`), `(-amt)` is negative, which correctly reduces the buffer. The
`(-amt)` expression already handles both signs correctly.

**Payment detection (second pass):** After the existing loop that sums
categorised spend, add a second pass that identifies transfers TO the linked
credit account:
```ts
for (const t of data.transactions) {
  if (!t.date.startsWith(month)) continue;
  if (t.transferAccountId == null) continue;
  if (splitParentIds.has(t.id)) continue;
  for (const [catId, linkedAccId] of ccPayCatToAccount) {
    if (t.transferAccountId === linkedAccId) {
      spendByAccount.set(linkedAccId, (spendByAccount.get(linkedAccId) ?? 0) - Math.abs(num(t.amount)));
    }
  }
}
```

Both `buildCCBufferMap` and `buildSpendByAccountMonth` need both fixes.

#### #8 — Error type differences between call sites

The four sites have different error mechanisms:
- `split.ts` (logic): `validateSubTransactions` returns `string | null` — the NaN
  check must return an error string, not throw.
- `recurring.ts` (logic): `validateRecurringSubTransactions` also returns
  `string | null`.
- `transactions.ts` (server): `assertSplitsBalanced` throws `TransactionError`.
- `recurring.ts` (server): `assertSplitsBalanced` throws `RecurringError`.

The finite check must use the appropriate error mechanism at each site.

#### #10 — Adjustment row needs explicit `reconciledAt` stamp

The `postAdjustment` function inserts the adjustment row with `status: "c"` and
does NOT flip it to `"r"` (it stays cleared for the next reconciliation). So it
won't get `reconciledAt` stamped by the flip step. Without `reconciledAt`, the
`unreconcileAccount` query can't identify which adjustment row belongs to the
current batch.

**Fix:** In `postAdjustment`, explicitly set `reconciledAt: todayISO()` on the
adjustment row. Then in `unreconcileAccount`, filter adjustment rows by
`reconciledAt === acct.lastReconciledAt` (not by date + memo alone). This also
makes the ORDER BY from #9 unnecessary (the `reconciledAt` filter uniquely
identifies the batch), but ORDER BY is still defensive.

**Combined #10 + #11 query in `reconcileAccount`:**
```ts
const today = todayISO();
const flip = await db
  .update(transactions)
  .set({ status: "r", reconciledAt: today })
  .where(and(
    eq(transactions.accountId, input.accountId),
    eq(transactions.status, "c"),
    sql`${transactions.date} <= ${today}`
  ))
  .returning({ id: transactions.id });
```

**Combined #9 + #10 query in `unreconcileAccount`:**
```ts
const flipped = await db
  .update(transactions)
  .set({ status: "c", reconciledAt: null })
  .where(and(
    eq(transactions.accountId, accountId),
    eq(transactions.status, "r"),
    eq(transactions.reconciledAt, lastDate)
  ))
  .returning({ id: transactions.id });

const adjustmentRows = await db
  .select({ id: transactions.id, amount: transactions.amount })
  .from(transactions)
  .where(and(
    eq(transactions.accountId, accountId),
    eq(transactions.memo, RECONCILE_ADJUSTMENT_MEMO),
    eq(transactions.reconciledAt, lastDate)
  ))
  .orderBy(sql`${transactions.date} DESC, ${transactions.id} DESC`)
  .limit(1);
```

#### #12 — Child delete: avoiding double-reversal

When deleting a child that leaves the parent with 0 or 1 remaining children, the
parent must be deleted too. But the parent's delete handler in `deleteTransaction`
queries ALL children and reverses their balances — including the already-deleted
child's balance, which was already reversed in the child branch. This would
double-reverse.

**Fix:** Handle the cleanup inline in the child branch of `deleteTransaction`,
after deleting the child but before returning:
```ts
if (existing.parentId != null) {
  // Reverse deleted child's balance
  await applyBalance(db, existing.accountId, -Number(existing.amount));
  if (existing.transferAccountId != null) {
    await applyBalance(db, existing.transferAccountId, Number(existing.amount));
  }
  // Delete the child
  await db.delete(transactions).where(eq(transactions.id, id));
  // Check if parent is now orphaned
  const remaining = await getChildren(db, existing.parentId);
  if (remaining.length === 0) {
    await db.delete(transactions).where(eq(transactions.id, existing.parentId));
  } else if (remaining.length === 1) {
    const lastChild = remaining[0]!;
    await applyBalance(db, lastChild.accountId, -Number(lastChild.amount));
    if (lastChild.transferAccountId != null) {
      await applyBalance(db, lastChild.transferAccountId, Number(lastChild.amount));
    }
    await db.delete(transactions).where(eq(transactions.id, existing.parentId));
  }
  return existing;
}
```
The parent delete cascades the remaining child, whose balance was already
reversed above. No double-reversal.

#### #14 — Register walker needs role tagging

The no-anchor branch must distinguish source vs destination role for each row.
The walker at `register.ts:119-123` does `bal -= r.amount`, which is correct for
the source account. For the destination account, the delta is `-r.amount`.
Tagging entries with their role ensures the correct sign is applied:

```ts
for (const r of parsed) {
  if (parentIds.has(r.id)) continue;
  // Source account
  let srcList = byAccount.get(r.accountId);
  if (!srcList) { srcList = []; byAccount.set(r.accountId, srcList); }
  srcList.push(r);
  // Destination account (transfers only)
  if (r.transferAccountId != null) {
    let destList = byAccount.get(r.transferAccountId);
    if (!destList) { destList = []; byAccount.set(r.transferAccountId, destList); }
    destList.push(r); // same row, but walker must apply -r.amount
  }
}
```

Then in the walker, determine the delta per row based on whether
`r.accountId === acctId` (source) or `r.transferAccountId === acctId`
(destination), mirroring the anchored branch logic at `:100-104`.

### Cross-cutting concerns

**Migration ordering:** The integer cents migration (#6) must run before the
`isIncome` backfill (#13) because the backfill checks `amount > 0` which will be
in cents after migration.

**Type changes:** Adding `isIncome?: boolean` and `reconciledAt?: string | null`
to the `Transaction` type in `types.ts`. Both are optional for backward
compatibility during migration. `isIncome` is read-only after creation;
`reconciledAt` is managed by the system.

**API boundary:** Neither `isIncome` nor `reconciledAt` should be exposed in
update endpoints. They are determined by the system at insert time and during
reconciliation.

**Test strategy:** Each fix phase should add at least one test that would have
failed before the fix. The existing 304 tests should continue to pass (or be
updated if they encode buggy behaviour). The dead functions in #19 have tests in
`packages/logic/tests/budget-engine.test.ts`, `split.test.ts`, and possibly
`compute.test.ts` — these must be handled when deleting.

**Risk assessment:** Phase 1 (#6 + #7) is the highest-risk phase due to the
integer cents migration touching every money path. Recommended: do it on a
feature branch with full test coverage verification after each sub-step.

### Summary of new concerns

| Concern | Severity | Phase |
|---------|----------|-------|
| `evalAmount()` needs cents conversion | High | #6 |
| `round2()` becomes no-op, remove or update | Medium | #6 |
| `numSafe()` needs same update as `num()` | Medium | #6 |
| UI input fields need cents conversion | High | #6 |
| Split parents could get `isIncome = true` | Medium | #13 |
| Adjustment row needs explicit `reconciledAt` stamp | Medium | #10 |
| Child delete needs remaining-count check to avoid double-reversal | Medium | #12 |
| `computeCashFlow` does NOT need updating (resolved by design) | None | #4 |
| Logic-layer validators return strings, server-layer throws | Low | #8 |
| Register walker needs role tagging for correct sign | Low | #14 |
| Dead code tests need handling before deletion | Low | #19 |
| Migration ordering: #6 must precede #13 | — | Cross |
| Projections timing rewrite deferred | Low | #16 |

---

## Index

| # | Severity | Issue | Primary location |
|---|----------|-------|------------------|
| 1 | Critical | Credit-card payment category never draws down | `budget-engine.ts:331` |
| 2 | Critical | Assignments to CC categories are free (TBB unaffected) | `budget-engine.ts:137,420` |
| 3 | Critical | Off-budget inflows inflate To Be Budgeted | `budget-engine.ts:390` |
| 4 | Critical | Transfers counted as income | `budget-engine.ts:390` |
| 5 | Critical | Split parents double-counted | `budget-engine.ts:307,331,390` |
| 6 | Critical | Money stored as IEEE-754 doubles; drift accumulates | `schema.ts:16,38,53,73` |
| 7 | Critical | No DB transaction on any multi-write money path | `queries/transactions.ts`, `reconcile.ts` |
| 8 | High | `\|\| 0` precedence bug lets NaN pass split validation | 4 sites |
| 9 | High | Unreconcile deletes an arbitrary adjustment row | `reconcile.ts:249` |
| 10 | High | Unreconcile undoes *all* reconciliation history | `reconcile.ts:230` |
| 11 | High | Reconcile marks future-dated rows as reconciled | `reconcile.ts:149` |
| 12 | High | `updateTransaction` can break invariants create-time enforces | `queries/transactions.ts:329` |
| 13 | High | Deleting a category rewrites closed-month budget history | `schema.ts:67` |
| 14 | Medium | "All Transactions" running balances ignore transfers | `register.ts:107` |
| 15 | Medium | `updateRecurring` permanently locks out edits | `queries/recurring.ts:206` |
| 16 | Medium | Projections treat credit spend as liquid, include archived | `ProjectionsView.tsx:18` |
| 17 | Low | 3-month average divides by 3 regardless of data | `reports.ts:306` |
| 18 | Low | Deleting an account silently converts transfers to income | `schema.ts:77` |
| 19 | Note | Dead duplicates of the buggy logic | `budget-engine.ts:155,186,461` |

---

## Critical

### 1. The credit-card buffer never draws down [verified]

**Where:** `packages/logic/src/budget-engine.ts:322-345` (`buildCCBufferMap`),
also `:369-383` (`buildSpendByAccountMonth`) for the carryover chain.

**What happens:** Charge $100 of groceries to a Visa, then pay the Visa in full
from checking. The "Visa Payment" category still reports **$100 available**.

**Why:** The buffer is credited from categorised negative rows on the linked
account:

```ts
// budget-engine.ts:331-337
for (const t of data.transactions) {
  if (!t.date.startsWith(month)) continue;
  if (t.categoryId == null) continue;      // ← transfers are excluded here
  const amt = num(t.amount);
  if (amt >= 0) continue;
  spendByAccount.set(t.accountId, ... + (-amt));
}
```

A card payment is a transfer, and `createTransfer` forces `categoryId` to null
(`queries/transactions.ts:222`). So the payment is invisible to this function,
and nothing else decrements the CC category — `available` is
`carryoverIn + assigned + rawFlow + ccBuffer` (`:99`) and the payment appears in
none of those terms. The bucket is a one-way ratchet that grows with every
charge, forever, across the whole carryover chain.

A related asymmetry: refunds on the card are skipped by `if (amt >= 0) continue`,
so a returned purchase reduces the grocery category's spend but never reduces
the buffer it created.

**Fix:** Treat a transfer whose `transferAccountId` is the linked credit account
as a debit to that CC payment category, and let positive categorised rows on the
card reduce the buffer rather than being skipped.

---

### 2. Money assigned to a CC payment category is free [verified]

**Where:** `budget-engine.ts:136-139` and `:413-421`.

**What happens:** With $1,000 income, assigning **$999,999** to the Visa Payment
category leaves `tbb === 1000` and `overBudgeted === false`.

**Why:** CC groups are excluded from the assigned total in both the current month
and the prior-surplus chain:

```ts
// :136-139
const totalAssigned = groups
  .filter((g) => !ccGroupIds.has(g.group.id))   // ← CC assignments cost nothing
  .reduce((s, g) => s + g.assigned, 0);

// :420
if (ccCatIds.has(a.categoryId)) continue;       // ← same exclusion in the chain
```

Assigning to a credit-card payment category is real budgeting and must reduce
TBB. Compounding this, `:99` adds *both* the user's assignment and the automatic
buffer to `available`, whereas in YNAB4 the automatic transfer **is** the
assignment — so funded CC categories are double-counted.

**Fix:** Include CC assignments in `totalAssigned`, and decide explicitly whether
the auto-buffer is an implicit assignment (then don't add it on top) or a
separate credit (then it must be excluded from `available`'s assignment term).

---

### 3. Off-budget inflows inflate To Be Budgeted [verified]

**Where:** `budget-engine.ts:390-396` (`computeMonthIncome`).

**What happens:** A $5,000 dividend recorded in a brokerage account with
`kind: "offbudget"` / `onBudget: false` raises TBB by $5,000.

**Why:** The function filters only on date, null category, and positive amount.
It never joins to `accounts` and never checks `onBudget`:

```ts
.filter((t) => t.date.startsWith(month) && t.categoryId == null && num(t.amount) > 0)
```

Off-budget is the one account flag whose entire purpose is to keep money out of
the budget, and it is not consulted.

---

### 4. Transfers are counted as income [verified]

**Where:** same function, `budget-engine.ts:390-396`.

**What happens:** Transferring $2,000 from brokerage into checking raises TBB by
$2,000. Every inbound transfer is fabricated income.

**Why:** Transfers carry `categoryId == null` by design
(`queries/transactions.ts:222`), which is exactly the predicate this function
uses to *identify* income. There is no `transferAccountId == null` guard.

Note the internal inconsistency: `reports.ts:183` in `computeCashFlow` **does**
guard on `t.transferAccountId == null`. Two functions in the same codebase
disagree about what income is, so the Budget screen and the Cash Flow report can
show different numbers for the same month.

**Fix for 3 + 4:** define income once, in one helper, as
*positive, uncategorised, non-transfer, non-split-parent rows in an on-budget
account*, and have both call sites use it.

---

### 5. Split parents are double-counted [verified]

**Where:** `budget-engine.ts:307-315` (`buildOutflowMap`), `:322-345`
(`buildCCBufferMap`), `:390-396` (`computeMonthIncome`), `:369-383`.

**What happens:** A $3,000 paycheck entered as a split (children: +$3,200 salary,
−$200 deduction) reports `totalIncome` of **$6,200**.

**Why:** The parent row's `amount` is informational — the type contract
(`types.ts:47-56`) and the server (`queries/transactions.ts:265-278`, which
inserts the parent without applying balance) both say only children count. Every
other consumer honors this by building a `splitParentIds` set first:

- `reports.ts:68-71` (net worth) ✓
- `reports.ts:170-173` (cash flow) ✓
- `reports.ts:267-270` (insights) ✓
- `register.ts:88-91` (running balance) ✓
- `budget-engine.ts` ✗ — the only file that omits it

So the parent is summed alongside its children in income, in per-category
outflow, and in the CC buffer.

**Fix:** Build the same `splitParentIds` set in `computeBudget` and skip those
rows in all four helpers.

---

### 6. Money is stored and accumulated as floating point [verified]

**Where:** `packages/server/src/schema.ts:16` (`accounts.balance`), `:38`
(`categories.carryover`), `:53` (`assignments.amount`), `:73`
(`transactions.amount`), `:95`, `:116`. Parsed via `parseFloat` in
`format.ts:45-49` (`num`) and `register.ts:156-160` (`numSafe`).

**What happens:** Ten −$0.10 charges sum to `-0.9999999999999999`, not `-1`.

**Why:** `real()` is an IEEE-754 double. Worse, the account balance is a
*denormalized running total* mutated incrementally in SQL:

```ts
// queries/transactions.ts:67-72
await db.update(accounts)
  .set({ balance: sql`${accounts.balance} + ${delta.toFixed(2)}` })
```

so error is written back to disk and compounds permanently rather than being
recomputed from source rows. Reconciliation is then built on that drifting field
(`reconcile.ts:84-87` derives the working balance from `acct.balance`).

The epsilons scattered through the code are symptoms of this, not solutions:
`budget-engine.ts:146` (`tbb < -0.004`), `split.ts:70`, `split.ts:93`,
`queries/transactions.ts:131`, `reconcile.ts:131`.

**Fix:** Store integer cents (or minor units) end to end — schema, `num()`,
`applyBalance`, and the API boundary. This is the foundation; several other fixes
get simpler once amounts are exact. Requires a migration over existing data.

---

### 7. No database transaction on any money path [read]

**Where:** `queries/transactions.ts:244-312` (`createSplitWithChildren`),
`:391-474` (`updateSplit`), `:486-514` (`deleteTransaction`), `:329-383`
(`updateTransaction`), `reconcile.ts:123-169`, `:216-277`.

**What happens:** Each of these issues many sequential writes with no
`BEGIN`/`COMMIT`. `updateSplit` reverses every old child's balance, deletes the
children, updates the parent, then re-inserts new children — a crash or thrown
error at any point leaves account balances permanently wrong with no way for the
app to detect it.

**Why it stands out:** the codebase already knows the pattern. `queries/categories.ts:22-38`
wraps a `BEGIN`/`COMMIT` around a `SELECT max(sort)` + `INSERT`, with a comment
explaining that better-sqlite3's `db.transaction()` wrapper doesn't survive
`await` and manual bracketing is required. That protection is applied to
cosmetic sort ordering and to nothing that touches money.

**Fix:** Apply the same manual `BEGIN`/`COMMIT`/`ROLLBACK` bracket from
`categories.ts` to the six functions above.

---

## High

### 8. `|| 0` precedence bug: NaN passes split validation [verified]

**Where — four copies of the same line:**

- `packages/logic/src/split.ts:92` (`validateSubTransactions`, used by the UI at `Modals.tsx:132`)
- `packages/logic/src/recurring.ts:201` (`validateRecurringSubTransactions`)
- `packages/server/src/queries/transactions.ts:130` (`assertSplitsBalanced` — the server-side authority)
- `packages/server/src/queries/recurring.ts:79` (`assertSplitsBalanced`)

```ts
const sum = children.reduce((s, c) => s + Number(c.amount) || 0, 0);
```

**What happens:** `validateSubTransactions(30, [{amount: NaN}, {amount: 30}])`
returns `null` — i.e. "valid".

**Why:** `+` binds tighter than `||`, so this parses as `(s + Number(c.amount)) || 0`.
When a child amount is NaN the running sum becomes NaN, which is falsy, so the
accumulator silently **resets to 0** and the preceding children are discarded.
The remaining children can then coincidentally match the parent.

The intended guard was presumably `s + (Number(c.amount) || 0)`, but that is also
wrong — it would silently treat a bad amount as zero. A NaN child should be a
hard validation error.

**Fix:** Validate each child is finite first, then sum without a fallback.

---

### 9. Unreconcile deletes an arbitrary adjustment row [read]

**Where:** `packages/server/src/queries/reconcile.ts:249-259`.

```ts
const adjustmentRows = await db.select(...)
  .where(and(
    eq(transactions.accountId, accountId),
    eq(transactions.memo, RECONCILE_ADJUSTMENT_MEMO),
    sql`${transactions.date} <= ${lastDate}`
  ));
const adjustment = adjustmentRows[0];   // ← no ORDER BY
```

**What happens:** Adjustment rows from *every* past reconciliation persist in the
table and all match this predicate. With no `ORDER BY`, `[0]` is whatever SQLite
returns first — in practice the oldest. Unreconciling then deletes that row and
reverses its balance (`:263-267`), corrupting a historical month and the account
balance instead of undoing the most recent reconciliation.

**Fix:** Order by `date DESC, id DESC` and take the first, or tag adjustment rows
with the reconciliation batch that created them.

---

### 10. Unreconcile undoes the entire reconciliation history [read]

**Where:** `reconcile.ts:230-242`.

```ts
.where(and(
  eq(transactions.accountId, accountId),
  eq(transactions.status, "r"),
  sql`${transactions.date} <= ${lastDate}`     // ← every "r" row ever
))
```

**What happens:** "Unreconcile" flips *all* reconciled rows dated on or before
`lastReconciledAt` back to cleared — that is, every reconciliation the account
has ever had, not the last one. After one accidental click the account's entire
reconciliation state is gone and cannot be recovered from the data.

**Fix:** Record the reconciliation batch (a `reconciled_at` stamp per row, or a
reconciliation table) and scope the flip to the most recent batch.

---

### 11. Reconcile marks future-dated transactions as reconciled [read]

**Where:** `reconcile.ts:149-155`.

The flip to `"r"` filters on account and `status = 'c'` with no date bound. A
transaction dated next month — which by definition cannot appear on the
statement being reconciled — is marked reconciled and locked.

**Fix:** Bound the flip by the statement date.

---

### 12. `updateTransaction` can break invariants that create-time enforces [read]

**Where:** `queries/transactions.ts:329-383`.

Three invariants are validated on insert but not on update:

1. **A transfer can be given a category.** `:339` copies `categoryId` through
   unconditionally, while `createTransaction:173` forces it to null for
   transfers. Once set, the row is picked up as categorised spend by
   `buildOutflowMap` and `buildCCBufferMap`.
2. **A split child's amount can be changed without re-checking the parent.**
   `:370-379` applies the balance delta and returns; `assertSplitsBalanced` is
   never called. The parent's `amount` then disagrees with the sum of its
   children, and `isSplitBalanced` (`split.ts:67`) reports the split as broken
   with no way for the user to have caused it deliberately.
3. **A transfer can be made to point at itself.** `patch.accountId` can be set to
   the row's own `transferAccountId`; `createTransaction:155` and
   `createTransfer:208` both reject this, `updateTransaction` does not.

The same gap exists in `deleteTransaction:490-494`: deleting one child of a
two-child split leaves a "split" with a single child and a stale parent amount.

**Fix:** Re-run the create-time assertions in the update and delete paths.

---

### 13. Deleting a category rewrites closed-month budget history [read]

**Where:** `schema.ts:67-69` — `transactions.categoryId` is
`ON DELETE SET NULL`; `queries/categories.ts:103-105` (`deleteCategory`).

**What happens:** Deleting a category nulls the `categoryId` of every
transaction that used it. Any **refund** in that category (a positive amount) now
matches `computeMonthIncome`'s predicate exactly — positive and uncategorised —
and is counted as **new income** in a month that was already closed. TBB for that
month and every month after it changes retroactively.

`ON DELETE SET NULL` is the right choice for not destroying history; the bug is
that "uncategorised" doubles as the marker for income (see #4).

**Fix:** Distinguish income explicitly (a dedicated flag, or an "Inflow: To Be
Budgeted" category) rather than inferring it from a null category.

---

## Medium

### 14. "All Transactions" running balances ignore transfers [read]

**Where:** `packages/logic/src/register.ts:107-125`.

The single-account branch (`:96-106`) correctly handles a row where the anchor
account is the transfer *destination*, applying the amount with the opposite
sign. The no-anchor branch does not — it buckets rows only by `r.accountId`:

```ts
for (const r of parsed) {
  if (parentIds.has(r.id)) continue;
  let list = byAccount.get(r.accountId);   // ← destination side never added
  ...
}
```

Since a transfer is stored as a single row on the source account
(`types.ts:47-52`), the destination account's walk never sees it. In the
"All Transactions" view, every row older than an inbound transfer shows a
running balance that is off by that transfer's amount.

**Fix:** In the no-anchor branch, also push the row into the
`transferAccountId` bucket with its sign flipped, mirroring `:104`.

---

### 15. `updateRecurring` can permanently lock out edits [read]

**Where:** `queries/recurring.ts:194-208`, validating via `:67-85`.

Editing the `amount` of a recurring split re-validates the *existing* children:

```ts
assertSplitsBalanced(Number(patch.amount), existingChildren);
```

but that helper requires every child to have a category (`:74-78`), while
`recurring_sub_transactions.categoryId` is `ON DELETE SET NULL` by design
(`schema.ts:113-115`, with a comment explaining exactly this). Once any category
used by a recurring split is deleted, the entry's amount can never be edited
again — it throws "each sub-transaction must have a category" on every attempt.

Separately, this helper rejects transfer children (`if (!c.categoryId)`) whereas
the transaction-side equivalent accepts them
(`queries/transactions.ts:123`: `if (!c.categoryId && !c.transferAccountId)`),
so recurring splits and transaction splits have different rules.

---

### 16. Projections model liquid cash incorrectly [read]

**Where:** `packages/ui/src/ProjectionsView.tsx:18-41`; `logic/src/recurring.ts:96-152`.

Three separate problems in the "12-Month Liquid Balance Forecast":

1. **Archived accounts are included.** `:18-20` filters on `kind === "liquid"`
   only. `Sidebar.tsx:49` excludes archived accounts from its totals, so the
   sidebar and the projection disagree about current liquid balance.
2. **Credit-card spending is treated as an immediate liquid outflow.**
   `recurring.ts:148-151` returns the amount when the source account is
   `"credit"`. Charging a card does not reduce cash until the card is paid, and
   if the payment is *also* a recurring transfer it is subtracted twice.
3. **Timing is averaged away.** `:23-29` converts every entry to an average
   monthly figure via `frequencyMonthlyMultiplier`, so an annual insurance bill
   is smoothed to 1/12 per month and `nextDate` is ignored entirely. The chart
   therefore never shows the dip it exists to warn about, and the "Change" column
   (`:220`) prints the same constant for every month.

The multiplier table itself (`recurring.ts:27-65`) is arithmetically correct.

---

## Low

### 17. 3-month average divides by 3 regardless of available data [read]

**Where:** `packages/logic/src/reports.ts:303-321`.

```ts
const avg3mo = prior.reduce((a, b) => a + b, 0) / 3;
```

`prior` is an array of individual **transaction** amounts across up to three
months, and the divisor is hard-coded. A category with only one prior month of
history has its baseline understated by up to 3×, producing large phantom
"+200% vs 3-mo avg" spikes for anything recently created. Affects the insights
panel only (`BudgetApp.tsx:230`), not budget math.

---

### 18. Deleting an account converts its transfers into income [read]

**Where:** `schema.ts:77` — `transferAccountId` is `ON DELETE SET NULL`;
`queries/accounts.ts:61-63`.

Deleting account B cascades away rows whose `accountId` is B, but rows on other
accounts that *transferred to* B survive with `transferAccountId` nulled. They
are now positive, uncategorised, non-transfer rows — indistinguishable from
income under #4's rule. Account balances stay self-consistent; the budget does
not.

---

### 19. Dead code duplicating the buggy logic [read]

**Where:** `budget-engine.ts:155-169` (`computeTBB`), `:186-222`
(`computeCarryover`), `:461-463` (`computeGroups`), `:468-475` (`summarize`),
`:347-363` (`computeCCBufferForMonth`), `split.ts:67-71` (`isSplitBalanced`).

A grep across `packages/*/src` and `apps/web/src` shows none of these are called
by the application — only defined, re-exported (`compute.ts:8`), and tested.
They reimplement the same rules as the live path, so every fix above must either
be applied twice or these should be deleted. `computeCarryover` is additionally
O(months × transactions) where the live `buildCarryoverMap` is not.

---

## Revised fix order

1. **#6 + #7 together** (integer cents + DB transactions)
   - Both rewrite the same write paths. Integer cents is the foundation — every
     other fix gets simpler when amounts are exact.
   - DB transactions must be added to the same functions that #6 touches.
   - **Scope:** ~10 files, schema migration, all money columns.

2. **#13 + #18** (dedicated `isIncome` flag)
   - Add the `isIncome` column to schema. This is a prerequisite for the shared
     income predicate in step 3. Doing it now avoids reworking the income logic
     twice.
   - **Scope:** schema.ts, transactions.ts (insert paths), budget.ts.

3. **#3 + #4 + #5** (shared income predicate + split parent filtering)
   - With the `isIncome` flag in place, `computeMonthIncome` becomes a simple
     filter on `isIncome === true`. Add `onBudget` and `transferAccountId`
     guards. Add split parent filtering to all budget-engine helpers.
   - **Scope:** budget-engine.ts (4 helpers), reports.ts (align computeCashFlow).

4. **#1 + #2** (credit-card model)
   - #1: detect card payments in buffer calculation.
   - #2: include CC assignments in TBB calculation.
   - **Scope:** budget-engine.ts (buildCCBufferMap, buildSpendByAccountMonth,
     computeBudget, computePriorTBBSurplus).

5. **#8** (split validation)
   - Mechanical: 4 sites, add finite check, remove `|| 0` fallback.
   - **Scope:** split.ts, recurring.ts (logic), transactions.ts, recurring.ts
     (server).

6. **#9 + #10 + #11** (reconciliation)
   - #9: ORDER BY on adjustment query.
   - #10: Add `reconciledAt` column, scope unreconcile to most recent batch.
   - #11: Add date bound to reconcile flip.
   - **Scope:** schema.ts, reconcile.ts.

7. **#12** (updateTransaction invariants)
   - Re-run create-time validations in update/delete paths.
   - **Scope:** transactions.ts (updateTransaction, deleteTransaction).

8. **#14 + #15 + #16 + #17** (medium/low)
   - #14: register.ts no-anchor branch transfer fix.
   - #15: align recurring split validation with transactions.
   - #16: ProjectionsView archived filter + credit outflow fix. Timing fix
     (larger rewrite — may defer).
   - #17: one-line fix in reports.ts.

9. **#19** (dead code cleanup)
   - Delete after all other fixes are verified, since some tests reference these
     functions.
   - **Scope:** budget-engine.ts, compute.ts, split.ts, test files.

Recommended alongside: tests that assert the *intended* behavior for each of the
seven verified findings, since the current suite passes with all of them present.

## Not covered

UI/rendering, accessibility, the YNAB4 importer (`import-ynab4.ts`), the
migration bootstrap, performance under large datasets, and anything related to
multi-user or network access.
