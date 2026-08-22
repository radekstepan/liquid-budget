# Bugs & Logic Inconsistencies

Findings from a full review of the core logic (`packages/logic`, `packages/server`, API routes),
2026-08-22. Ordered by area; severity noted per item. Line numbers refer to current `master` (663daac).

Legend: 🔴 data corruption / wrong money · 🟠 wrong results displayed · 🟡 latent / edge-case

---

## 1. Budget engine (`packages/logic/src/budget-engine.ts`)

### 1.1 🔴 CC-buffer math ignores transfer direction — money vanishes on inflow-oriented transfer rows
**Where:** `budget-engine.ts:211-225` (`buildBudgetIndex`) and the duplicated copy at `:349-363` (`getOrBuildIndex`).

Transfers are stored as a single row with a signed amount, and the UI/API accept either
orientation. The code does `spend[transferAccountId] -= Math.abs(amt)` **unconditionally**
(regardless of which way the money moves), and when `amt > 0` additionally
`spend[accountId] -= amt`.

Failure: a transfer *from* a credit card (cash advance / balance transfer) recorded as
`accountId=Checking, transferAccountId=Visa, amount=+10000` subtracts 10000 from the Visa
spend map — the Visa Payment category's available drops $100 even though Visa debt just
*increased*. Recording the same economic event from the Visa register leaves the buffer
untouched. Results depend on which register the user typed the transfer in; CC→CC balance
transfers are half-handled (destination drawn down, source never increased).

**Fix:** determine the receiving account (`amt < 0 ? transferAccountId : accountId`) and apply
a single `spend[receiving] -= Math.abs(amt)`; delete the unconditional subtraction and the
`amt > 0` double-subtraction. Apply in both copies of the indexing code (or deduplicate them).

### 1.2 🔴 Categorized transactions on off-budget accounts flow into budget categories
**Where:** `budget-engine.ts:186-192` / `:324-331` (outflow indexing); write path
`packages/server/src/queries/transactions.ts` (no on-budget guard); UI does not hide the
category picker for off-budget accounts.

The income path excludes off-budget accounts (`isIncomeTransaction`, `:68-74`), but
`outflowByMonth` aggregates every transaction with a `categoryId` from *any* account. A $100
brokerage transaction categorized to Groceries reduces Groceries' available and can deduct
from next month's TBB with zero on-budget cash movement — breaking the app's own integrity
invariant (on-budget balances − available − TBB = 0).

**Fix:** skip `categoryId` aggregation for transactions on `!onBudget` accounts (the
`accountMap` is already in scope at both index-build sites), and/or reject categories on
off-budget transactions at write time.

### 1.3 🟠 `overspentPrevious` reports the last month *with data*, not the previous calendar month
**Where:** `budget-engine.ts:535-537, 546-548, 600-602`.

`mostRecentPrior` is the last data-bearing month before the target. If June overspends $2,000
and July/August have no activity, `computeBudget(data, "2025-08").overspentPrevious` still
returns 200000 and the Inspector shows "Overspent last month: $2,000" forever until new data
appears. (TBB itself is correct — it uses the cumulative surplus.)

**Fix:** only return the stored overspend when `mostRecentPrior` equals the calendar month
immediately before `targetMonth`; otherwise 0.

### 1.4 🟠 TBB doc/UI formula double-counts the overspend deduction
**Where:** `packages/logic/src/types.ts:222-227` (doc comment),
`packages/ui/src/Inspector.tsx:254` (tooltip breakdown); engine: `budget-engine.ts:480-483,
701-709`.

The engine's `priorSurplus` **already** subtracts each prior month's overspend
(`computePriorTBBSurplus`, `:706`), and `tbb = income − assigned + priorSurplus`. The types.ts
doc claims `tbb = income − assigned + priorSurplus − overspentPrevious`, and the Inspector
tooltip lists "Prior surplus" and "Overspent last month" as separate line items summing to
"= TBB" — the lines don't add up to the displayed TBB (off by exactly the overspend). Also
stale: `types.ts:233-234` claims `totalAssigned` covers "all non-CC groups"; the code includes
CC assignments.

**Fix:** remove "Overspent last month" from the tooltip sum (or show priorSurplus before the
deduction); correct both doc comments.

### 1.5 🟡 Explicit `isIncome: true` + `categoryId` counts the same dollars twice
**Where:** `budget-engine.ts:61-62`; server accepts client `isIncome` verbatim
(`queries/transactions.ts:235`, `:515-523`).

`isIncomeTransaction` returns immediately on `isIncome === true`, skipping the
`categoryId == null` check. `{amount:+5000, categoryId:7, isIncome:true}` adds $50 to TBB
*and* $50 to category 7. The bundled UI never sends this, but the API accepts it silently.

**Fix:** server-side, force `isIncome = false` (or 422) when `categoryId != null`; optionally
also check `categoryId` in `isIncomeTransaction` even when `isIncome` is explicit.

### 1.6 🟡 Transfers from off-budget into the budget never reach TBB
**Where:** `budget-engine.ts:64-65` (`transferAccountId != null` → never income);
`queries/transactions.ts:309` (`isIncome: false` hard-coded for transfers).

Moving $10,000 from an off-budget brokerage into Checking raises on-budget balances with no
TBB effect — the integrity invariant silently breaks by $10,000. In YNAB4, inflow transfers
crossing the budget boundary are new money and must be categorized/counted as income.

**Fix:** treat off-budget→on-budget transfers as income to TBB (and on-budget→off-budget as
categorized outflow), or force categorization for boundary-crossing transfers.

### 1.7 🟡 `getBudgetData({ limitTransactions })` builds the authoritative index from truncated history
**Where:** `packages/server/src/queries/budget.ts:18-27, 87`.

With `limitTransactions` set, only the N newest transactions load, yet `buildBudgetIndex` runs
on the truncated set and is serialized as the trusted `budgetIndex` — carryover is cumulative,
so every month would be wrong. No in-repo caller passes the option today; loaded footgun.

**Fix:** build the index from the full set before truncating, or remove the option.

---

## 2. Transactions, splits, transfers (`packages/server/src/queries/transactions.ts`)

### 2.1 🔴 Deleting one child of a 3+-child split leaves the parent amount stale; bulk path worse
**Where:** `transactions.ts:710-728` (`deleteTransaction`), `:780-786`
(`bulkDeleteTransactions`).

Deleting a child reverses its balance and collapses a 1-child remainder, but with ≥2 children
remaining the parent's `amount` is never re-totaled (parent −10000, children now sum −8000).
Every later child edit then throws "split children do not sum to parent" (`:532`) and
`updateSplit` demands the stale total (`:598`) — the split is bricked. The bulk path deletes a
child with **no** re-total *and* no 1-child collapse, so it can also leave an invalid
single-child split.

**Fix:** after any child deletion, `UPDATE parent SET amount = sum(remaining children)`; port
the collapse (and re-total) logic to `bulkDeleteTransactions`.

### 2.2 🔴 Split-parent deletion reverses child balances against the wrong account
**Where:** `transactions.ts:743` (uses `existing.accountId`, the parent's account) vs `:722`
(the 1-child collapse correctly uses `lastChild.accountId`); enabled by `:483-490` — the
"cannot change account" guard covers only parents, so `updateTransaction` lets a *child* move
to a different account (`:503-509`).

Move a −3000 child from account 1 to account 2, then delete the parent: account 1 is credited
+3000 it never spent; account 2 keeps −3000 forever.

**Fix:** reject `accountId` patches when `existing.parentId != null` (splits live on one
account per the module's own doc), or use `c.accountId` at every reversal site.

### 2.3 🔴 Transfers keep their `categoryId` despite the documented "forced to null" invariant
**Where:** `transactions.ts:300` (`createTransfer` passes `baseInput.categoryId` through),
contradicting its own doc at `:25-27`; no guard in `updateTransaction` (`:464-466`) or
`bulkUpdateTransactions` (`:856-858`); API schema allows both fields
(`apps/web/src/app/api/schemas.ts:14-15`).

In the engine a categorized transfer is added to `outflowByMonth[categoryId]` **and**
processed via the CC-payment branch — the money is counted twice. Bulk-categorizing a register
selection that includes a transfer triggers it from the UI.

**Fix:** force `categoryId = null` on transfer insert; reject/ignore `categoryId` patches on
rows with `transferAccountId != null` or with children. (Cross-boundary transfers needing a
category — see 1.6 — should be the explicit exception.)

### 2.4 🔴 POST /api/transactions accepts `parentId` and `skipBalance`, bypassing split validation
**Where:** `apps/web/src/app/api/schemas.ts:24-25`,
`apps/web/src/app/api/transactions/route.ts:146-147`, `transactions.ts:219-222, 233, 258`.

A direct POST with `parentId` inserts a lone child with no check that the parent exists, that
the split sums, or that the child is on the parent's account. Attaching a child to an ordinary
transaction turns it into a "split parent": the engine then ignores the parent's amount while
the parent already applied balance, and deleting that parent reverses only the children —
permanent `accounts.balance` corruption. `skipBalance: true` inserts a row that never touches
the balance. No client uses either field.

**Fix:** strip `parentId`/`skipBalance` from the public create schema; splits go through
`createSplitWithChildren` only.

### 2.5 🟠 Status `"r"` settable outside the reconcile flow; un-reconciling leaves stale metadata
**Where:** `transactions.ts:471` (update), `:621` (`updateSplit`), `:821-846` (bulk — patch
type explicitly includes `"r"`), `:278` (`createTransfer` skips the guard that
`createTransaction` enforces at `:210-214`); stale metadata: `:430-437`, `:842-847`.

`createTransaction` throws on `status:'r'` ("only the reconcile flow may set 'r'"), but every
update path and `createTransfer` allow it, creating locked rows with no
`reconciliationId`/`reconciledAt` that `unreconcileAccount` can never flip back. Conversely,
patching a reconciled row to `"c"`/`"u"` leaves `reconciledAt`/`reconciliationId` populated
and `lastReconciledBalance` silently wrong.

**Fix:** reject `status === "r"` in all patch paths and `createTransfer`; null
`reconciledAt`/`reconciliationId` whenever status leaves `"r"`.

### 2.6 🟠 Create paths validate the rounded amount, then insert the raw one
**Where:** `transactions.ts:209/245` (`createTransaction`), `:283/304-313` (`createTransfer`),
`:188/390-397` (split children); same pattern in
`queries/recurring.ts:157` (`createRecurring` — `updateRecurring:244` does it right) and
`queries/accounts.ts:42` (`createAccount` balance). `upsertAssignment`
(`queries/assignments.ts:11-28`) has **no** rounding/validation at all.

`assertValidAmount` returns `Math.round(n)` but the return value is discarded; SQLite stores
the raw float (10.4) while `applyBalance` rounds its delta (10) — permanent drift between
register sum and account balance, and `assertSplitsBalanced`'s strict `!==` misfires on float
children. `updateTransaction:470` uses the returned value, proving intent.

**Fix:** insert the returned rounded value everywhere; round in `upsertAssignment`.

### 2.7 🟡 1-child collapse can delete a reconciled sibling, bypassing the reconcile lock
**Where:** `transactions.ts:719-728`.

Deleting an unreconciled child checks only the target row; if the remaining last child is
status `"r"`, the collapse deletes it (and the parent) with no check — while deleting the
parent directly is blocked (`:735`).

**Fix:** throw 422 if `remaining[0].status === "r"` before collapsing.

### 2.8 🟡 Split children may transfer to their own account (self-transfer)
**Where:** `transactions.ts:329-409` (`createSplitWithChildren`), `:566-685` (`updateSplit`) —
the guard exists in `createTransaction`/`createTransfer` (`:216-218`, `:284-286`) but not in
the split paths.

A child with `transferAccountId === parent.accountId` nets zero balance but is double-listed
by `computeRunningBalances` (source and destination lists both pick it up).

**Fix:** reject `c.transferAccountId === parent.accountId` in both split paths.

### 2.9 🟡 Editing a split parent's date leaves children on the old date
**Where:** `transactions.ts:426-558` — the split-parent guard blocks only `amount`/`accountId`
(`:483-490`); a plain `updateTransaction(parentId, { date })` changes only the parent row.

The cluster then straddles dates: reconcile's date-bounded flip (`reconcile.ts:179`) can
reconcile children but not the parent (half-locked split), and the register's cluster
mirroring assumes parent/children sort adjacently.

**Fix:** propagate parent date changes to children inside the same DB transaction (as
`updateSplit:650` already does).

---

## 3. Reconciliation (`packages/server/src/queries/reconcile.ts`)

### 3.1 🔴 Working balance ignores the statement date — wrong adjustment transactions
**Where:** `reconcile.ts:88`.

The docstring (`:17-23`, `:107`) says working balance = cleared + reconciled up to statement
date, and the query computes date-bounded `clearedSum`/`reconciledSum` (`:77-80`) — then never
uses them: `workingBalance = acct.balance − unclearedTotal`, where `acct.balance` includes
**all** rows of **all** dates/statuses. Any transaction dated after the statement date (cleared
or uncleared) corrupts the diff, and `reconcileAccount` posts a wrong, *locked* (`status:'r'`)
adjustment transaction. Example: cleared +50000 on 06-01, uncleared −10000 on 07-15;
reconciling as of 06-30 against a correct statement of 50000 posts a spurious +10000
adjustment; the account is permanently off once July clears.

**Fix:** `workingBalance = clearedSum + reconciledSum` (the date-bounded values) plus the
account's opening balance (see 6.1) plus incoming-transfer rows (see 3.3).

### 3.2 🔴 Reconcile aggregates double-count split transactions
**Where:** `reconcile.ts:73-88`.

The six status aggregates have no split-parent exclusion. A split parent carries
`amount = sum(children)` and the same status, so an uncleared −5000 split contributes −10000
to `unclearedSum` → workingBalance overstated by the parent amount → bogus forced adjustment.
Counts are similarly inflated.

**Fix:** exclude rows whose id appears as another row's `parent_id` from all aggregates
(mirroring the engine's `splitParentIds` handling).

### 3.3 🔴 Reconciliation is blind to the destination side of transfers
**Where:** `reconcile.ts:75-83` (aggregates), `:172-182` (the `"c"`→`"r"` flip).

Transfers are one row on the source account, but the mirrored balance *is* applied to the
destination (`applyBalance(transferAccountId, −amount)`). `getReconcileState(dest)` only sums
`accountId = dest`, so an inbound transfer's status is invisible while its amount sits in
`acct.balance`: an uncleared inbound $100 transfer forces a −$100 adjustment, then double-off
when it clears. The flip never reconciles inbound transfers; conversely reconciling the source
locks the row in the destination's register too (status is shared).

**Fix:** include `transferAccountId = :accountId` rows (negated amount) in the aggregates and
the flip; longer-term, per-side cleared status (as YNAB4 has) — a shared-status single row
cannot let both sides reconcile independently.

---

## 4. Accounts (`packages/server/src/queries/accounts.ts`)

### 4.1 🔴 `deleteAccount` never reverses the deleted account's own outgoing transfers
**Where:** `accounts.ts:82-123`; cascade at `schema.ts:100-102`.

Counterparty rows (`transferAccountId = id`, living in *other* accounts) are reversed and
deleted, but rows living in the deleted account with `transferAccountId = other` are removed
only by FK cascade — the mirrored `−amount` applied to the other account's balance at creation
is never undone. Delete account A holding a −10000 transfer to B: B keeps a phantom +10000
with no transaction backing it.

**Fix:** before deleting, select the account's rows where `transferAccountId IS NOT NULL`
(children included, split parents excluded) and `applyBalance(transferAccountId, +amount)` for
each.

### 4.2 🔴 `deleteAccount` deletes split-child counterparties without fixing their parents
**Where:** `accounts.ts:89-105` — the query selects `parentId` but never uses it.

If another account's split has a transfer sub-transaction into the deleted account, that child
is deleted outright: the surviving parent's amount ≠ sum of remaining children (or a 1-child
split remains), and later sibling edits throw "split children do not sum to parent" —
permanently uneditable split. Reconciled counterparties are also deleted silently.

**Fix:** apply `deleteTransaction`'s child logic (re-total parent / collapse 1-child) to each
counterparty with `parentId != null`; refuse or surface reconciled counterparties.

---

## 5. Categories (`packages/server/src/queries/categories.ts`, API route)

### 5.1 🔴 `deleteCategoryGroup` is non-atomic — partial destructive deletion on failure
**Where:** `categories.ts:196-202`; route `apps/web/src/app/api/categories/route.ts:97-98`.

It loops `deleteCategory(db, c.id)` (each committing its own transaction) with no
`moveToCategoryId`. If category A (empty) precedes category B (has transactions), A and all
its historical assignments are permanently deleted, then B throws 422 — the group remains,
A's budget history is gone, and deleting A's assignments retroactively changes every past
month's TBB.

**Fix:** pre-validate all categories are deletable (or accept a move target), and wrap the
whole group deletion in one BEGIN/COMMIT.

### 5.2 🟠 Group PATCH with no fields renames the group to the empty string
**Where:** `apps/web/src/app/api/categories/route.ts:63-68`; schema
`schemas.ts:89-94` (both fields optional); `categories.ts:84-91`.

`{type:"group", id:5}` runs `renameCategoryGroup(db, 5, String(undefined ?? ""))` → name
becomes `""`, bypassing the `min(1)` that only applies when `name` is present (a second such
PATCH then 500s on the unique index). Sending both `name` and `sort` silently drops the
rename.

**Fix:** require at least one field in the schema; only rename when `name !== undefined`;
handle name+sort together.

---

## 6. Seed / integrity diagnostics

### 6.1 🔴 No opening-balance model: seed data and `createAccount` violate the balance invariant; the "repair" endpoint then destroys balances
**Where:** `packages/server/src/seed.ts:44-70`, `queries/accounts.ts:30-54` (balance set with
no opening transaction), vs `queries/diagnostics.ts:30-118` and
`apps/web/src/app/api/diagnostics/balance-integrity/route.ts:26-42`.

The integrity check defines `balance == sum(own rows) − sum(incoming transfers)`. Seeded
accounts (e.g. TD Chequing 1087555 vs transactions summing −1,892,874; Scotia 45823 with zero
transactions) fail it from a fresh seed, and POST "repair" rewrites them to the transaction
sum (TD → −1,892,874, Scotia → 0), wrecking the data it claims to fix. Any user account
created with a starting balance has the same fate. Related: `seed.ts:330` sets
`lastReconciledBalance: 608358`, which is only coherent if 1087555 were an *opening* balance —
no query treats it that way.

**Fix:** introduce an explicit "Starting Balance" transaction (seed + `createAccount`), or
model `openingBalance` as a column the integrity check and reconcile math both include.

### 6.2 🟠 `verifyBudgetIntegrity` false-positives on deferred income and future-dated transactions
**Where:** `queries/diagnostics.ts:127-154`.

It compares `sum(on-budget balances)` (all dates) with `computeBudget(data, todayMonth)`
(flows through the current month only). A paycheck received Aug 30 deferred to September
(`incomeMonth`) — a supported feature (`budget-engine.ts:196`) — makes the "fundamental
invariant" report a difference of exactly the paycheck amount with nothing wrong. Post-dated
transactions do the same.

**Fix:** evaluate at the latest month with data, or subtract future-dated and deferred-income
amounts from `totalAccountBalance` before differencing.

### 6.3 🟡 `resetDatabase` doesn't wipe `payees`
**Where:** `seed.ts:16-34` vs `schema.ts:81-94`.

Stale payee rows survive reset+reseed while `DELETE FROM sqlite_sequence` resets their id
counter — future payee inserts can collide with surviving rows' ids semantics.

**Fix:** add `db.delete(payees)` (and, for clarity, `reconciliations`) to the reset list.

### 6.4 🟡 `seed.ts` and `seed-fixture.ts` have diverged
**Where:** `seed.ts:236-238, 246-247, 328-331` vs
`packages/logic/src/seed-fixture.ts:213-215, 223-224`.

The DB seed marks five April TD rows `"r"` with reconcile metadata; the logic fixture leaves
them `"c"` with none — tests against the fixture don't match server-seeded state. Both seeds
also transfer −45550 to the off-budget TFSA with `categoryId: null` (uncategorized off-budget
outflow), which the budget-integrity identity can't reconcile with the seeded "Retirement"
assignment.

**Fix:** sync fixture statuses/metadata with seed.ts; categorize the TFSA transfer.

---

## 7. Recurring transactions (`packages/logic/src/recurring.ts`, `format.ts`, `packages/server/src/queries/recurring.ts`)

### 7.1 🔴 "Twice a month" actually fires three times per month
**Where:** `packages/logic/src/format.ts:~368-384` (`nextDateFor`, `case "twiceamonth"`);
inconsistent with `recurring.ts:94-96` (`frequencyMonthlyMultiplier` returns 2). The test
`packages/logic/tests/format.test.ts:132-135` asserts the buggy sequence.

The advance rule (day<15→15th; 15≤day<lastDay→last day; lastDay→1st of next month) produces
the stable cycle {1st, 15th, last day} — three occurrences per month. Auto-post catch-up
(`queries/recurring.ts:367-387`) materializes all three: a "$1000 twice a month" paycheck
posts $3000/month, while projections using the ×2 multiplier disagree by 50%. The user's
anchor day is also discarded.

**Fix:** alternate between exactly two anchors, e.g. from day D<15 go to D+15 (clamped); from
D≥15 go to D−15 of the next month. Update the test — it currently encodes the bug.

### 7.2 🔴 Unrecognized frequency never advances `nextDate` → duplicate postings forever
**Where:** `format.ts:~446-448` (`default: return iso;`, contradicting the docstring's
"falls back to monthly"); no frequency validation in `queries/recurring.ts:155-177`;
posting loop `:352-387`.

For any frequency string outside the switch, `nextDateFor` returns the date unchanged and the
row stays `active`, permanently overdue: every "post" click and every auto-post run creates
another duplicate transaction (the `<=` loop guard only stops *within* one call, after already
posting). Related importer bug: `packages/server/src/import-ynab4.ts:619-638` silently maps
YNAB4's `EveryOtherYear` → `monthly` (biennial bill becomes monthly!) and `Never` → `monthly`,
though the schema supports `every2years`/`once`.

**Fix:** validate `frequency` against `RECURRING_FREQUENCIES` on create/update (422); make the
`nextDateFor` fallback actually advance monthly; map `EveryOtherYear → every2years`,
`Never → once` in the importer.

### 7.3 🟠 A recurring row with both `transferAccountId` and split children: display and posting disagree
**Where:** `packages/logic/src/recurring.ts:129-136` (`recurringFlavour`: transfer wins) vs
`queries/recurring.ts:319-350` (`postRecurringTransaction`: children win); state is creatable
via `updateRecurring` (`:239-276`).

Patching `{transferAccountId: 2}` onto an existing split leaves the children rows intact: the
UI shows a transfer, posting materializes the old split and never moves money to account 2.
The reverse patch (`subTransactions` onto a transfer) leaves `transferAccountId` set. The
amount-change re-validation (`:223-237`) is also skipped when `transferAccountId != null`,
so stale children dodge split-sum validation.

**Fix:** in `updateRecurring`, setting a non-null `transferAccountId` must delete existing
children; installing `subTransactions` must null `transferAccountId`. Align
`postRecurringTransaction` precedence with `recurringFlavour`.

---

## 8. Reports (`packages/logic/src/reports.ts`)

### 8.1 🟠 `computeCashFlow` drops categorized refunds
**Where:** `reports.ts:196-206`.

The outflow branch only accumulates `amt < 0`. A categorized store refund (+10000) is neither
income nor an outflow reduction — it vanishes. Sibling functions (`computeMonthlyInsights:306`,
`computeSpendingTrends:476`) net refunds correctly (tested as UNI-35/BUG-28), so the cash-flow
report disagrees with the trends report on the same data; outflow overstated, savings rate
understated.

**Fix:** accumulate signed amounts (drop the `amt < 0` gate), clamping only for display.

### 8.2 🟠 `computeCashFlow` counts off-budget spending but excludes off-budget income
**Where:** `reports.ts:191-205` (outflow branch never consults the account) vs the income path
(`isIncomeTransaction` excludes off-budget).

An investment fee on a tracking account inflates outflow while the symmetric dividend inflow
is dropped — systematically pessimistic net/savings rate for anyone tracking investments.

**Fix:** skip off-budget accounts in the outflow branch (accountMap is already built).

### 8.3 🟡 Spending drilldown list includes CC-payment rows the chart excludes
**Where:** `reports.ts:484-494` (`computeSpendingTrends` skips `isCreditCardPayments` groups)
vs `:616-644` (`getSpendingTransactions` applies no such filter at the "all" level).

Summing the visible drilldown transactions won't match the chart total when CC-payment
categories carry categorized rows.

**Fix:** apply the same CC-payment-group exclusion in `getSpendingTransactions` when no
explicit category/group filter is given.

---

## 9. CSV import (`packages/logic/src/csv-import.ts`, `packages/server/src/import-csv.ts`)

### 9.1 🔴 Outflow cell of "0.00" blocks the inflow fallback — deposits silently vanish
**Where:** `csv-import.ts:198-211`; silent filtering in `import-csv.ts:37`.

With separate Outflow/Inflow columns, the inflow fallback only fires when the outflow cell
fails to parse. Banks commonly fill the unused column with `0.00`; that parses to `0`, the
inflow column is never read, the row errors "Amount is zero", and `importCsvTransactions`
filters errored rows out with no entry in `skipped`. Example:
`13/08/2026,PAYROLL,,0.00,1908.03` → the deposit disappears from the import.

**Fix:** treat a parsed outflow of `0` as empty and fall through to inflow (then amount);
report skipped rows instead of silently dropping them.

### 9.2 🟠 Per-row DD/MM vs MM/DD heuristic mixes two date conventions in one file
**Where:** `csv-import.ts:98-109`.

The parser assumes DD/MM and swaps per-row only when the middle number > 12. A US MM/DD file:
`08/13/2026` → Aug 13 (swapped), `08/05/2026` → **May 8**. Same column, two conventions —
silent misdating that also breaks duplicate detection on re-import.

**Fix:** decide the convention once per file (scan all rows; any first-number > 12 → MM/DD,
any second-number > 12 → DD/MM; ambiguous → default or user toggle).

### 9.3 🟠 Fuzzy outflow-header matching hijacks non-amount columns and flips signs
**Where:** `csv-import.ts:167-175` (header matching), `:198-209` (fallback chain).

Two failure shapes: (a) a single signed column named "Payment Amount" matches the outflow
regex (`payment`) before the `amount` check, so every value is negated — a −10.50 debit
imports as +1050 cents; (b) header "Type of Payment" grabs `outflowIdx`, per-row parsing of
"Direct Debit" fails, and `amountIdx` is never consulted (it's only used when both
outflow/inflow indices are −1) — every row fails despite a good Amount column. Related:
accounting-style negatives in an Outflow column (`(28.08)` or `-28.08`) are negated into
*inflows* (`:114-127` + the `-amt` at `:203`).

**Fix:** prefer an exact "amount" header over fuzzy outflow words; skip headers containing
"type"/"method"; add `amountIdx` as the last per-row fallback; use `abs()` when negating an
outflow column.

---

## 10. YNAB4 import (`packages/server/src/import-ynab4.ts`)

### 10.1 🔴 Legitimate identical transactions are silently dropped as "duplicates"
**Where:** `import-ynab4.ts:509-529`.

Any non-transfer row matching an earlier row on (account, date, amount, normalized payee,
normalized memo) is skipped. Two identical $3.00 bus taps on the same day are normal,
reconciled data in a YNAB4 backup — the importer deletes the second, so the imported balance
no longer matches the source *or* the imported `lastReconciledBalance` (`:160-163`), showing a
phantom discrepancy the user can't fix. The in-app analyzer only *flags* duplicates; the
importer, operating on the most authoritative data, deletes them.

**Fix:** import all non-tombstone rows; at most flag suspected duplicates
(`TRANSACTION_DUPLICATE_FLAG`) for review.

### 10.2 🟠 Monthly budget entries ignore `isTombstone` — deleted assignments resurrected
**Where:** `import-ynab4.ts:243-266`.

Every other entity loop filters tombstones (payees :122, accounts :131, categories :176/:196,
transactions :277/:296, scheduled :587/:657); the `monthlyBudgets`/`monthlySubCategoryBudgets`
loop checks neither flag, so a deleted budget entry with stale `budgeted` imports as live,
skewing that month's assigned/TBB.

**Fix:** `if (mb.isTombstone) continue;` / `if (msb.isTombstone) continue;`.

### 10.3 🟡 Transfer pair with a missing account drops the live side too
**Where:** `import-ynab4.ts:432-447`.

In the pair branch, if the negative side's account is missing from `accountIdMap`, the
`continue` fires after both entityIds were marked processed — the valid positive side is lost
and its account balance goes low. The partner-missing path (`:478`) handles the analogous case
correctly.

**Fix:** fall back to importing the resolvable side as a regular transaction (mirroring
`:478`).

### 10.4 🟡 Scheduled split paychecks lose their income legs
**Where:** `import-ynab4.ts:678` — `if (!subCatId && !subTransferAccountId) continue;`.

`__ImmediateIncome__` sub-transactions map to `catId null` and are dropped, so imported
recurring split sub-rows no longer sum to the parent amount.

**Fix:** keep null-category sub-rows (they're income legs), or adjust the parent amount.

---

## 11. Duplicates, rename rules, payees

### 11.1 🟠 Duplicate-analysis report hides real duplicates whenever any stale marker was cleared
**Where:** `packages/server/src/queries/duplicates.ts:125-137`.

Cleared rows are by construction never members of current groups, but when `clearedCount > 0`
the filter `d.id == null || !d.flagColor` strips from the report every duplicate carrying
*any* flag — including still-active duplicates flagged by the previous run. Same DB state
reports different `duplicateCount` depending on an unrelated clear.

**Fix:** delete the `effectiveGroups` filtering; compute `duplicateCount` from `groups`.

### 11.2 🟠 Rename pattern with multiple `[N]` wildcards only converts the first
**Where:** `packages/logic/src/rename-rules.ts:66` — `String.prototype.replace` with a string
pattern replaces one occurrence.

`CHK [N] REF [N]` compiles to `^chk \d+ ref \[n\]$` and never matches `CHK 12 REF 34`; silent
no-op. (Related, minor: `inferRenameRule:100-111` compares prefixes case-sensitively while
matching is case-insensitive, so `bcf1`+`BCF2` never generalize.)

**Fix:** `escaped.split(escapeRegExp(wc)).join("\\d+")`.

### 11.3 🟡 Payee rename propagation keys on `transactions.payeeId`, which nothing ever writes
**Where:** `packages/server/src/queries/payees.ts:89-100`.

All write paths (importers, `queries/transactions.ts`) store only the `payee` string;
`payeeId` is never populated, so `updatePayee`'s propagation matches zero rows. Latent — the
payees module currently has no API/UI callers — but it silently misbehaves the moment payee
CRUD is wired up.

**Fix:** populate `payeeId` on insert paths, or propagate by name.

---

## 12. Shared utilities (`packages/logic/src/format.ts`)

### 12.1 🟠 `num()` truncates fractional strings but rounds fractional numbers
**Where:** `format.ts:~45-85` (string path uses `parseInt`).

`num(100.5)` → 101 but `num("100.5")` → 100; `num("4.03")` → 4 (a dollar string collapses to
cents-level garbage); `parseInt(String(1e21))` → 1. Today DB values are integer-cent strings
so it's mostly latent, but `upsertAssignment` stores unvalidated floats (see 2.6) that read
back through this truncation — the saved assignment and the summed assignment differ.

**Fix:** use `Math.round(Number(str))` in the string path (rejecting NaN), and validate at the
write sites.

### 12.2 🟡 CSV export writes raw integer cents into dollar-named columns
**Where:** `apps/web/src/app/api/export/route.ts:62, 78, 86, 96, 109`.

$28.08 exports as `2808` under "Amount"/"Balance" with no unit hint, while both importers
parse dollars — feeding a slice of this export back through the CSV importer would inflate
amounts 100×. The route's round-trip claim doesn't hold for money columns.

**Fix:** export `(cents / 100).toFixed(2)`, or rename columns `AmountCents`/`BalanceCents`.
