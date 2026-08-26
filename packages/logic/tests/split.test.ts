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
    status: "c",
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
        [parent, tx({ id: 2, parentId: 1, amount: "6000" }), tx({ id: 3, parentId: 1, amount: "4000" })],
        1
      )
    ).toBe(10000);
  });
});

describe("validateSubTransactions", () => {
  it("returns null for a balanced, uniformly-negative split", () => {
    expect(
      validateSubTransactions(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: 2, amount: -4000 },
      ])
    ).toBeNull();
  });

  it("returns null for a balanced, uniformly-positive split", () => {
    expect(
      validateSubTransactions(20000, [
        { categoryId: 1, amount: 12000 },
        { categoryId: 2, amount: 8000 },
      ])
    ).toBeNull();
  });

  it("returns null for a mixed-sign split (Paycheck + tax deduction)", () => {
    expect(
      validateSubTransactions(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ])
    ).toBeNull();
  });

  it("returns null for a mixed-sign paycheck split with an income leg (null category)", () => {
    expect(
      validateSubTransactions(400000, [
        { categoryId: null, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ])
    ).toBeNull();
  });

  it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
    const result = validateSubTransactions(400000, [
      { categoryId: 1, amount: 500000 },
      { categoryId: 2, amount: -100001 },
    ]);
    expect(result).toMatch(/sum to/i);
  });

  it("rejects fewer than 2 children", () => {
    expect(
      validateSubTransactions(-5000, [{ categoryId: 1, amount: -5000 }])
    ).toMatch(/at least two/i);
  });

  it("accepts a split with transfer subtransactions", () => {
    expect(
      validateSubTransactions(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: null, transferAccountId: 2, amount: -4000 },
      ])
    ).toBeNull();
  });

  it("rejects a missing-category child that is also not a transfer", () => {
    expect(
      validateSubTransactions(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 0, amount: -2000 },
      ])
    ).toMatch(/missing a category/i);
  });

  it("accepts a child with both a category and a transfer account (boundary transfer leg)", () => {
    expect(
      validateSubTransactions(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 1, transferAccountId: 2, amount: -2000 },
      ])
    ).toBeNull();
  });

  it("rejects non-finite amounts (NaN)", () => {
    expect(
      validateSubTransactions(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 2, amount: NaN },
      ])
    ).toMatch(/valid number/i);
  });
});
