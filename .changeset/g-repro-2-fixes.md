---
"@ynab/logic": patch
"@ynab/server": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Fix all 13 red YNAB4 repro suites (g-tests-2 follow-through)

All thirteen `repro-*` files committed red in `g-tests-2` now pass;
`yarn test` (8/8 workspaces) and `yarn typecheck` (9/9) are green.

Logic (`@ynab/logic`): OFX FITID ±4-day near-miss dedupe regardless of
payee (`duplicates.ts`); merge keeps the user-entered date and
max(cleared) status U<C<R (`merge.ts`); rename operators compare with
case-folding only, punctuation significant (`rename-rules.ts`,
`rename-suggest.ts` caller); yearly/every2years Feb-29 overflows to
Mar-1 like YNAB4 `addYear` (`format.ts`); NBSP/narrow-NBSP grouping
parses like spaces (`csv-import.ts`); split-parent income honors
+N-month `incomeMonth` jumps (`budget-engine.ts`); CC-payment-category
overspend feeds the cash-overspend machine and clamps next month
(`budget-engine.ts`).

Server (`@ynab/server`): per-mapping OFX import warnings naming the
account and flags (G-10); `payees.auto_memo`/`auto_amount` columns
(migration `0034`) persisting `autoFillMemo`/`autoFillAmount` with
export round-trip (G-04); scheduled splits import zero legs verbatim
without single-child collapse (G-06); `updateSplit` locks dest-leg
reconciled transfers; `completeChatJson` wall-clock timeout (504) plus
actionable 401/403 messages; snapshot restore rejects pre-migration
snapshots before touching the live DB.

Tests: existing suites updated where they pinned pre-YNAB4 behavior
(merge date/status, separator folding, leap-day clamp, CC/self TBB
timing). One repro assertion was itself wrong and is called out
explicitly: `repro-cc-buffer-self` expected the deficit in same-month
TBB, but the engine (pinned by `budget-engine.test.ts`) deducts
same-month overspend from next month's TBB for every category — the
test now asserts Feb TBB 495000 like a regular category.
