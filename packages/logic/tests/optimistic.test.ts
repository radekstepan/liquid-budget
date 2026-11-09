import { describe, expect, it } from "vitest";
import {
  applyAccountDeltas,
  applyOptimisticTransactionDeletion,
  applyPreparedMerge,
  collectSplitAffectedIds,
  invertDeltas,
  isStatusOnlyBulkUpdate,
  isStatusOrFlagOnlyUpdate,
  mapOptimisticAssignId,
  mapOptimisticInsertIds,
  planOptimisticAssign,
  planOptimisticBatchAssign,
  planOptimisticBulkUpdate,
  planOptimisticInsert,
  planOptimisticUpdate,
  prepareOptimisticMerge,
  restoreTransactionRows,
  rollbackOptimisticAssign,
  rollbackOptimisticInsert,
  snapshotTransactions,
  transactionUpdateNeedsReload,
  type BudgetData,
  type Transaction,
} from "../src/index.js";

// All money is integer cents: BudgetData carries cent-strings ("-5000"),
// payload inputs carry cent-numbers (-5000).

function tx(over: Partial<Transaction> & { id: number }): Transaction {
  return {
    accountId: 1,
    categoryId: null,
    date: "2026-01-15",
    payee: "Payee",
    memo: "",
    amount: "1000",
    status: "c",
    ...over,
  };
}

function fixture(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "", balance: "50000", onBudget: true, sort: 1 },
      { id: 3, name: "Card", kind: "credit", groupLabel: "", balance: "-20000", onBudget: true, sort: 2 },
      { id: 4, name: "Tracking", kind: "offbudget", groupLabel: "", balance: "0", onBudget: false, sort: 3 },
    ],
    groups: [],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [{ id: 100, categoryId: 10, month: "2026-01", amount: "30000" }],
    transactions: [
      tx({ id: 1, accountId: 1, categoryId: 10, amount: "-5000" }),
      tx({ id: 2, accountId: 1, categoryId: null, amount: "200000", isIncome: true, incomeMonth: "2026-01" }),
      tx({ id: 3, accountId: 1, transferAccountId: 2, categoryId: null, amount: "-10000", payee: "Transfer : Savings" }),
      // Split parent (id 4) with two children (5, 6)
      tx({ id: 4, accountId: 1, categoryId: null, amount: "-7000" }),
      tx({ id: 5, accountId: 1, categoryId: 10, amount: "-4000", parentId: 4 }),
      tx({ id: 6, accountId: 1, categoryId: 10, amount: "-3000", parentId: 4 }),
    ],
    recurring: [],
  };
}

describe("applyAccountDeltas", () => {
  it("adds cent deltas to balances", () => {
    const prev = fixture();
    const next = applyAccountDeltas(prev.accounts, new Map([[1, -5050]]));
    expect(next.find((a) => a.id === 1)?.balance).toBe("94950");
    expect(next.find((a) => a.id === 2)?.balance).toBe("50000");
  });

  it("returns the same array when there are no deltas", () => {
    const prev = fixture();
    expect(applyAccountDeltas(prev.accounts, new Map())).toBe(prev.accounts);
  });
});

describe("invertDeltas", () => {
  it("negates every entry", () => {
    expect(invertDeltas(new Map([[1, 5], [2, -3]]))).toEqual(new Map([[1, -5], [2, 3]]));
  });

  it("round-trips apply/rollback to the original balances", () => {
    const prev = fixture();
    const deltas = new Map([[1, -1234], [2, 1234]]);
    const applied = applyAccountDeltas(prev.accounts, deltas);
    const rolledBack = applyAccountDeltas(applied, invertDeltas(deltas));
    expect(rolledBack.map((a) => a.balance)).toEqual(prev.accounts.map((a) => a.balance));
  });
});

describe("applyOptimisticTransactionDeletion", () => {
  it("removes a single row and reverses its balance effect", () => {
    const prev = fixture();
    const { nextData, deltas } = applyOptimisticTransactionDeletion(prev, [1]);
    expect(nextData.transactions.map((t) => t.id)).not.toContain(1);
    // -5000 outflow removed => +5000 back to account 1
    expect(deltas.get(1)).toBe(5000);
    expect(nextData.accounts.find((a) => a.id === 1)?.balance).toBe("105000");
    expect(nextData.budgetIndex).toBeUndefined();
  });

  it("reverses both legs of a transfer", () => {
    const prev = fixture();
    const { nextData, deltas } = applyOptimisticTransactionDeletion(prev, [3]);
    expect(nextData.transactions.map((t) => t.id)).not.toContain(3);
    expect(deltas.get(1)).toBe(10000);
    expect(deltas.get(2)).toBe(-10000);
  });

  it("deleting a split parent removes its children too", () => {
    const prev = fixture();
    const { nextData } = applyOptimisticTransactionDeletion(prev, [4]);
    const ids = nextData.transactions.map((t) => t.id);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(6);
    expect(ids).toContain(1);
  });

  it("deleting one child retotals the parent", () => {
    const prev = fixture();
    const withThree: BudgetData = {
      ...prev,
      transactions: [...prev.transactions, tx({ id: 7, accountId: 1, categoryId: 10, amount: "-1000", parentId: 4 })],
    };
    const { nextData } = applyOptimisticTransactionDeletion(withThree, [5]);
    const ids = nextData.transactions.map((t) => t.id);
    expect(ids).toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).toContain(6);
    expect(ids).toContain(7);
    expect(nextData.transactions.find((t) => t.id === 4)?.amount).toBe("-4000.00");
  });

  it("deleting down to one child flattens the split", () => {
    const prev = fixture();
    // Add a third child so deleting two leaves exactly one.
    const withThree: BudgetData = {
      ...prev,
      transactions: [...prev.transactions, tx({ id: 7, accountId: 1, categoryId: 10, amount: "-1000", parentId: 4 })],
    };
    const { nextData } = applyOptimisticTransactionDeletion(withThree, [5, 6]);
    const ids = nextData.transactions.map((t) => t.id);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(6);
    expect(ids).toContain(7);
    expect(nextData.transactions.find((t) => t.id === 7)?.parentId).toBeNull();
  });
});

describe("collectSplitAffectedIds / snapshotTransactions / restoreTransactionRows", () => {
  it("expands ids to parents and siblings", () => {
    const prev = fixture();
    expect(collectSplitAffectedIds(prev.transactions, [5])).toEqual(new Set([5, 4, 6]));
    expect(collectSplitAffectedIds(prev.transactions, [1])).toEqual(new Set([1]));
    expect(collectSplitAffectedIds(prev.transactions, [4])).toEqual(new Set([4, 5, 6]));
  });

  it("rollback restores rows and reverses deltas", () => {
    const prev = fixture();
    const affected = collectSplitAffectedIds(prev.transactions, [1]);
    const snap = snapshotTransactions(prev.transactions, affected);
    const { nextData, deltas } = applyOptimisticTransactionDeletion(prev, [1]);
    const restored = restoreTransactionRows(nextData, affected, snap, deltas);
    expect(restored.transactions).toHaveLength(prev.transactions.length);
    expect(restored.transactions.find((t) => t.id === 1)).toEqual(prev.transactions.find((t) => t.id === 1));
    expect(restored.accounts.find((a) => a.id === 1)?.balance).toBe("100000");
  });

  it("snapshots are copies, immune to later mutation", () => {
    const prev = fixture();
    const affected = collectSplitAffectedIds(prev.transactions, [1]);
    const snap = snapshotTransactions(prev.transactions, affected);
    prev.transactions[0]!.payee = "MUTATED";
    expect(snap[0]?.payee).toBe("Payee");
  });
});

describe("assignments", () => {
  it("plans a new assignment under the temp id", () => {
    const prev = fixture();
    const next = planOptimisticAssign(prev, { categoryId: 10, month: "2026-02", amount: 11160 }, -99);
    const row = next.assignments.find((a) => a.id === -99);
    expect(row).toMatchObject({ categoryId: 10, month: "2026-02", amount: "11160" });
    expect(next.budgetIndex).toBeUndefined();
  });

  it("plans an update to the existing row", () => {
    const prev = fixture();
    const next = planOptimisticAssign(prev, { categoryId: 10, month: "2026-01", amount: 5050 }, -99);
    expect(next.assignments).toHaveLength(1);
    expect(next.assignments[0]).toMatchObject({ id: 100, amount: "5050" });
  });

  it("maps the temp id onto the server row", () => {
    const prev = fixture();
    const planned = planOptimisticAssign(prev, { categoryId: 10, month: "2026-02", amount: 500 }, -99);
    const mapped = mapOptimisticAssignId(planned, -99, 10, "2026-02", {
      id: 7,
      categoryId: 10,
      month: "2026-02",
      amount: "500",
    });
    expect(mapped.assignments.find((a) => a.id === 7)?.amount).toBe("500");
    expect(mapped.assignments.some((a) => a.id === -99)).toBe(false);
  });

  it("rolls back to the snapshot, or drops the temp row", () => {
    const prev = fixture();
    const snapshot = { ...prev.assignments[0]! };
    const planned = planOptimisticAssign(prev, { categoryId: 10, month: "2026-01", amount: 100 }, -99);
    const restored = rollbackOptimisticAssign(planned, snapshot, 10, "2026-01", -99);
    expect(restored.assignments).toEqual([snapshot]);

    const added = planOptimisticAssign(prev, { categoryId: 10, month: "2026-02", amount: 100 }, -99);
    const dropped = rollbackOptimisticAssign(added, null, 10, "2026-02", -99);
    expect(dropped.assignments).toEqual(prev.assignments);
  });

  it("plans batch assigns under sequential temp ids", () => {
    const prev = fixture();
    const next = planOptimisticBatchAssign(
      prev,
      [
        { categoryId: 10, month: "2026-01", amount: 1000 },
        { categoryId: 10, month: "2026-02", amount: 2000 },
      ],
      -100
    );
    expect(next.assignments.find((a) => a.month === "2026-01")?.amount).toBe("1000");
    expect(next.assignments.find((a) => a.month === "2026-02")).toMatchObject({ id: -101, amount: "2000" });
  });
});

describe("planOptimisticInsert", () => {
  it("inserts a categorized single with balance delta", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticInsert(
      prev,
      { accountId: 1, categoryId: 10, date: "2026-01-20", payee: "Store", amount: -2500 },
      -1
    );
    const row = next.transactions.find((t) => t.id === -1);
    expect(row).toMatchObject({ categoryId: 10, amount: "-2500.00", isIncome: false, parentId: null });
    expect(deltas.get(1)).toBe(-2500);
    expect(next.accounts.find((a) => a.id === 1)?.balance).toBe("97500");
  });

  it("infers income for uncategorized positive amounts on liquid accounts", () => {
    const prev = fixture();
    const { next } = planOptimisticInsert(
      prev,
      { accountId: 1, date: "2026-01-20", payee: "Employer", amount: 300000 },
      -1
    );
    expect(next.transactions.find((t) => t.id === -1)).toMatchObject({ isIncome: true });
  });

  it("honours an explicit isIncome: false", () => {
    const prev = fixture();
    const { next } = planOptimisticInsert(
      prev,
      { accountId: 1, date: "2026-01-20", payee: "Refund?", amount: 50000, isIncome: false, incomeMonth: "2026-01" },
      -1
    );
    const row = next.transactions.find((t) => t.id === -1);
    expect(row?.isIncome).toBe(false);
    expect(row?.incomeMonth).toBeNull();
  });

  it("never infers income on credit or off-budget accounts", () => {
    const prev = fixture();
    for (const accountId of [3, 4]) {
      const { next } = planOptimisticInsert(
        prev,
        { accountId, date: "2026-01-20", payee: "X", amount: 50000 },
        -accountId
      );
      const row = next.transactions.find((t) => t.id === -accountId);
      expect(row?.isIncome).toBe(false);
      expect(row?.incomeMonth).toBeNull();
    }
  });

  it("builds synthetic children for splits", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticInsert(
      prev,
      {
        accountId: 1,
        date: "2026-01-20",
        payee: "Mall",
        amount: -7000,
        subTransactions: [
          { categoryId: 10, amount: -4000 },
          { categoryId: null, amount: -3000 },
        ],
      },
      -10
    );
    const parent = next.transactions.find((t) => t.id === -10);
    expect(parent?.categoryId).toBeNull();
    expect(next.transactions.find((t) => t.id === -11)).toMatchObject({ parentId: -10, amount: "-4000.00" });
    expect(next.transactions.find((t) => t.id === -12)).toMatchObject({ parentId: -10, amount: "-3000.00" });
    expect(deltas.get(1)).toBe(-7000);
  });

  it("moves both legs for transfers", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticInsert(
      prev,
      { accountId: 1, transferAccountId: 2, date: "2026-01-20", payee: "t", amount: -10000 },
      -1
    );
    expect(deltas.get(1)).toBe(-10000);
    expect(deltas.get(2)).toBe(10000);
    expect(next.transactions.find((t) => t.id === -1)?.transferAccountId).toBe(2);
  });
});

describe("mapOptimisticInsertIds / rollbackOptimisticInsert", () => {
  it("remaps the single temp id", () => {
    const prev = fixture();
    const { next } = planOptimisticInsert(
      prev,
      { accountId: 1, categoryId: 10, date: "2026-01-20", payee: "S", amount: -100 },
      -1
    );
    const mapped = mapOptimisticInsertIds(next.transactions, -1, { id: 42 });
    expect(mapped.some((t) => t.id === -1)).toBe(false);
    expect(mapped.find((t) => t.id === 42)?.payee).toBe("S");
  });

  it("remaps split ids positionally", () => {
    const prev = fixture();
    const { next } = planOptimisticInsert(
      prev,
      {
        accountId: 1,
        date: "2026-01-20",
        payee: "Mall",
        amount: -7000,
        subTransactions: [
          { categoryId: 10, amount: -4000 },
          { categoryId: 10, amount: -3000 },
        ],
      },
      -10
    );
    const mapped = mapOptimisticInsertIds(next.transactions, -10, {
      parent: { id: 50 },
      children: [{ id: 51 }, { id: 52 }],
    });
    expect(mapped.find((t) => t.id === 50)?.parentId).toBeNull();
    // Children keep pointing at the temp parent until the post-mutation
    // reload heals them (matches long-standing shell behaviour).
    expect(mapped.find((t) => t.id === 51)?.parentId).toBe(-10);
    expect(mapped.find((t) => t.id === 52)?.parentId).toBe(-10);
  });

  it("rollback drops temp rows and reverses deltas", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticInsert(
      prev,
      { accountId: 1, categoryId: 10, date: "2026-01-20", payee: "S", amount: -2500 },
      -1
    );
    const rolledBack = rollbackOptimisticInsert(next, new Set([-1]), -1, deltas);
    expect(rolledBack.transactions).toHaveLength(prev.transactions.length);
    expect(rolledBack.accounts.find((a) => a.id === 1)?.balance).toBe("100000");
  });
});

describe("planOptimisticUpdate", () => {
  it("applies amount changes with deltas and reviews the row", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticUpdate(prev, 1, { amount: -8000 }, null);
    expect(next.transactions.find((t) => t.id === 1)).toMatchObject({
      amount: "-8000.00",
      needsReview: false,
    });
    // -5000 removed, -8000 added => net -3000
    expect(deltas.get(1)).toBe(-3000);
  });

  it("preserves income state on unrelated edits (no flip)", () => {
    const prev = fixture();
    const { next } = planOptimisticUpdate(prev, 2, { memo: "note" }, null);
    expect(next.transactions.find((t) => t.id === 2)).toMatchObject({
      isIncome: true,
      incomeMonth: "2026-01",
    });
  });

  it("assigning a category to an uncategorized inflow clears income", () => {
    const prev = fixture();
    const { next } = planOptimisticUpdate(prev, 2, { categoryId: 10 }, null);
    expect(next.transactions.find((t) => t.id === 2)).toMatchObject({
      categoryId: 10,
      isIncome: false,
      incomeMonth: null,
    });
  });

  it("reclassifies category when converting to an internal transfer", () => {
    const prev = fixture();
    const { next } = planOptimisticUpdate(prev, 1, { transferAccountId: 2 }, null);
    const row = next.transactions.find((t) => t.id === 1);
    expect(row?.transferAccountId).toBe(2);
    expect(row?.categoryId).toBeNull();
  });

  it("propagates date/status to split members", () => {
    const prev = fixture();
    const { next } = planOptimisticUpdate(prev, 5, { date: "2026-02-01", status: "u" }, 4);
    expect(next.transactions.find((t) => t.id === 5)?.date).toBe("2026-02-01");
    expect(next.transactions.find((t) => t.id === 4)?.date).toBe("2026-02-01");
    expect(next.transactions.find((t) => t.id === 6)?.date).toBe("2026-02-01");
    expect(next.transactions.find((t) => t.id === 1)?.date).toBe("2026-01-15");
  });

  it("is a no-op delta-wise for a missing target", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticUpdate(prev, 999, { amount: -100 }, null);
    expect(deltas.size).toBe(0);
    expect(next.transactions).toHaveLength(prev.transactions.length);
  });
});

describe("update predicates", () => {
  it("detects status/flag-only updates", () => {
    expect(isStatusOrFlagOnlyUpdate({ status: "u" })).toBe(true);
    expect(isStatusOrFlagOnlyUpdate({ flagColor: "red" })).toBe(true);
    expect(isStatusOrFlagOnlyUpdate({ status: "u", memo: "x" })).toBe(false);
    expect(isStatusOrFlagOnlyUpdate({ amount: -100 })).toBe(false);
  });

  it("detects updates needing a reload", () => {
    expect(transactionUpdateNeedsReload({ status: "u" })).toBe(false);
    expect(transactionUpdateNeedsReload({ flagColor: null })).toBe(false);
    expect(transactionUpdateNeedsReload({ amount: -100 })).toBe(true);
    expect(transactionUpdateNeedsReload({ payee: "x" })).toBe(true);
    expect(transactionUpdateNeedsReload({ transferAccountId: 2 })).toBe(true);
  });
});

describe("planOptimisticBulkUpdate", () => {
  it("patches rows verbatim and inherits date/status to split members", () => {
    const prev = fixture();
    const { next } = planOptimisticBulkUpdate(prev, [1, 5], { status: "u", payee: "Bulk" });
    expect(next.transactions.find((t) => t.id === 1)).toMatchObject({ status: "u", payee: "Bulk" });
    expect(next.transactions.find((t) => t.id === 5)).toMatchObject({ status: "u", payee: "Bulk" });
    const parent = next.transactions.find((t) => t.id === 4);
    expect(parent?.status).toBe("u");
    expect(parent?.payee).toBe("Payee");
  });

  it("computes deltas for amount moves", () => {
    const prev = fixture();
    const { next, deltas } = planOptimisticBulkUpdate(prev, [1], { amount: -10000 });
    expect(next.transactions.find((t) => t.id === 1)?.amount).toBe("-10000");
    expect(deltas.get(1)).toBe(-5000);
  });

  it("detects status-only patches", () => {
    expect(isStatusOnlyBulkUpdate({ status: "u" })).toBe(true);
    expect(isStatusOnlyBulkUpdate({ status: "u", memo: "x" })).toBe(false);
  });
});

describe("optimistic merge", () => {
  it("throws unless exactly two rows match", () => {
    const prev = fixture();
    expect(() => prepareOptimisticMerge(prev, [1])).toThrow("Select exactly two transactions to merge.");
    expect(() => prepareOptimisticMerge(null, [1, 2])).toThrow("Select exactly two transactions to merge.");
  });

  it("applies the merged row with net deltas", () => {
    const prev = fixture();
    const extra: BudgetData = {
      ...prev,
      transactions: [
        ...prev.transactions,
        tx({ id: 20, accountId: 1, categoryId: 10, amount: "-5000", payee: "Store", date: "2026-01-16" }),
      ],
    };
    const prepared = prepareOptimisticMerge(extra, [1, 20]);
    const { next, deltas } = applyPreparedMerge(extra, prepared);
    const ids = next.transactions.map((t) => t.id);
    // The merged row keeps the primary id (server behaviour); the
    // secondary row is gone.
    expect(ids).toContain(prepared.primary.id);
    expect(ids).not.toContain(prepared.secondary.id);
    expect(next.transactions).toHaveLength(extra.transactions.length - 1);
    // Both legs reversed (-5000 each => +10000), merged leg re-posted.
    const merged = next.transactions.find((t) => t.id === prepared.primary.id)!;
    expect(deltas.get(1)).toBe(10000 + Number(merged.amount));
  });

  it("rollback restores the pair", () => {
    const prev = fixture();
    const prepared = prepareOptimisticMerge(prev, [1, 2]);
    const { next, deltas } = applyPreparedMerge(prev, prepared);
    const restored = restoreTransactionRows(
      next,
      new Set([prepared.primary.id, prepared.secondary.id]),
      prepared.prevRows,
      deltas,
      { includeChildren: false }
    );
    expect(restored.transactions).toHaveLength(prev.transactions.length);
    expect(restored.accounts.find((a) => a.id === 1)?.balance).toBe("100000");
  });
});
