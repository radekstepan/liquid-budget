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
  assertSplitsBalanced,
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

describe("assertSplitsBalanced (BUG-18.3 consolidated validator)", () => {
  it("accepts a balanced, uniformly-negative split", () => {
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: 2, amount: -4000 },
      ])
    ).not.toThrow();
  });

  it("accepts a balanced, uniformly-positive split", () => {
    expect(() =>
      assertSplitsBalanced(20000, [
        { categoryId: 1, amount: 12000 },
        { categoryId: 2, amount: 8000 },
      ])
    ).not.toThrow();
  });

  it("accepts a mixed-sign split (Paycheck + tax deduction)", () => {
    expect(() =>
      assertSplitsBalanced(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ])
    ).not.toThrow();
  });

  it("accepts a mixed-sign paycheck split with an income leg (null category)", () => {
    expect(() =>
      assertSplitsBalanced(400000, [
        { categoryId: null, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ])
    ).not.toThrow();
  });

  it("rounds float amounts to the cent before comparing", () => {
    expect(() =>
      assertSplitsBalanced(-10000.4, [
        { categoryId: 1, amount: -6000.2 },
        { categoryId: 2, amount: -4000.2 },
      ])
    ).not.toThrow();
  });

  it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
    expect(() =>
      assertSplitsBalanced(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100001 },
      ])
    ).toThrow(/do not sum to parent/);
  });

  it("rejects fewer than 2 children", () => {
    expect(() =>
      assertSplitsBalanced(-5000, [{ categoryId: 1, amount: -5000 }])
    ).toThrow(/at least two/);
  });

  it("accepts a split with transfer subtransactions", () => {
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: -6000 },
        { categoryId: null, transferAccountId: 2, amount: -4000 },
      ])
    ).not.toThrow();
  });

  it("rejects a missing-category child that is also not a transfer", () => {
    expect(() =>
      assertSplitsBalanced(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 0, amount: -2000 },
      ])
    ).toThrow(/must have a category or transfer account/);
  });

  it("accepts a child with both a category and a transfer account (boundary transfer leg)", () => {
    expect(() =>
      assertSplitsBalanced(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 1, transferAccountId: 2, amount: -2000 },
      ])
    ).not.toThrow();
  });

  it("rejects non-finite amounts (NaN)", () => {
    expect(() =>
      assertSplitsBalanced(-5000, [
        { categoryId: 1, amount: -3000 },
        { categoryId: 2, amount: NaN },
      ])
    ).toThrow(/valid number/);
  });

  it("rejects a zero parent amount", () => {
    expect(() =>
      assertSplitsBalanced(0, [
        { categoryId: 1, amount: 3000 },
        { categoryId: 2, amount: -3000 },
      ])
    ).toThrow(/Amount cannot be zero/);
  });

  it("rejects a zero-amount child", () => {
    expect(() =>
      assertSplitsBalanced(-5000, [
        { categoryId: 1, amount: -5000 },
        { categoryId: 2, amount: 0 },
      ])
    ).toThrow(/Amount cannot be zero/);
  });

  it("rejects when sign conventions conflict (negative parent with positive children)", () => {
    expect(() =>
      assertSplitsBalanced(-10000, [
        { categoryId: 1, amount: 6000 },
        { categoryId: 2, amount: 4000 },
      ])
    ).toThrow(/do not sum to parent/);
  });

  /**
   * Property-based regression test (BUG-18.3): randomly generate balanced
   * splits — the validator must accept every one of them; mutating a
   * single child's amount by one cent must make it fail on the sum check.
   */
  it("property: random balanced splits pass; a one-cent mutation fails", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

    for (let trial = 0; trial < 200; trial++) {
      const n = randInt(2, 7);
      let children: { categoryId: number; amount: number }[];
      let parent: number;
      do {
        children = [];
        let running = 0;
        for (let i = 0; i < n - 1; i++) {
          let amount = 0;
          while (Math.abs(amount) < 2) amount = randInt(-50000, 50000);
          children.push({ categoryId: i + 1, amount });
          running += amount;
        }
        parent = running + randInt(-50000, 50000);
        children.push({ categoryId: n, amount: parent - running });
      } while (parent === 0 || children.some((c) => Math.abs(c.amount) < 2));

      expect(() => assertSplitsBalanced(parent, children)).not.toThrow();

      const idx = randInt(0, n - 1);
      const delta = rand() < 0.5 ? -1 : 1;
      const mutated = children.map((c, i) => (i === idx ? { ...c, amount: c.amount + delta } : c));
      expect(() => assertSplitsBalanced(parent, mutated)).toThrow(/do not sum to parent/);
    }
  });
});
