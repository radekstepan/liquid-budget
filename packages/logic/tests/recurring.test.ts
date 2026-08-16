import { describe, expect, it } from "vitest";
import {
  frequencyMonthlyMultiplier,
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

describe("frequencyMonthlyMultiplier", () => {
  it("returns correct multipliers for various frequencies", () => {
    expect(frequencyMonthlyMultiplier("twiceamonth")).toBe(2);
    expect(frequencyMonthlyMultiplier("semimonthly")).toBe(2);
    expect(frequencyMonthlyMultiplier("monthly")).toBe(1);
    expect(frequencyMonthlyMultiplier("biweekly")).toBeCloseTo(26 / 12);
    expect(frequencyMonthlyMultiplier("weekly")).toBeCloseTo(52 / 12);
    expect(frequencyMonthlyMultiplier("every4weeks")).toBeCloseTo(13 / 12);
    expect(frequencyMonthlyMultiplier("everyothermonth")).toBe(0.5);
    expect(frequencyMonthlyMultiplier("every3months")).toBeCloseTo(1 / 3);
    expect(frequencyMonthlyMultiplier("twiceayear")).toBeCloseTo(2 / 12);
    expect(frequencyMonthlyMultiplier("yearly")).toBeCloseTo(1 / 12);
    expect(frequencyMonthlyMultiplier("every2years")).toBeCloseTo(1 / 24);
    expect(frequencyMonthlyMultiplier("daily")).toBeCloseTo(365 / 12);
    expect(frequencyMonthlyMultiplier("once")).toBe(0);
  });
});

describe("netMonthlyAmount", () => {
  it("returns the row amount for singles", () => {
    expect(
      netMonthlyAmount(base({ amount: "-50" }), [])
    ).toBe(-50);
  });

  it("returns 0 for transfers when accounts is omitted", () => {
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

  describe("account-aware liquid flow", () => {
    const accounts = [
      { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "1000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid" as const, groupLabel: "Budget", balance: "5000", onBudget: true, sort: 1 },
      { id: 3, name: "Visa", kind: "credit" as const, groupLabel: "Budget", balance: "-200", onBudget: true, sort: 2 },
      { id: 4, name: "TFSA", kind: "offbudget" as const, groupLabel: "Off", balance: "10000", onBudget: false, sort: 3 },
    ];

    it("returns 0 for liquid-to-liquid transfer", () => {
      // Transfer -500 from Checking (id 1) to Savings (id 2)
      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "-500", transferAccountId: 2 }), [], accounts)
      ).toBe(0);
    });

    it("returns negative flow for transfer from liquid to offbudget / credit", () => {
      // Transfer -455.50 from Checking (id 1) to TFSA (id 4)
      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "-455.50", transferAccountId: 4 }), [], accounts)
      ).toBe(-455.5);
    });

    it("returns positive flow for transfer from offbudget to liquid (salary / transfer in)", () => {
      // Transfer -4152.97 recorded on Business TFSA (id 4) to Checking (id 1)
      expect(
        netMonthlyAmount(base({ accountId: 4, amount: "-4152.97", transferAccountId: 1 }), [], accounts)
      ).toBe(4152.97);

      // Or transfer +4152.97 recorded on Checking (id 1) from Business (id 4)
      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "4152.97", transferAccountId: 4 }), [], accounts)
      ).toBe(4152.97);
    });

    it("returns 0 for offbudget single expense / tracking item", () => {
      expect(
        netMonthlyAmount(base({ accountId: 4, amount: "-100" }), [], accounts)
      ).toBe(0);
    });
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

  it("accepts a mixed-sign split (Paycheck + tax deduction)", () => {
    // Previously rejected because |+5000| + |-1000| = 6000 ≠ |+4000|.
    // The fix: validation uses signed sums so a +5000 gross with a
    // -1000 tax deduction netted to +4000 is valid.
    expect(
      validateRecurringSubTransactions(4000, [
        { categoryId: 1, amount: 5000 },
        { categoryId: 2, amount: -1000 },
      ])
    ).toBeNull();
  });

  it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
    expect(
      validateRecurringSubTransactions(4000, [
        { categoryId: 1, amount: 5000 },
        { categoryId: 2, amount: -1001 },
      ])
    ).toMatch(/sum to/);
  });
});
