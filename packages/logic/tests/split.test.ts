/**
 * split.test.ts
 *
 * Pure-function tests for the split helpers. Mixed-sign coverage:
 * the bug being guarded is that the old validation required
 * `|Σ children| === |parent|`, which rejected legitimate YNAB4
 * splits such as a +5000 gross Paycheck with a -1000 tax deduction
 * netting to +4000.
 */
import { describe, expect, it } from "vitest";
import {
  getSplitChildren,
  getSplitParent,
  isSplitBalanced,
  isSplitChild,
  isSplitParent,
  isTransfer,
  splitChildrenTotal,
  validateSubTransactions,
} from "../src/split.js";
import type { SubTransaction, Transaction } from "../src/types.js";

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2026-07-01",
    payee: "",
    memo: "",
    amount: "0",
    cleared: true,
    ...overrides,
  };
}

describe("split classification helpers", () => {
  it("isSplitChild returns true iff parentId is set", () => {
    expect(isSplitChild(tx({ parentId: 5 }))).toBe(true);
    expect(isSplitChild(tx({}))).toBe(false);
  });

  it("isSplitParent requires no parentId AND at least one child row", () => {
    const parent = tx({ id: 1 });
    const child = tx({ id: 2, parentId: 1 });
    expect(isSplitParent(parent, [parent, child])).toBe(true);
    expect(isSplitParent(parent, [parent])).toBe(false);
    expect(isSplitParent(tx({ id: 3, parentId: 9 }), [parent, child])).toBe(false);
  });

  it("isTransfer returns true iff transferAccountId is set", () => {
    expect(isTransfer(tx({ transferAccountId: 2 }))).toBe(true);
    expect(isTransfer(tx({}))).toBe(false);
  });

  it("getSplitChildren returns only rows whose parentId matches", () => {
    const parent = tx({ id: 1 });
    const a = tx({ id: 2, parentId: 1 });
    const b = tx({ id: 3, parentId: 1 });
    const other = tx({ id: 4, parentId: 9 });
    expect(getSplitChildren([parent, a, b, other], 1)).toEqual([a, b]);
  });

  it("getSplitParent returns the parent row or undefined", () => {
    const parent = tx({ id: 1 });
    const child = tx({ id: 2, parentId: 1 });
    expect(getSplitParent([parent, child], child)).toBe(parent);
    expect(getSplitParent([parent, child], parent)).toBeUndefined();
    expect(getSplitParent([parent], tx({ id: 5, parentId: 99 }))).toBeUndefined();
  });

  it("splitChildrenTotal returns the signed sum of children", () => {
    const parent = tx({ id: 1 });
    expect(
      splitChildrenTotal(
        [parent, tx({ id: 2, parentId: 1, amount: "60" }), tx({ id: 3, parentId: 1, amount: "40" })],
        1
      )
    ).toBe(100);
  });
});

describe("isSplitBalanced", () => {
  it("returns false for a parent with fewer than 2 children", () => {
    const parent = tx({ id: 1, amount: "-50" });
    const a = tx({ id: 2, parentId: 1, amount: "-50" });
    expect(isSplitBalanced(parent, [parent, a])).toBe(false);
  });

  it("returns true when signed child sum equals signed parent", () => {
    const parent = tx({ id: 1, amount: "-100" });
    const all = [
      parent,
      tx({ id: 2, parentId: 1, amount: "-60" }),
      tx({ id: 3, parentId: 1, amount: "-40" }),
    ];
    expect(isSplitBalanced(parent, all)).toBe(true);
  });

  it("returns true for a positive parent with mixed-sign children (Paycheck with taxes)", () => {
    // +5000 gross, -1000 taxes → net +4000 = parent
    const parent = tx({ id: 1, amount: "4000" });
    const all = [
      parent,
      tx({ id: 2, parentId: 1, amount: "5000" }),
      tx({ id: 3, parentId: 1, amount: "-1000" }),
    ];
    expect(isSplitBalanced(parent, all)).toBe(true);
  });

  it("returns false when signed sum doesn't match parent (within 0.5c)", () => {
    const parent = tx({ id: 1, amount: "4000" });
    const all = [
      parent,
      tx({ id: 2, parentId: 1, amount: "5000" }),
      tx({ id: 3, parentId: 1, amount: "-1001" }),
    ];
    expect(isSplitBalanced(parent, all)).toBe(false);
  });
});

describe("validateSubTransactions", () => {
  it("returns null for a balanced, uniformly-negative split", () => {
    expect(
      validateSubTransactions(-100, [
        { categoryId: 1, amount: -60 },
        { categoryId: 2, amount: -40 },
      ])
    ).toBeNull();
  });

  it("returns null for a balanced, uniformly-positive split", () => {
    expect(
      validateSubTransactions(200, [
        { categoryId: 1, amount: 120 },
        { categoryId: 2, amount: 80 },
      ])
    ).toBeNull();
  });

  it("returns null for a mixed-sign split (Paycheck + tax deduction)", () => {
    // The bug fix: previously rejected because
    // |+5000| + |-1000| = 6000 ≠ |+4000|.
    expect(
      validateSubTransactions(4000, [
        { categoryId: 1, amount: 5000 },
        { categoryId: 2, amount: -1000 },
      ])
    ).toBeNull();
  });

  it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
    const result = validateSubTransactions(4000, [
      { categoryId: 1, amount: 5000 },
      { categoryId: 2, amount: -1001 },
    ]);
    expect(result).toMatch(/sum to/i);
  });

  it("rejects fewer than 2 children", () => {
    expect(
      validateSubTransactions(-50, [{ categoryId: 1, amount: -50 }])
    ).toMatch(/at least two/i);
  });

  it("accepts a split with transfer subtransactions", () => {
    expect(
      validateSubTransactions(-100, [
        { categoryId: 1, amount: -60 },
        { categoryId: null, transferAccountId: 2, amount: -40 },
      ])
    ).toBeNull();
  });

  it("rejects a missing-category child that is also not a transfer", () => {
    expect(
      validateSubTransactions(-50, [
        { categoryId: 1, amount: -30 },
        { categoryId: 0, amount: -20 },
      ])
    ).toMatch(/missing a category/i);
  });

  it("ignores sign of parent when validating magnitude only — no, signs must match", () => {
    // Defensive: explicitly assert we no longer do magnitude-only checks.
    // A -100 parent with all-positive children (+60, +40) should fail
    // because +60 + +40 = +100 ≠ -100.
    const result = validateSubTransactions(-100, [
      { categoryId: 1, amount: 60 },
      { categoryId: 2, amount: 40 },
    ]);
    expect(result).toMatch(/sum to/i);
  });
});
