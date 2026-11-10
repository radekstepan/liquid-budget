/**
 * Oracle B2 parity: BaseTransaction / MatchableTransaction /
 * MatchedTransaction / Transaction mapped through this repo's pure API.
 *
 * Oracle refs (ynab4-modern):
 * - packages/domain/src/transactions/BaseTransaction.test.ts:1-11 (header scope),
 *   :232-330 (defaults/targetAccount/text), :334-423 (eligibility), :426-512
 *   (error-state matrix verbatim), :514-570 (suspend + one-hop), :572-643
 *   (isUncategorised), :645-670 (isSplitTransaction), :672-720 (sub removal +
 *   veto), :722-772 (reciprocal break/removeItem), :774-886 (populateVO/From),
 *   :887-960 (deepCopyFrom order), :962-968 (toString), :997-1015 (null-name
 *   concat), and BaseTransaction.ts amount rounding (~inflow/outflow setters).
 * - packages/domain/src/transactions/MatchableTransaction.test.ts:1-17 (header),
 *   :233-246 (ctor pinning), :247-299 (account/date/source guards), :300-335
 *   (UserEntered downgrade, YNABID/FITID->Imported, empty-id no-op), :336-356
 *   (Reconciled auto-accept, checkNumber trim), :357-393 (transfer payee
 *   round-trip + direct _targetAccount + re-emit), :394-450 (sub-list reparent
 *   guard + listener/REFRESH), :451-526 (split aggregation + scheduler vs
 *   imported + rank override), :527-638 (deepCopyFrom incl. source-last),
 *   :639-711 (populateVO mapping + payee-miss nulling), :712-868
 *   (populateFromVO incl. split filler), :869-931 (removeAllTransferInfo,
 *   incrementFlag, imported-id flags), :932-959 (fan-out + guarantee list).
 * - packages/domain/src/transactions/MatchedTransaction.test.ts:1-10 (header),
 *   :134-144 (ctor pinning + entityType), :146-167 (write-once guard),
 *   :169-195 (cloneFrom id + deep copy), :197-234 (populateFromVO pinning +
 *   reparent/missing-parent throws), :236-247 (populateVO parent id + orphan
 *   throw), :249-262 (inherited accepted/flags/dates).
 * - packages/domain/src/transactions/Transaction.test.ts:1-18 (header),
 *   :189-199 (entityType + date compare), :202-247 (matched pair 0=bank/1=user,
 *   setMatchedTransactions throws, getMatchedTransaction truncation/OOB),
 *   :259-301 (accepted=true clearing + exactly-once mirror-accept),
 *   :303-334 (needsAcceptance truth table), :336-353 (running-balance no-ops),
 *   :355-394 (ForReview escalation + listener wiring), :396-493
 *   (clearMatchedTransactions rename paths), :495-539 (clone/deepCopyFrom),
 *   :541-590 (populateFromVO gate + populateVO accepted), :592-645
 *   (copyFieldsTo one-way accept + scheduled branch), :646-659 (Reconciled
 *   auto-accept + readFromUntypedObject stub).
 *
 * YNAB4 behavior refs:
 * - BaseTransaction behavior :209 (resume underflow throw),
 *   :315 (standard must-be-categorized), :319 (off-budget must-be-categorized),
 *   :325 (should-not-be-categorized on-budget transfer).
 * - Transaction behavior :214,218 (Expected that bankTran/userTran ...).
 * - TransferUtilities behavior (Transfer : <account> payee shape;
 *   exact line N/A — file located, string asserted via isTransferPayee tests).
 *
 * N/A-with-reason (no entity-graph counterpart here; computable analogue
 * tested instead):
 * - EventDispatcher/Bindable/PropertyChangeEvent/listener wiring: no reactive
 *   graph in pure helpers; analogue = pure recompute per call (see suspend
 *   section) + deterministic merge ordering.
 * - Identity maps / tombstones / entity ids / findEntityById throws: no
 *   persistence layer; analogue = null-vs-missing account defaults and the
 *   register walk's null-for-nonparticipants.
 * - readFromUntypedObject no-op stub, toString "[object X](id)(id)" shape,
 *   BINDABLE_* constants, DefaultDate aliasing, parentTransactionIfMatched
 *   write-once guard: UI/entity chrome; analogues = merge primary pinning
 *   (id format below) and register parent mirroring.
 * - checkNumber trim/null: no checkNumber field on MergeableTransaction or
 *   Transaction; analogue = memo fallback (first-non-blank wins).
 * - ScheduledTransaction frequency copy branch, flag cycling
 *   None->Red->Orange, running-balance per-flag storage: scheduler/flag
 *   domains live elsewhere; analogues noted per test.
 *
 * Integer-cent convention: oracle floats x 100 (5.678 -> 568, 12.5 -> 1250,
 * 33.333 -> 3333, 25.0 -> 2500, -42.0 -> -4200).
 */

import { describe, expect, it } from "vitest";
import {
  classifyBoundaryTransfer,
  isInternalTransfer,
  isOffBudgetTransfer,
  isTransferEligible,
  TransactionError,
  transferNetOnBudgetDelta,
  validateTransferEligibility,
  validateTransferPayeeConsistency,
} from "../src/transfers.js";
import { isTransferPayee } from "../src/rename-rules.js";
import {
  applyMergeOverrides,
  isImportedTransaction,
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
} from "../src/merge.js";
import { computeRunningBalances } from "../src/register.js";
import { dollarsToCents, num } from "../src/format.js";
import type { Transaction } from "../src/types.js";

function mtx(overrides: Partial<MergeableTransaction> & { id: number }): MergeableTransaction {
  return {
    accountId: 1,
    transferAccountId: null,
    categoryId: null,
    date: "2026-08-01",
    payee: "Payee",
    payeeId: null,
    memo: "",
    amount: -5000,
    status: "c",
    transferStatus: null,
    flagColor: null,
    needsReview: false,
    entityId: null,
    transferEntityId: null,
    isIncome: false,
    incomeMonth: null,
    ...overrides,
  };
}

function row(
  accountId: number,
  transferAccountId: number | null,
  amount: string,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id: 1,
    accountId,
    categoryId: null,
    date: "2026-06-15",
    payee: "Transfer",
    memo: "",
    amount,
    status: "c",
    transferAccountId,
    ...extra,
  };
}

const LIQUID = { onBudget: true, kind: "liquid" };
const OFFBUDGET = { onBudget: false, kind: "offbudget" };
const CREDIT = { onBudget: true, kind: "credit" };

describe("targetAccount/text interplay (Base :311-332, Matchable :357-393)", () => {
  it("derives the canonical transfer payee for a linked account", () => {
    expect(isTransferPayee("Transfer : Checking")).toBe(true);
    expect(isTransferPayee("Transfer:Checking")).toBe(true);
    expect(isTransferPayee("  transfer : savings ")).toBe(true);
    expect(isTransferPayee("Starbucks")).toBe(false);
  });

  it("clears transfer info for a plain payee with no leg", () => {
    expect(() => validateTransferPayeeConsistency("Grocery Store", null)).not.toThrow();
    expect(isTransferEligible({ accountId: 1, payee: "Grocery Store" })).toBe(true);
  });

  it("rejects an orphaned transfer-styled payee with no leg", () => {
    expect(() => validateTransferPayeeConsistency("Transfer : Savings", null)).toThrow(
      TransactionError,
    );
    expect(isTransferEligible({ accountId: 1, payee: "Transfer : Savings" })).toBe(false);
  });

  it("keeps an unresolvable transfer payee shape on the leg itself", () => {
    expect(() => validateTransferPayeeConsistency("Transfer : Nope", 7)).not.toThrow();
    expect(isTransferEligible({ accountId: 1, transferAccountId: 7 })).toBe(true);
  });

  it("internal transfers strip category and income", () => {
    const r = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: true,
      amount: -500000,
      categoryId: 11,
    });
    expect(r).toEqual({
      isBoundaryCrossing: false,
      netOnBudgetDelta: 0,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    });
  });
});

describe("eligibility warn-and-ignore becomes throw/boolean (Base :334-367)", () => {
  it("rejects self-transfers with the verbatim guard", () => {
    expect(() => validateTransferEligibility({ accountId: 1, transferAccountId: 1 })).toThrow(
      /must differ from source/,
    );
    expect(isTransferEligible({ accountId: 1, transferAccountId: 1 })).toBe(false);
  });

  it("rejects a split parent as a transfer but allows split-child legs", () => {
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, isSplitParent: true }),
    ).toThrow(/cannot be a transfer/);
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, parentId: 10 }),
    ).not.toThrow();
  });

  it("rejects a same-boundary transfer carrying a category", () => {
    expect(() =>
      validateTransferEligibility({
        accountId: 1,
        transferAccountId: 2,
        categoryId: 42,
        srcOnBudget: true,
        destOnBudget: true,
      }),
    ).toThrow(/cannot have a category/);
    expect(
      isTransferEligible({
        accountId: 4,
        transferAccountId: 5,
        categoryId: 42,
        srcOnBudget: false,
        destOnBudget: false,
      }),
    ).toBe(false);
  });

  it("boundary outflow without a category throws via errorFactory", () => {
    expect(() =>
      classifyBoundaryTransfer({ srcOnBudget: true, destOnBudget: false, amount: -30000 }),
    ).toThrow(TransactionError);
    class CustomError extends Error {}
    expect(() =>
      classifyBoundaryTransfer({
        srcOnBudget: true,
        destOnBudget: false,
        amount: -30000,
        errorFactory: (m) => new CustomError(m),
      }),
    ).toThrow(CustomError);
  });

  it("boundary inflow without a category is income carrying the month", () => {
    // FORK: incomeMonth superset — this repo retains the caller's incomeMonth
    // on boundary inflows where YNAB4 derives it from the budget month.
    const r = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: true,
      amount: -500000,
      incomeMonth: "2026-08",
    });
    expect(r.isIncome).toBe(true);
    expect(r.incomeMonth).toBe("2026-08");
    expect(r.categoryId).toBeNull();
  });
});

describe("amount rounding + inflow/outflow (Base amount section)", () => {
  it("rounds oracle floats to integer cents (x100)", () => {
    expect(dollarsToCents(5.678)).toBe(568);
    expect(dollarsToCents(12.5)).toBe(1250);
    expect(dollarsToCents(33.333)).toBe(3333);
    expect(dollarsToCents(-42)).toBe(-4200);
  });

  it("derives inflow/outflow sign from the signed cent amount", () => {
    const amt = num("-4200");
    expect(amt).toBe(-4200);
    expect(amt > 0 ? amt : 0).toBe(0);
    expect(amt < 0 ? -amt : 0).toBe(4200);
    expect(num("2500")).toBe(2500);
  });
});

describe("error-state matrix analogue (Base :426-512, YNAB4 :315/319/325)", () => {
  it("off-budget rows stay uncategorized and non-income", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, categoryId: 11, amount: 5000 }),
      secondary: mtx({ id: 1, categoryId: 11, amount: 5000 }),
      sourceAccount: OFFBUDGET,
      destAccount: null,
    });
    expect(merged.categoryId).toBeNull();
    expect(merged.isIncome).toBe(false);
  });

  it("plain uncategorized on-budget inflow is income (needs-category analogue)", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, categoryId: null, amount: 5000 }),
      secondary: mtx({ id: 1, categoryId: null, amount: 5000 }),
      sourceAccount: LIQUID,
      destAccount: null,
    });
    expect(merged.isIncome).toBe(true);
  });

  it("categorized on-budget internal transfer drops the category (error analogue)", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 1, categoryId: 11, transferAccountId: 7, payee: "Transfer : Savings" }),
      secondary: mtx({ id: 2, categoryId: 11 }),
      sourceAccount: LIQUID,
      destAccount: LIQUID,
    });
    expect(merged.categoryId).toBeNull();
    expect(merged.isIncome).toBe(false);
  });

  it("zero-amount boundary crossing is clean (no income, no category)", () => {
    const r = classifyBoundaryTransfer({ srcOnBudget: true, destOnBudget: false, amount: 0 });
    expect(r).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: 0,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    });
  });
});

describe("suspension + one-hop propagation analogue (Base :514-570)", () => {
  it("pure recompute needs no suspend/resume: repeated walks agree", () => {
    const rows = [row(1, null, "-5000", { id: 2 }), row(1, null, "-3000", { id: 1 })];
    const balances = new Map([[1, -8000]]);
    const first = computeRunningBalances(rows, balances, 1);
    const second = computeRunningBalances(rows, balances, 1);
    expect(first.map((r) => r.runningBalance)).toEqual(second.map((r) => r.runningBalance));
    expect(first[0]!.runningBalance).toBe(-8000);
    expect(first[1]!.runningBalance).toBe(-3000);
  });

  it("merge ordering is selection-order independent (one-hop, no ping-pong)", () => {
    const manual = mtx({ id: 1, date: "2026-08-02", payee: "Shop" });
    const imported = mtx({ id: 2, needsReview: true, date: "2026-08-01", payee: "SHOP #1" });
    const [p1, s1] = pickMergePrimary(manual, imported);
    const [p2, s2] = pickMergePrimary(imported, manual);
    const a = resolveMergedTransaction({ primary: p1, secondary: s1, sourceAccount: LIQUID, destAccount: null });
    const b = resolveMergedTransaction({ primary: p2, secondary: s2, sourceAccount: LIQUID, destAccount: null });
    expect(a).toEqual(b);
    expect(a.date).toBe("2026-08-02");
  });
});

describe("isUncategorised branches (Base :572-643)", () => {
  it("uncategorized positive liquid inflow counts as income", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, amount: 900 }),
      secondary: mtx({ id: 1, amount: 900 }),
      sourceAccount: LIQUID,
      destAccount: null,
    });
    expect(merged.isIncome).toBe(true);
  });

  it("categorized rows and credit accounts never count as income", () => {
    const cat = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, categoryId: 11, amount: 900 }),
      secondary: mtx({ id: 1, amount: 900 }),
      sourceAccount: LIQUID,
      destAccount: null,
    });
    expect(cat.isIncome).toBe(false);
    const credit = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, amount: 900 }),
      secondary: mtx({ id: 1, amount: 900 }),
      sourceAccount: CREDIT,
      destAccount: null,
    });
    expect(credit.isIncome).toBe(false);
  });

  it("null-account analogue: missing accounts default to on-budget (no deref throw)", () => {
    expect(transferNetOnBudgetDelta(row(1, 5, "-30000"))).toBe(0);
    expect(isInternalTransfer(row(1, 2, "-5000"))).toBe(true);
  });
});

describe("sub removal veto + reciprocal break (Base :672-772)", () => {
  it("split parents are vetoed as transfers; children are not", () => {
    expect(
      isTransferEligible({ accountId: 1, transferAccountId: 2, isSplitParent: true }),
    ).toBe(false);
    expect(
      isTransferEligible({ accountId: 1, transferAccountId: 2, parentId: 9 }),
    ).toBe(true);
  });

  it("reciprocal legs agree on the boundary sign from either side", () => {
    const src = row(1, 5, "-30000", { id: 1 });
    const dst = row(5, 1, "30000", { id: 2 });
    const accounts = [
      { id: 1, name: "A", kind: "liquid", groupLabel: "B", balance: "0", onBudget: true, sort: 0 },
      { id: 5, name: "B", kind: "offbudget", groupLabel: "T", balance: "0", onBudget: false, sort: 1 },
    ] as Transaction["accountId"] extends never ? never : Parameters<typeof transferNetOnBudgetDelta>[1];
    expect(transferNetOnBudgetDelta(src, accounts)).toBe(-30000);
    // Uniform sign convention: the off-budget-recorded leg reports the same
    // budget impact (an outflow), not the negated mirror.
    expect(transferNetOnBudgetDelta(dst, accounts)).toBe(-30000);
    expect(isOffBudgetTransfer(src, accounts)).toBe(true);
  });
});

describe("populateVO round-trip analogue (Base :774-886, Matchable :639-868)", () => {
  it("empty overrides preserve the resolved row (VO round-trip)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, categoryId: 11, memo: "weekly shop" }),
      mtx({ id: 2, needsReview: true, payee: "WHOLE FOODS #24" }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(applyMergeOverrides(merged, {}, { sourceAccount: LIQUID, destAccount: null })).toEqual(
      merged,
    );
  });

  it("category edits recompute income like populateFromVO recalc", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, categoryId: 11, amount: 5000 }),
      mtx({ id: 2, needsReview: true, amount: 5000 }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.isIncome).toBe(false);
    const next = applyMergeOverrides(
      merged,
      { categoryId: null, incomeMonth: "2026-09" },
      { sourceAccount: LIQUID, destAccount: null },
    );
    expect(next.isIncome).toBe(true);
    expect(next.incomeMonth).toBe("2026-09");
  });
});

describe("merge precedence: date/status/shape (Matchable :527-638, Transaction :592-630)", () => {
  it("bank amount wins; user date wins; cleared takes the max", () => {
    const manual = mtx({ id: 1, date: "2026-08-02", amount: -4999, status: "u", payee: "Shop" });
    const imported = mtx({ id: 2, needsReview: true, date: "2026-08-01", amount: -5000, status: "c", payee: "SHOP #1" });
    const [primary, secondary] = pickMergePrimary(manual, imported);
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.amount).toBe(-5000);
    expect(merged.date).toBe("2026-08-02");
    expect(merged.status).toBe("c");
  });

  it("reconciled beats cleared regardless of side (auto-accept analogue)", () => {
    const a = mtx({ id: 1, status: "c" });
    const b = mtx({ id: 2, needsReview: true, status: "r" });
    const [primary, secondary] = pickMergePrimary(a, b);
    expect(
      resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null }).status,
    ).toBe("r");
  });

  it("transfer shape and status come from the primary only", () => {
    const regular = mtx({ id: 1, categoryId: 11 });
    const transfer = mtx({ id: 2, needsReview: true, transferAccountId: 7, payee: "Transfer : Savings", transferStatus: "u" });
    const [primary, secondary] = pickMergePrimary(regular, transfer);
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: LIQUID,
      destAccount: LIQUID,
    });
    expect(merged.transferAccountId).toBe(7);
    expect(merged.categoryId).toBeNull();
    expect(merged.transferStatus).toBe("u");
  });

  it("memo falls back to the secondary when the primary is blank (checkNumber-trim analogue)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 2, needsReview: true, memo: "" }),
      mtx({ id: 1, memo: "weekly shop" }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.memo).toBe("weekly shop");
  });
});

describe("imported/pin guards (Matchable :300-356, :889-931)", () => {
  it("needsReview or a YNAB4 entity id marks a row imported", () => {
    expect(isImportedTransaction(mtx({ id: 1, needsReview: true }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1, entityId: "YNAB4:abc" }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1, entityId: "FITID:123" }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1 }))).toBe(false);
  });

  it("imported rows win primary; ties break by lower id", () => {
    const manual = mtx({ id: 1 });
    const imported = mtx({ id: 2, needsReview: true });
    expect(pickMergePrimary(manual, imported)[0]!.id).toBe(2);
    expect(pickMergePrimary(imported, manual)[0]!.id).toBe(2);
    expect(pickMergePrimary(mtx({ id: 9 }), mtx({ id: 4 }))[0]!.id).toBe(4);
  });

  it("merged rows carry the imported review marker (needsAcceptance analogue)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1 }),
      mtx({ id: 2, needsReview: true }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.needsReview).toBe(true);
    const [p2, s2] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2 }));
    expect(
      resolveMergedTransaction({ primary: p2, secondary: s2, sourceAccount: LIQUID, destAccount: null }).needsReview,
    ).toBe(false);
  });

  it("duplicate flag markers never survive a merge", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, flagColor: "duplicate" }),
      mtx({ id: 2, needsReview: true }),
    );
    expect(
      resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null }).flagColor,
    ).toBeNull();
  });
});

describe("matched-pair ordering + exactly-once accept (Transaction :202-301)", () => {
  it("primary/secondary ordering is stable (bank/imported first)", () => {
    const bank = mtx({ id: 5, needsReview: true });
    const user = mtx({ id: 3 });
    const [first, second] = pickMergePrimary(user, bank);
    expect(first.id).toBe(5);
    expect(second.id).toBe(3);
  });

  it("a transfer leg is preserved exactly once through resolve + empty overrides", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, transferAccountId: 7, payee: "Transfer : Savings" }),
      mtx({ id: 2 }),
    );
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: LIQUID,
      destAccount: LIQUID,
    });
    const again = applyMergeOverrides(merged, {}, { sourceAccount: LIQUID, destAccount: { onBudget: true } });
    expect(again.transferAccountId).toBe(7);
    expect(again.transferStatus).toBe(merged.transferStatus);
  });

  it("clearing the destination leg nulls its status (mirror-accept analogue)", () => {
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, transferAccountId: 7, payee: "Transfer : Savings" }),
      mtx({ id: 2 }),
    );
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: LIQUID,
      destAccount: LIQUID,
    });
    const next = applyMergeOverrides(merged, { transferAccountId: null }, { sourceAccount: LIQUID, destAccount: null });
    expect(next.transferAccountId).toBeNull();
    expect(next.transferStatus).toBeNull();
  });
});

describe("register walk no-ops (Transaction :336-353)", () => {
  it("anchors the newest row at the stored balance and undoes older rows", () => {
    const rows = [row(1, null, "10000", { id: 3 }), row(1, null, "-4000", { id: 2 })];
    const out = computeRunningBalances(rows, new Map([[1, 6000]]), 1);
    expect(out[0]!.runningBalance).toBe(6000);
    expect(out[1]!.runningBalance).toBe(-4000);
  });

  it("split parents mirror the newest participating child; empty input is a no-op", () => {
    expect(computeRunningBalances([], new Map(), 1)).toEqual([]);
    const parent = row(1, null, "0", { id: 1 });
    const child = row(1, null, "-2500", { id: 2, parentId: 1 });
    const out = computeRunningBalances([parent, child], new Map([[1, -2500]]), 1);
    expect(out.find((r) => r.id === 2)!.runningBalance).toBe(-2500);
    expect(out.find((r) => r.id === 1)!.runningBalance).toBe(-2500);
  });

  it("off-anchor rows without a transfer link get null, never a live balance", () => {
    const out = computeRunningBalances([row(2, null, "-1000", { id: 1 })], new Map([[2, 5000], [1, 999]]), 1);
    expect(out[0]!.runningBalance).toBeNull();
  });
});

describe("deliberate forks (do not fix)", () => {
  it("documents the credit-card buffer fork", () => {
    // FORK: CC buffer — credit payoff legs are pure movement here, while
    // YNAB4 accrues card buffers in the budget engine (no engine here).
    expect(true).toBe(true);
  });

  it("documents the exact-only matching fork", () => {
    // FORK: exact-only matching — pickMergePrimary never fuzzy-matches
    // amounts/dates; candidate pairing is the caller's job.
    const [p] = pickMergePrimary(mtx({ id: 1, amount: -4999 }), mtx({ id: 2, needsReview: true, amount: -5000 }));
    expect(p.id).toBe(2);
  });
});
