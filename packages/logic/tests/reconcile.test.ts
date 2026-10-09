import { describe, expect, it } from "vitest";
import { applyOptimisticReconcileFlips, computeReconcileState } from "../src/reconcile.js";
import type { Account, Transaction } from "../src/types.js";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Chequing",
    kind: "liquid",
    groupLabel: "Budget",
    balance: "0",
    onBudget: true,
    sort: 0,
    lastReconciledAt: null,
    lastReconciledBalance: null,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2026-06-01",
    payee: "",
    memo: "",
    amount: "0",
    status: "c",
    ...overrides,
  };
}

describe("computeReconcileState", () => {
  it("computes working balance, uncleared total, and counts for simple transactions", () => {
    const acct = makeAccount({ id: 1, name: "Chequing" });
    const txns: Transaction[] = [
      makeTx({ id: 1, accountId: 1, amount: "50000", status: "c", date: "2026-06-01" }),
      makeTx({ id: 2, accountId: 1, amount: "10000", status: "r", date: "2026-06-02" }),
      makeTx({ id: 3, accountId: 1, amount: "-5000", status: "u", date: "2026-06-03" }),
      makeTx({ id: 4, accountId: 2, amount: "99999", status: "c", date: "2026-06-01" }), // Other account
    ];

    const state = computeReconcileState(acct, txns, "2026-06-30");
    expect(state).toEqual({
      accountId: 1,
      accountName: "Chequing",
      workingBalance: 60000,
      unclearedTotal: -5000,
      unclearedCount: 1,
      clearedCount: 1,
      reconciledCount: 1,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    });
  });

  it("excludes split parent transactions to avoid double-counting child amounts", () => {
    const acct = makeAccount({ id: 1, name: "Chequing" });
    const txns: Transaction[] = [
      // Plain cleared transaction: +10000
      makeTx({ id: 1, accountId: 1, amount: "10000", status: "c", date: "2026-06-01" }),
      // Cleared split transaction: parent -5000, children -3000 and -2000
      makeTx({ id: 2, accountId: 1, amount: "-5000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 3, accountId: 1, parentId: 2, amount: "-3000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 4, accountId: 1, parentId: 2, amount: "-2000", status: "c", date: "2026-06-02" }),
      // Uncleared split transaction: parent -4000, children -2500 and -1500
      makeTx({ id: 5, accountId: 1, amount: "-4000", status: "u", date: "2026-06-03" }),
      makeTx({ id: 6, accountId: 1, parentId: 5, amount: "-2500", status: "u", date: "2026-06-03" }),
      makeTx({ id: 7, accountId: 1, parentId: 5, amount: "-1500", status: "u", date: "2026-06-03" }),
      // Reconciled split transaction: parent +2000, children +1200 and +800
      makeTx({ id: 8, accountId: 1, amount: "2000", status: "r", date: "2026-05-01" }),
      makeTx({ id: 9, accountId: 1, parentId: 8, amount: "1200", status: "r", date: "2026-05-01" }),
      makeTx({ id: 10, accountId: 1, parentId: 8, amount: "800", status: "r", date: "2026-05-01" }),
    ];

    const state = computeReconcileState(acct, txns, "2026-06-30");
    // clearedSum: 10000 + -3000 + -2000 = 5000 (clearedCount: 3 -> tx 1, 3, 4)
    // reconciledSum: 1200 + 800 = 2000 (reconciledCount: 2 -> tx 9, 10)
    // workingBalance: 5000 + 2000 = 7000
    // unclearedTotal: -2500 + -1500 = -4000 (unclearedCount: 2 -> tx 6, 7)
    expect(state.workingBalance).toBe(7000);
    expect(state.clearedCount).toBe(3);
    expect(state.reconciledCount).toBe(2);
    expect(state.unclearedTotal).toBe(-4000);
    expect(state.unclearedCount).toBe(2);
  });

  it("BUG-19: includes split parent total in clearedSum when parent is status 'c' and children have status 'u'", () => {
    const acct = makeAccount({ id: 1, name: "Chequing" });
    const txns: Transaction[] = [
      // Split parent toggled to cleared in UI ('c'), but children are 'u'
      makeTx({ id: 1, accountId: 1, amount: "-5000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 2, accountId: 1, parentId: 1, amount: "-3000", status: "u", date: "2026-06-02" }),
      makeTx({ id: 3, accountId: 1, parentId: 1, amount: "-2000", status: "u", date: "2026-06-02" }),
    ];

    const state = computeReconcileState(acct, txns, "2026-06-30");
    // clearedSum: -3000 + -2000 = -5000 (clearedCount: 2)
    // unclearedTotal: 0 (unclearedCount: 0)
    expect(state.workingBalance).toBe(-5000);
    expect(state.clearedCount).toBe(2);
    expect(state.unclearedTotal).toBe(0);
    expect(state.unclearedCount).toBe(0);
  });

  it("includes inbound transfers with inverted sign for the destination account", () => {
    const srcAcct = makeAccount({ id: 1, name: "Chequing" });
    const destAcct = makeAccount({ id: 2, name: "Savings" });

    const txns: Transaction[] = [
      // Outflow from Chequing (-10000) to Savings (+10000)
      makeTx({
        id: 1,
        accountId: 1,
        transferAccountId: 2,
        amount: "-10000",
        status: "c",
        date: "2026-06-01",
      }),
      // Uncleared outflow from Chequing (-2500) to Savings (+2500)
      makeTx({
        id: 2,
        accountId: 1,
        transferAccountId: 2,
        amount: "-2500",
        status: "u",
        date: "2026-06-02",
      }),
    ];

    const srcState = computeReconcileState(srcAcct, txns, "2026-06-30");
    expect(srcState.workingBalance).toBe(-10000);
    expect(srcState.clearedCount).toBe(1);
    expect(srcState.unclearedTotal).toBe(-2500);
    expect(srcState.unclearedCount).toBe(1);

    const destState = computeReconcileState(destAcct, txns, "2026-06-30");
    expect(destState.workingBalance).toBe(10000);
    expect(destState.clearedCount).toBe(1);
    expect(destState.unclearedTotal).toBe(2500);
    expect(destState.unclearedCount).toBe(1);
  });

  it("handles independent transferStatus on source and destination accounts", () => {
    const srcAcct = makeAccount({ id: 1, name: "Checking" });
    const destAcct = makeAccount({ id: 2, name: "Savings" });

    const txns: Transaction[] = [
      makeTx({
        id: 1,
        accountId: 1,
        transferAccountId: 2,
        amount: "-50000",
        status: "r", // Source is reconciled
        transferStatus: "u", // Destination is uncleared
        date: "2026-06-01",
      }),
    ];

    const srcState = computeReconcileState(srcAcct, txns, "2026-06-30");
    expect(srcState.reconciledCount).toBe(1);
    expect(srcState.clearedCount).toBe(0);
    expect(srcState.unclearedCount).toBe(0);
    expect(srcState.workingBalance).toBe(-50000);

    const destState = computeReconcileState(destAcct, txns, "2026-06-30");
    expect(destState.reconciledCount).toBe(0);
    expect(destState.clearedCount).toBe(0);
    expect(destState.unclearedCount).toBe(1);
    expect(destState.unclearedTotal).toBe(50000);
    expect(destState.workingBalance).toBe(0);
  });

  it("includes inbound split child transfers on the destination account", () => {
    const destAcct = makeAccount({ id: 2, name: "Savings" });
    const txns: Transaction[] = [
      // Split parent on account 1
      makeTx({
        id: 10,
        accountId: 1,
        amount: "-50000",
        status: "c",
        date: "2026-06-03",
      }),
      // Regular child on account 1
      makeTx({
        id: 11,
        accountId: 1,
        parentId: 10,
        amount: "-47000",
        status: "c",
        date: "2026-06-03",
      }),
      // Transfer child to account 2 (Savings)
      makeTx({
        id: 12,
        accountId: 1,
        parentId: 10,
        transferAccountId: 2,
        amount: "-3000",
        status: "c",
        date: "2026-06-03",
      }),
    ];

    const destState = computeReconcileState(destAcct, txns, "2026-06-30");
    expect(destState.workingBalance).toBe(3000);
    expect(destState.clearedCount).toBe(1);
  });

  it("respects statement date boundary and filters out future-dated transactions", () => {
    const acct = makeAccount({ id: 1, name: "Chequing" });
    const txns: Transaction[] = [
      makeTx({ id: 1, accountId: 1, amount: "50000", status: "c", date: "2026-06-15" }),
      makeTx({ id: 2, accountId: 1, amount: "20000", status: "c", date: "2026-07-05" }), // After statement date
      makeTx({ id: 3, accountId: 1, amount: "10000", status: "u", date: "2026-07-10" }), // After statement date
    ];

    const state = computeReconcileState(acct, txns, "2026-06-30");
    expect(state.workingBalance).toBe(50000);
    expect(state.clearedCount).toBe(1);
    expect(state.unclearedTotal).toBe(0);
    expect(state.unclearedCount).toBe(0);
  });

  it("preserves lastReconciledAt and lastReconciledBalance from account", () => {
    const acct = makeAccount({
      id: 1,
      name: "Chequing",
      lastReconciledAt: "2026-05-31",
      lastReconciledBalance: "45000",
    });

    const state = computeReconcileState(acct, [], "2026-06-30");
    expect(state.lastReconciledAt).toBe("2026-05-31");
    expect(state.lastReconciledBalance).toBe(45000);
  });
});

describe("applyOptimisticReconcileFlips", () => {
  const byId = (txns: Transaction[]) => new Map(txns.map((t) => [t.id, t]));

  it("flips in-scope cleared source rows and leaves everything else untouched", () => {
    const txns: Transaction[] = [
      makeTx({ id: 1, accountId: 1, amount: "50000", status: "c", date: "2026-06-01" }),
      makeTx({ id: 2, accountId: 1, amount: "20000", status: "c", date: "2026-07-05" }), // after statement date
      makeTx({ id: 3, accountId: 1, amount: "-5000", status: "u", date: "2026-06-01" }), // uncleared: never flipped
      makeTx({ id: 4, accountId: 1, amount: "10000", status: "r", date: "2026-06-01" }), // already reconciled
      makeTx({ id: 5, accountId: 2, amount: "99999", status: "c", date: "2026-06-01" }), // other account
    ];

    const next = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    const map = byId(next);
    expect(map.get(1)!.status).toBe("r");
    expect(map.get(2)!.status).toBe("c");
    expect(map.get(3)!.status).toBe("u");
    expect(map.get(4)!.status).toBe("r");
    expect(map.get(5)!.status).toBe("c");
    // Untouched rows keep their identity so callers can diff the affected set.
    expect(next[1]).toBe(txns[1]);
    expect(next[2]).toBe(txns[2]);
    expect(next[3]).toBe(txns[3]);
    expect(next[4]).toBe(txns[4]);
  });

  it("clears needsReview on flipped rows", () => {
    const txns: Transaction[] = [
      makeTx({ id: 1, accountId: 1, amount: "50000", status: "c", date: "2026-06-01", needsReview: true }),
    ];

    const next = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    expect(next[0]).toEqual(expect.objectContaining({ status: "r", needsReview: false }));
  });

  it("flips inbound transfer legs via transferStatus without touching status", () => {
    const txns: Transaction[] = [
      makeTx({
        id: 1,
        accountId: 2,
        transferAccountId: 1,
        amount: "-10000",
        status: "c",
        transferStatus: "c",
        date: "2026-06-01",
      }),
      makeTx({
        id: 2,
        accountId: 2,
        transferAccountId: 1,
        amount: "-20000",
        status: "c",
        // Legacy rows carry a null transferStatus and inherit the source status.
        transferStatus: null,
        date: "2026-06-01",
      }),
      makeTx({
        id: 3,
        accountId: 2,
        transferAccountId: 1,
        amount: "-30000",
        status: "c",
        transferStatus: "u",
        date: "2026-06-01",
      }),
      // Outbound transfer from the reconciled account flips source-side only.
      makeTx({
        id: 4,
        accountId: 1,
        transferAccountId: 2,
        amount: "-40000",
        status: "c",
        transferStatus: "c",
        date: "2026-06-01",
      }),
    ];

    const next = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    const map = byId(next);
    expect(map.get(1)).toEqual(expect.objectContaining({ status: "c", transferStatus: "r" }));
    expect(map.get(2)).toEqual(expect.objectContaining({ status: "c", transferStatus: "r" }));
    expect(map.get(3)).toEqual(expect.objectContaining({ status: "c", transferStatus: "u" }));
    expect(map.get(4)).toEqual(expect.objectContaining({ status: "r", transferStatus: "c" }));
  });

  it("flips a split parent only when every child is reconciled", () => {
    const txns: Transaction[] = [
      // Fully cleared split: parent flips once the children flip.
      makeTx({ id: 10, accountId: 1, amount: "-5000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 11, accountId: 1, parentId: 10, amount: "-3000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 12, accountId: 1, parentId: 10, amount: "-2000", status: "c", date: "2026-06-02" }),
      // Partially uncleared split: parent stays cleared.
      makeTx({ id: 20, accountId: 1, amount: "-4000", status: "c", date: "2026-06-03" }),
      makeTx({ id: 21, accountId: 1, parentId: 20, amount: "-2500", status: "c", date: "2026-06-03" }),
      makeTx({ id: 22, accountId: 1, parentId: 20, amount: "-1500", status: "u", date: "2026-06-03" }),
    ];

    const next = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    const map = byId(next);
    expect(map.get(10)!.status).toBe("r");
    expect(map.get(11)!.status).toBe("r");
    expect(map.get(12)!.status).toBe("r");
    expect(map.get(20)!.status).toBe("c");
    expect(map.get(21)!.status).toBe("r");
    expect(map.get(22)!.status).toBe("u");
  });

  it("matches the server: future-dated children keep their parent cleared", () => {
    const txns: Transaction[] = [
      makeTx({ id: 10, accountId: 1, amount: "-5000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 11, accountId: 1, parentId: 10, amount: "-3000", status: "c", date: "2026-06-02" }),
      makeTx({ id: 12, accountId: 1, parentId: 10, amount: "-2000", status: "c", date: "2026-07-05" }),
    ];

    const next = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    const map = byId(next);
    expect(map.get(11)!.status).toBe("r");
    expect(map.get(12)!.status).toBe("c");
    expect(map.get(10)!.status).toBe("c");
  });
});
