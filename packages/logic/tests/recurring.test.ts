import { describe, expect, it } from "vitest";
import {
  getRecurringChildren,
  netMonthlyAmount,
  recurringFlavour,
  validateRecurringSubTransactions,
} from "../src/recurring.js";
import type { Recurring, RecurringSubTransaction } from "../src/types.js";

const base = (overrides: Partial<Recurring> = {}): Recurring => ({
  id: 1,
  accountId: 1,
  categoryId: null,
  payee: "P",
  amount: "0",
  frequency: "monthly",
  nextDate: "2026-07-01",
  active: true,
  transferAccountId: null,
  ...overrides,
});

const sub = (overrides: Partial<RecurringSubTransaction>): RecurringSubTransaction => ({
  id: 1,
  recurringId: 1,
  categoryId: 5,
  amount: "0",
  memo: "",
  sort: 0,
  ...overrides,
});

describe("recurring flavour helpers", () => {
  it("classifies a plain row as single", () => {
    expect(recurringFlavour(base(), [])).toBe("single");
  });

  it("classifies a row with transferAccountId as transfer", () => {
    expect(
      recurringFlavour(base({ transferAccountId: 2 }), [])
    ).toBe("transfer");
  });

  it("classifies a row with children as split", () => {
    expect(
      recurringFlavour(base(), [sub({ amount: "10" }), sub({ amount: "20" })])
    ).toBe("split");
  });

  it("transferAccountId takes precedence over children", () => {
    // A transfer cannot also be a split; the queries enforce this, but
    // the flavour helper follows the discriminator convention.
    expect(
      recurringFlavour(
        base({ transferAccountId: 2 }),
        [sub({ amount: "10" })]
      )
    ).toBe("transfer");
  });
});

describe("getRecurringChildren", () => {
  it("filters and sorts by sort then id", () => {
    const children: RecurringSubTransaction[] = [
      sub({ id: 1, sort: 1 }),
      sub({ id: 2, sort: 0, recurringId: 2 }),
      sub({ id: 3, sort: 0 }),
      sub({ id: 4, sort: 2, recurringId: 99 }),
    ];
    const out = getRecurringChildren(children, 1);
    expect(out.map((c) => c.id)).toEqual([3, 1]);
  });
});

describe("netMonthlyAmount", () => {
  it("returns the row amount for singles", () => {
    expect(
      netMonthlyAmount(base({ amount: "-50" }), [])
    ).toBe(-50);
  });

  it("returns 0 for transfers (net zero across accounts)", () => {
    expect(
      netMonthlyAmount(base({ amount: "-500", transferAccountId: 2 }), [])
    ).toBe(0);
  });

  it("returns the sum of children for splits", () => {
    expect(
      netMonthlyAmount(
        base({ amount: "-200" }),
        [sub({ amount: "-120" }), sub({ amount: "-80" })]
      )
    ).toBe(-200);
  });
});

describe("validateRecurringSubTransactions", () => {
  it("returns null for a balanced split", () => {
    expect(
      validateRecurringSubTransactions(200, [
        { categoryId: 1, amount: 120 },
        { categoryId: 2, amount: 80 },
      ])
    ).toBeNull();
  });

  it("rejects fewer than 2 children", () => {
    expect(
      validateRecurringSubTransactions(200, [{ categoryId: 1, amount: 200 }])
    ).toMatch(/at least two/i);
  });

  it("rejects a child with no category", () => {
    expect(
      validateRecurringSubTransactions(200, [
        { categoryId: 0, amount: 100 },
        { categoryId: 2, amount: 100 },
      ])
    ).toMatch(/missing a category/i);
  });

  it("rejects unbalanced children", () => {
    expect(
      validateRecurringSubTransactions(200, [
        { categoryId: 1, amount: 120 },
        { categoryId: 2, amount: 70 },
      ])
    ).toMatch(/sum to/);
  });
});
