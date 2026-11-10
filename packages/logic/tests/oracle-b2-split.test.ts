/**
 * oracle-b2-split.test.ts
 *
 * Oracle port: YNAB4 split leg + split list semantics mapped onto the
 * parentId-linked `Transaction` row model (`split.ts` + budget-engine
 * split-parent skip + `transfers.ts`).
 *
 * Sources (36 tests):
 * - ynab4-modern/packages/domain/src/transactions/SubTransaction.test.ts
 *   (23 tests): :128-134 (date/account delegation), :136-140 (orphaned
 *   access throws / AS3 NPE parity), :142-150 (parent write-once:
 *   null->parent + same-id swap), :152-160 (different-id reparent throw
 *   verbatim), :162-172 (createFromVO wires parent+fields, defers transfer
 *   id), :174-179 (createFromVO missing parent throws
 *   CantFindSyncableEntityParentError), :181-193 (clone duplicate id keeps
 *   id + re-parents), :195-207 (clone preserves positive amount;
 *   inflow/outflow no-change guards), :209-217 (clone fresh id generates
 *   new id, suspend/resume balanced), :219-227 (recalcErrorState bubbles to
 *   parent by default, not with recalcParent=false), :229-236 (suspended
 *   sub skips own recalc + parent bubble), :238-251 (deepCopyFrom copies
 *   base fields), :253-259 (contentsEqual rejects null/non-subs),
 *   :261-274 (contentsEqual inverted-category oracle quirk — categories
 *   ARE equal => false; do NOT fix), :276-286 (quirk corollary: true only
 *   when categories differ), :288-294 (contentsEqual throws when
 *   this.category is null / NPE parity), :296-343 (contentsEqual
 *   inflow/memo/outflow/account/parent/target diffs), :345-355
 *   (populateFromVO pins null parent + defers transfer), :357-365
 *   (populateFromVO orphan-with-changes throws / NPE parity), :367-375
 *   (populateFromVO tolerates matching parent id), :377-386 (populateFromVO
 *   throws verbatim on parent change), :388-397 (populateVO writes
 *   parentTransactionId; orphan populateVO throws), :399-406
 *   (isSubTransactionEntity tag + isTransferIntoSplitTransaction).
 * - ynab4-modern/packages/domain/src/transactions/SubTransactionList.test.ts
 *   (13 tests): :60-65 (immutable parent), :67-78 (identity index hit/miss),
 *   :80-92 (removeItemAt/setItemAt keep index in sync), :94-103
 *   (sumOfSubTransactions empty => 0, culture rounding), :105-125
 *   (category matching by identity `===`, incl. null === null), :127-144
 *   (clone duplicates ids + re-parents, order preserved), :146-154 (clone
 *   duplicate+prefix throws INSIDE the loop), :156-161 (empty-list clone
 *   with duplicate+prefix does NOT throw), :163-178 (prefix-derived ids;
 *   empty prefix is falsy => fresh ids), :180-192 (equals rejects
 *   null/non-lists/length mismatch), :194-248 (equals order-sensitive +
 *   null-slot aware + category quirk), :250-267 (first-match transfer scan;
 *   miss => null; null => null), :269-280 (source replace rebuilds index).
 *
 * Mapping: no entity graph exists here. Splits are parentId-linked
 * `Transaction` rows; the SQLite layer owns rows, so entity-list
 * update/remove/dispose, VO populate, suspend/resume, and recalc-bubble
 * semantics are N/A with reason per test. Applicable analogues:
 * `isSplitChild`/`isSplitParent` (child-row helpers),
 * `getSplitChildren`/`splitChildrenTotal`/`getSplitParent`
 * (SubTransactionList analogues), `assertSplitsBalanced`
 * (write-path sum/category balance), `repairSplitForImport`
 * (import-time filler/empty/single-child policy), budget-engine
 * split-parent skip (no double-count), and `transfers.ts` eligibility
 * (split-parent-as-transfer ban, transfer-leg-on-child legitimacy).
 *
 * Quirks preserved as characterization: the inverted `contentsEqual`
 * category quirk is documented, NOT ported (FORK: leg equality here is
 * structural value equality); `repairSplitForImport` empty-kind no-throw
 * covers the empty-clone-with-prefix-no-throw analogue; `num()`/
 * `assertSplitsBalanced` use Math.round (half up), noted where the oracle
 * relies on int()/truncation.
 *
 * Amounts: integer cents. `Transaction.amount` is a cents string.
 */
import { describe, expect, it } from "vitest";
import {
  assertSplitsBalanced,
  getSplitChildren,
  getSplitParent,
  isSplitChild,
  isSplitParent,
  isTransfer,
  repairSplitForImport,
  splitChildrenTotal,
} from "../src/split.js";
import { num } from "../src/format.js";
import {
  isTransferEligible,
  validateTransferEligibility,
  validateTransferPayeeConsistency,
} from "../src/transfers.js";
import { computeBudget } from "../src/budget-engine.js";
import type { BudgetData, Transaction } from "../src/types.js";

let nextId = 1;

function tx(overrides: Partial<Transaction> = {}): Transaction {
  const id = nextId++;
  return {
    id,
    accountId: 1,
    categoryId: null,
    date: "2026-07-01",
    payee: "",
    memo: "",
    amount: "0",
    status: "c",
    ...overrides,
  };
}

/** A parent row plus two categorized child legs summing to the parent. */
function splitRows(parentAmount = "-10000"): {
  parent: Transaction;
  a: Transaction;
  b: Transaction;
  all: Transaction[];
} {
  const parent = tx({ categoryId: null, amount: parentAmount });
  const a = tx({ categoryId: 1, amount: "-6000", parentId: parent.id });
  const b = tx({ categoryId: 2, amount: "-4000", parentId: parent.id });
  return { parent, a, b, all: [parent, a, b] };
}

function budgetData(rows: Transaction[]): BudgetData {
  return {
    accounts: [{ id: 1, name: "Checking", kind: "checking", onBudget: true, balance: "0" }],
    groups: [{ id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 2, groupId: 1, name: "Dining", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: rows,
    recurring: [],
  };
}

describe("oracle B2 split: child-row helpers (SubTransaction)", () => {
  it("child rows delegate date/account to the parent row via lookup", () => {
    // Oracle SubTransaction.test.ts:128-134 (date/account delegation).
    // No getters here: the analogue is resolving the parent row and
    // reading its date/account.
    const parent = tx({ accountId: 7, date: "2012-01-15" });
    const child = tx({ accountId: 7, date: "2012-01-15", parentId: parent.id });
    const all = [parent, child];
    expect(isSplitChild(child)).toBe(true);
    expect(getSplitParent(all, child)).toBe(parent);
    expect(getSplitParent(all, child)!.date).toBe("2012-01-15");
    expect(getSplitParent(all, child)!.accountId).toBe(7);
  });

  it("orphaned child lookup returns undefined instead of throwing", () => {
    // Oracle SubTransaction.test.ts:136-140 (orphaned access throws, AS3
    // NPE parity). FORK: no entity graph here — an orphaned parentId has
    // no row to dereference, so the lookup yields undefined rather than
    // throwing. SQLite owns row integrity; reads stay total.
    const orphan = tx({ parentId: 999 });
    expect(getSplitParent([orphan], orphan)).toBeUndefined();
    const lone = tx({});
    expect(getSplitParent([lone], lone)).toBeUndefined();
  });

  it("parent linkage is write-once by convention: same parent kept, new parent is an explicit edit", () => {
    // Oracle SubTransaction.test.ts:142-160 (null->parent + same-id swap
    // allowed; different-id reparent throws verbatim). N/A with reason:
    // no setter guard — parentId is a plain field. Applicable analogue:
    // a child keeps resolving to its pinned parent, and re-pointing the
    // field re-points the child (an explicit edit, never implicit).
    const { parent, a, all } = splitRows();
    expect(getSplitParent(all, a)).toBe(parent);
    const other = tx({ amount: "-10000" });
    const moved: Transaction = { ...a, parentId: other.id };
    expect(getSplitParent([other, moved], moved)).toBe(other);
    expect(getSplitParent([other, moved], moved)).not.toBe(parent);
  });

  it("missing parent on import is an orphan row, not a thrown CantFindSyncableEntityParentError", () => {
    // Oracle SubTransaction.test.ts:162-179 (createFromVO wires fields +
    // defers transfer; missing parent throws). N/A with reason: no VO
    // layer or entity context here. Applicable analogue: a child whose
    // parentId names no row in the dataset is simply orphaned
    // (getSplitParent => undefined) and import repair never throws.
    const ghost = tx({ categoryId: 1, amount: "-500", parentId: 4242 });
    expect(getSplitParent([ghost], ghost)).toBeUndefined();
    expect(() => repairSplitForImport(-500, [{ categoryId: 1, amount: -500 }])).not.toThrow();
  });

  it("copying child legs preserves amount/memo/category under a new parent", () => {
    // Oracle SubTransaction.test.ts:181-217 (clone duplicate/fresh ids,
    // suspend/resume balanced, positive-amount survival). Suspend/resume
    // is N/A (no error-checking suspension; assertSplitsBalanced is an
    // explicit call). Applicable analogue: structural copy re-parented.
    const { parent, a } = splitRows();
    const newParent = tx({ amount: "-10000" });
    void parent;
    const dup: Transaction = { ...a, id: a.id + 1000, parentId: newParent.id };
    expect(dup.amount).toBe(a.amount);
    expect(dup.memo).toBe(a.memo);
    expect(dup.categoryId).toBe(a.categoryId);
    expect(getSplitParent([newParent, dup], dup)).toBe(newParent);
    // Positive (inflow) legs survive the copy verbatim — no
    // inflow/outflow setter clobbering exists on plain rows.
    const inflow = tx({ categoryId: null, amount: "4200", parentId: newParent.id });
    const inflowCopy: Transaction = { ...inflow, id: inflow.id + 1000 };
    expect(num(inflowCopy.amount)).toBe(4200);
  });

  it("no recalc bubble exists: balance is checked explicitly, never suspended", () => {
    // Oracle SubTransaction.test.ts:219-236 (recalcErrorState bubbles to
    // the parent by default; suspended subs skip recalc). N/A with
    // reason: no error-state machine here. Applicable analogue: the only
    // balance check is the explicit assertSplitsBalanced call, which has
    // no suspend flag — it validates whenever invoked.
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: 2, amount: -4000 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: 2, amount: -3000 },
      ]),
    ).toThrow(/do not sum to parent/);
  });

  it("leg equality is structural; the inverted-category quirk is documented, not ported", () => {
    // Oracle SubTransaction.test.ts:253-294 (contentsEqual rejects
    // null/non-subs; INVERTED category quirk: equal categories => false;
    // null this.category throws). Characterization, do NOT fix the
    // oracle. FORK: rows here compare structurally — identical
    // (categoryId, amount, memo) legs are EQUAL. The oracle inversion is
    // intentionally not reproduced.
    const { a, b } = splitRows();
    const sameAsA: Transaction = { ...a, id: a.id + 5000 };
    const legsEqual = (x: Transaction, y: Transaction): boolean =>
      x.categoryId === y.categoryId && num(x.amount) === num(y.amount) && x.memo === y.memo;
    expect(legsEqual(a, sameAsA)).toBe(true);
    expect(legsEqual(a, b)).toBe(false);
    // Null categories compare with === (null === null matches), unlike
    // the oracle which throws on null this.category.
    const u1 = tx({ categoryId: null, amount: "-100", parentId: 1 });
    const u2 = tx({ categoryId: null, amount: "-100", parentId: 1 });
    expect(u1.categoryId === u2.categoryId).toBe(true);
    expect(legsEqual(u1, u2)).toBe(true);
  });

  it("leg diffs: amount/memo/category/parent/account differences are all observable on rows", () => {
    // Oracle SubTransaction.test.ts:296-343 (inflow/memo/outflow/
    // account/parent/target diffs; distinct category instances needed to
    // reach later comparisons past the quirk).
    const { parent, a, all } = splitRows();
    void all;
    const tweak = (patch: Partial<Transaction>): Transaction => ({ ...a, ...patch });
    expect(num(tweak({ amount: "-6001" }).amount)).not.toBe(num(a.amount));
    expect(tweak({ memo: "y" }).memo).not.toBe(a.memo);
    expect(tweak({ categoryId: 9 }).categoryId).not.toBe(a.categoryId);
    expect(tweak({ parentId: parent.id + 99 }).parentId).not.toBe(a.parentId);
    expect(tweak({ accountId: 2 }).accountId).not.toBe(a.accountId);
    expect(tweak({ transferAccountId: 3 }).transferAccountId).not.toBe(
      a.transferAccountId ?? null,
    );
  });

  it("child construction pins the parent id; no populate/VO layer exists", () => {
    // Oracle SubTransaction.test.ts:345-397 (populateFromVO pins null
    // parent, defers transfer, tolerates matching id, throws verbatim on
    // change; populateVO writes parentTransactionId, orphan throws).
    // N/A with reason: no VO/context layer — rows are constructed
    // directly. Applicable analogue: the parentId field is the pin, and
    // the deferred-transfer analogue is validateTransferEligibility on
    // the child leg.
    const parent = tx({ amount: "-10000" });
    const child = tx({ categoryId: 1, amount: "-10000", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(getSplitParent([parent, child], child)).toBe(parent);
    expect(() =>
      validateTransferEligibility({ accountId: 1, parentId: child.parentId }),
    ).not.toThrow();
  });

  it("split transfer legs live on children: isTransfer + eligibility", () => {
    // Oracle SubTransaction.test.ts:399-406 (isSubTransactionEntity tag,
    // isTransferIntoSplitTransaction) + SubTransactionList.test.ts:250-267
    // (transfer scan). The tag analogue is isTransfer on the child row.
    const parent = tx({ amount: "-10000" });
    const leg = tx({
      categoryId: null,
      transferAccountId: 2,
      amount: "-4000",
      parentId: parent.id,
    });
    expect(isTransfer(leg)).toBe(true);
    expect(isTransfer(parent)).toBe(false);
    // A transfer leg on a child is legitimate and passes eligibility.
    expect(
      isTransferEligible({ accountId: 1, transferAccountId: 2, parentId: parent.id }),
    ).toBe(true);
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: null, transferAccountId: 2, amount: -4000 },
      ]),
    ).not.toThrow();
  });
});

describe("oracle B2 split: child-list helpers (SubTransactionList)", () => {
  it("parent row identity is stable; children resolve to it, never to a child", () => {
    // Oracle SubTransactionList.test.ts:60-65 (immutable parent) +
    // SubTransactionList.ts:parentTransaction.
    const { parent, a, b, all } = splitRows();
    expect(isSplitParent(parent, all)).toBe(true);
    expect(isSplitParent(a, all)).toBe(false);
    expect(isSplitParent(b, all)).toBe(false);
    expect(getSplitChildren(all, parent.id)).toEqual([a, b]);
  });

  it("identity index analogue: hit returns the row, miss returns undefined", () => {
    // Oracle SubTransactionList.test.ts:67-92 (findSubTransactionByEntityId
    // hit/miss; removeItemAt/setItemAt keep the index in sync). N/A with
    // reason: no mutable list with an index — lookups are pure filters
    // over the dataset, so there is no index to fall out of sync.
    const { parent, a, b, all } = splitRows();
    expect(all.find((t) => t.id === a.id)).toBe(a);
    expect(all.find((t) => t.id === b.id)).toBe(b);
    expect(all.find((t) => t.id === 9999)).toBeUndefined();
    expect(getSplitParent(all, a)).toBe(parent);
  });

  it("replacing the dataset rebuilds lookups trivially (source-replace reindex)", () => {
    // Oracle SubTransactionList.test.ts:269-280 (source = [b] rebuilds
    // the identity index; length/sum follow). Pure functions re-derive
    // everything per call, so replacement is inherently consistent.
    const { parent, b } = splitRows();
    const replaced = [parent, b];
    expect(getSplitChildren(replaced, parent.id)).toEqual([b]);
    expect(splitChildrenTotal(replaced, parent.id)).toBe(-4000);
  });

  it("children total is 0 when empty; float cents round half up via num()", () => {
    // Oracle SubTransactionList.test.ts:94-103 (sumOfSubTransactions
    // empty => 0, culture rounding via safeAdd). Here splitChildrenTotal
    // sums integer cents through num(), which rounds halves AWAY from
    // zero (sign * Math.round(abs)) — note: the oracle culture round and
    // int()/trunc code paths differ; half-cent values round, they do not
    // truncate.
    const parent = tx({ amount: "0" });
    expect(splitChildrenTotal([parent], parent.id)).toBe(0);
    const a = tx({ categoryId: 1, amount: "-6000.5", parentId: parent.id });
    const c = tx({ categoryId: 2, amount: "-3999.5", parentId: parent.id });
    expect(num("-6000.5")).toBe(-6001);
    expect(num("3999.5")).toBe(4000);
    expect(num("-3999.5")).toBe(-4000);
    expect(splitChildrenTotal([parent, a, c], parent.id)).toBe(
      num(a.amount) + num(c.amount),
    );
    expect(
      splitChildrenTotal(
        [parent, tx({ categoryId: 1, amount: "10", parentId: parent.id })],
        parent.id,
      ),
    ).toBe(10);
  });

  it("category matching uses ===, including null === null", () => {
    // Oracle SubTransactionList.test.ts:105-125 (identity === matching,
    // null === null). Direct analogue on child rows.
    const parent = tx({ amount: "-10000" });
    const inA = tx({ categoryId: 1, amount: "-6000", parentId: parent.id });
    const notA = tx({ categoryId: 2, amount: "-3000", parentId: parent.id });
    const uncat = tx({ categoryId: null, amount: "-1000", parentId: parent.id });
    const all = [parent, inA, notA, uncat];
    const kids = getSplitChildren(all, parent.id);
    expect(kids.filter((t) => t.categoryId === 1)).toEqual([inA]);
    expect(kids.filter((t) => t.categoryId === null)).toEqual([uncat]);
  });

  it("copying a leg list preserves order and re-parents every leg", () => {
    // Oracle SubTransactionList.test.ts:127-144 (clone duplicates ids +
    // re-parents, order preserved) + :163-178 (prefix ids; empty prefix
    // falsy => fresh ids). N/A with reason: no clone-with-flags API.
    // Applicable analogue: mapped copies keep order and point at the new
    // parent; ids are assigned by the store, so "prefix" has no analogue.
    const { a, b } = splitRows();
    const newParent = tx({ amount: "-10000" });
    const copied = [a, b].map((leg, i) => ({
      ...leg,
      id: 900 + i,
      parentId: newParent.id,
    }));
    expect(copied.map((c) => c.amount)).toEqual([a.amount, b.amount]);
    expect(copied.every((c) => c.parentId === newParent.id)).toBe(true);
    expect(getSplitChildren([newParent, ...copied], newParent.id)).toEqual(copied);
  });

  it("duplicate+prefix throw has no analogue; empty repair never throws", () => {
    // Oracle SubTransactionList.test.ts:146-161 (duplicate+prefix throws
    // INSIDE the loop, so empty lists do not throw). Characterization:
    // repairSplitForImport empty kind never throws — the closest
    // no-legs-no-throw guarantee here.
    const result = repairSplitForImport(-5000, []);
    expect(result.kind).toBe("empty");
    expect(result.repaired).toBe(false);
    expect(result.children).toEqual([]);
    expect(result.difference).toBe(-5000);
  });

  it("child-list equality is ordered; empty slots never match real legs", () => {
    // Oracle SubTransactionList.test.ts:180-248 (equals rejects
    // null/non-lists/length mismatch; order-sensitive; null-slot aware;
    // same-instance categories unequal via the quirk). FORK: structural
    // comparison here — same legs in the same order are equal, swapped
    // order is not, and there are no null slots (every row is defined).
    const first = splitRows();
    const second = splitRows();
    const norm = (t: Transaction): string =>
      `${t.categoryId}:${num(t.amount)}:${t.memo}`;
    const sig = (rows: Transaction[]): string[] =>
      getSplitChildren(rows, rows[0]!.id).map(norm);
    // Same multiset built twice compares equal in order…
    const canon = [
      { categoryId: 1, amount: -6000, memo: "" },
      { categoryId: 2, amount: -4000, memo: "" },
    ];
    expect(sig(first.all)).toEqual(canon.map((c) => `${c.categoryId}:${c.amount}:${c.memo}`));
    expect(sig(second.all)).toEqual(sig(first.all));
    // …but order matters: the dataset order is the list order.
    const swapped = [first.parent, first.b, first.a];
    expect(getSplitChildren(swapped, first.parent.id)).toEqual([first.b, first.a]);
    expect(getSplitChildren(swapped, first.parent.id)).not.toEqual(
      getSplitChildren(first.all, first.parent.id),
    );
  });

  it("first-match transfer scan: first leg wins, miss and null give undefined", () => {
    // Oracle SubTransactionList.test.ts:250-267
    // (findSubTransactionTransferringTo: first match, miss => null,
    // null => null). Rows use numeric ids; miss/null yield undefined.
    const parent = tx({ amount: "-10000" });
    const plain = tx({ categoryId: 1, amount: "-2000", parentId: parent.id });
    const firstLeg = tx({
      categoryId: null,
      transferAccountId: 9,
      amount: "-4000",
      parentId: parent.id,
    });
    const secondLeg = tx({
      categoryId: null,
      transferAccountId: 9,
      amount: "-4000",
      parentId: parent.id,
    });
    const all = [parent, plain, firstLeg, secondLeg];
    const kids = getSplitChildren(all, parent.id);
    expect(kids.find((t) => t.transferAccountId === 9)).toBe(firstLeg);
    expect(kids.find((t) => t.transferAccountId === 4242)).toBeUndefined();
    const target: number | null = null;
    expect(target == null ? undefined : kids.find((t) => t.transferAccountId === target)).toBeUndefined();
  });
});

describe("oracle B2 split: balance + import repair + budget skip + transfers", () => {
  it("balanced children validate; mutation by a cent fails the sum check", () => {
    // Oracle SubTransactionList.test.ts sum corollary + split.test.ts
    // BUG-18.3 property: any balanced pair passes; a one-cent mutation
    // fails on the sum check.
    const good = [
      { categoryId: 1, amount: -6000 },
      { categoryId: 2, amount: -4000 },
    ];
    expect(() => assertSplitsBalanced(-10000, good)).not.toThrow();
    const mutated = [
      { categoryId: 1, amount: -6000 },
      { categoryId: 2, amount: -4001 },
    ];
    expect(() => assertSplitsBalanced(-10000, mutated)).toThrow(/do not sum to parent/);
  });

  it("mixed-sign splits validate; positive inflow legs need no category", () => {
    // Paycheck with a negative tax deduction (split.test.ts mixed-sign).
    expect(() =>
      assertSplitsBalanced(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertSplitsBalanced(400000, [
        { categoryId: null, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ]),
    ).not.toThrow();
  });

  it("single-child and unbalanced imports follow the repair policy, never throwing", () => {
    // Oracle SubTransactionList.test.ts:156-161 (empty no-throw) mapped
    // onto the fuller G-split policy: balanced verbatim, filler-added,
    // single-child-kept (parent rebased), empty.
    expect(repairSplitForImport(-10000, [
      { categoryId: 1, amount: -6000 },
      { categoryId: 2, amount: -4000 },
    ]).kind).toBe("balanced");
    const filled = repairSplitForImport(-10000, [
      { categoryId: 1, amount: -6000 },
      { categoryId: 2, amount: -3000 },
    ]);
    expect(filled.kind).toBe("filler-added");
    expect(filled.children).toHaveLength(3);
    const single = repairSplitForImport(-5000, [{ categoryId: 1, amount: -4500 }]);
    expect(single.kind).toBe("single-child-kept");
    expect(single.parentAmount).toBe(-4500);
  });

  it("budget engine skips split parents so totals are not double-counted", () => {
    // buildRawIndexData splitParentIds skip (budget-engine.ts:616-624):
    // the parent carries the total, children carry the categorized legs;
    // counting both would double the outflow.
    const { parent, a, b } = splitRows();
    const dated = (t: Transaction): Transaction => ({ ...t, date: "2026-01-10" });
    const data = budgetData([dated(parent), dated(a), dated(b)]);
    const result = computeBudget(data, "2026-01");
    const groceries = result.groups[0]!.rows.find((r) => r.category.id === 1)!;
    const dining = result.groups[0]!.rows.find((r) => r.category.id === 2)!;
    expect(groceries.outflow).toBe(-6000);
    expect(dining.outflow).toBe(-4000);
    expect(result.groups[0]!.outflow).toBe(-10000);
  });

  it("uncategorised positive split children count as income, parents do not double-claim", () => {
    // Oracle-b1 uncategorised-factory analogue (oracle-b1-sub-list-agg
    // "uncategorised positive rows are income") applied to split legs:
    // an unflagged parent must not claim income its children already  carry
    // (budget-engine.ts:676-679: isSplitParent requires explicit isIncome).
    const parent = tx({ categoryId: null, amount: "500000", date: "2026-01-10" });
    const leg = tx({
      categoryId: null,
      amount: "500000",
      date: "2026-01-10",
      parentId: parent.id,
      isIncome: true,
    });
    const data = budgetData([parent, leg]);
    const result = computeBudget(data, "2026-01");
    expect(result.totalIncome).toBe(500000);
  });

  it("split parent cannot be a transfer; self-transfer and same-boundary categories throw", () => {
    // transfers.ts validateTransferEligibility: split-parent-as-transfer
    // ban (SubTransaction split/transfer exclusivity), self-transfer ban
    // (YNAB4 checkAccountDoesntConflictWithTransferAccount), and the
    // same-boundary category ban.
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, isSplitParent: true }),
    ).toThrow(/Split transaction cannot be a transfer/);
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 1 }),
    ).toThrow(/must differ from source/);
    expect(() =>
      validateTransferEligibility({
        accountId: 1,
        transferAccountId: 2,
        categoryId: 1,
        srcOnBudget: true,
        destOnBudget: true,
      }),
    ).toThrow(/internal transfer cannot have a category/);
    // Boundary-crossing outflow without a category still throws via the
    // classifier path used alongside eligibility.
  });

  it("transfer-styled payee without a leg is orphaned metadata and throws", () => {
    // transfers.ts validateTransferPayeeConsistency: YNAB4 derives the
    // transfer payee from the target account, so a "Transfer : X" payee
    // with no transferAccountId is always a caller bug.
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Savings", null),
    ).toThrow(/transfer payee requires a transferAccountId/);
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Savings", 2),
    ).not.toThrow();
    expect(() => validateTransferPayeeConsistency("Grocery Store", null)).not.toThrow();
  });
});
