import { describe, expect, it } from "vitest";
import {
  frequencyLabel,
  frequencyMonthlyMultiplier,
  getRecurringChildren,
  netMonthlyAmount,
  RECURRING_FREQUENCIES,
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
      recurringFlavour(base(), [sub({ amount: "1000" }), sub({ amount: "2000" })])
    ).toBe("split");
  });

  it("transferAccountId takes precedence over children", () => {
    expect(
      recurringFlavour(
        base({ transferAccountId: 2 }),
        [sub({ amount: "1000" })]
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
      netMonthlyAmount(base({ amount: "-5000" }), [])
    ).toBe(-5000);
  });

  it("returns 0 for transfers when accounts is omitted", () => {
    expect(
      netMonthlyAmount(base({ amount: "-50000", transferAccountId: 2 }), [])
    ).toBe(0);
  });

  it("returns the sum of children for splits", () => {
    expect(
      netMonthlyAmount(
        base({ amount: "-20000" }),
        [sub({ amount: "-12000" }), sub({ amount: "-8000" })]
      )
    ).toBe(-20000);
  });

  describe("account-aware liquid flow", () => {
    const accounts = [
      { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid" as const, groupLabel: "Budget", balance: "500000", onBudget: true, sort: 1 },
      { id: 3, name: "Visa", kind: "credit" as const, groupLabel: "Budget", balance: "-20000", onBudget: true, sort: 2 },
      { id: 4, name: "TFSA", kind: "offbudget" as const, groupLabel: "Off", balance: "1000000", onBudget: false, sort: 3 },
    ];

    it("returns 0 for liquid-to-liquid transfer", () => {
      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "-50000", transferAccountId: 2 }), [], accounts)
      ).toBe(0);
    });

    it("returns negative flow for transfer from liquid to offbudget / credit", () => {
      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "-45550", transferAccountId: 4 }), [], accounts)
      ).toBe(-45550);
    });

    it("returns positive flow for transfer from offbudget to liquid (salary / transfer in)", () => {
      expect(
        netMonthlyAmount(base({ accountId: 4, amount: "-415297", transferAccountId: 1 }), [], accounts)
      ).toBe(415297);

      expect(
        netMonthlyAmount(base({ accountId: 1, amount: "415297", transferAccountId: 4 }), [], accounts)
      ).toBe(415297);
    });

    it("returns 0 for offbudget single expense / tracking item", () => {
      expect(
        netMonthlyAmount(base({ accountId: 4, amount: "-10000" }), [], accounts)
      ).toBe(0);
    });

    it("returns 0 for credit card single and split expenses (Issue #16)", () => {
      // Single expense charged to Visa (credit)
      expect(
        netMonthlyAmount(base({ accountId: 3, amount: "-1500" }), [], accounts)
      ).toBe(0);

      // Split expense charged to Visa (credit)
      expect(
        netMonthlyAmount(
          base({ accountId: 3, amount: "-5000" }),
          [sub({ amount: "-3000" }), sub({ amount: "-2000" })],
          accounts
        )
      ).toBe(0);
    });
  });
});

describe("validateRecurringSubTransactions", () => {
  it("returns null for a balanced split", () => {
    expect(
      validateRecurringSubTransactions(20000, [
        { categoryId: 1, amount: 12000 },
        { categoryId: 2, amount: 8000 },
      ])
    ).toBeNull();
  });

  it("rejects fewer than 2 children", () => {
    expect(
      validateRecurringSubTransactions(20000, [{ categoryId: 1, amount: 20000 }])
    ).toMatch(/at least two/i);
  });

  it("rejects a child with no category and no transfer", () => {
    expect(
      validateRecurringSubTransactions(20000, [
        { categoryId: 0, amount: 10000 },
        { categoryId: 2, amount: 10000 },
      ])
    ).toMatch(/missing a category/i);
  });

  it("rejects unbalanced children", () => {
    expect(
      validateRecurringSubTransactions(20000, [
        { categoryId: 1, amount: 12000 },
        { categoryId: 2, amount: 7000 },
      ])
    ).toMatch(/sum to/);
  });

  it("accepts a mixed-sign split (Paycheck + tax deduction)", () => {
    expect(
      validateRecurringSubTransactions(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100000 },
      ])
    ).toBeNull();
  });

  it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
    expect(
      validateRecurringSubTransactions(400000, [
        { categoryId: 1, amount: 500000 },
        { categoryId: 2, amount: -100001 },
      ])
    ).toMatch(/sum to/);
  });
});

describe("RECURRING_FREQUENCIES and frequencyLabel (UNI-23 / F-13 / BUG-19)", () => {
  it("exposes all 13 standard frequencies", () => {
    expect(RECURRING_FREQUENCIES).toHaveLength(13);
    const values = RECURRING_FREQUENCIES.map((f) => f.value);
    expect(values).toEqual([
      "never",
      "daily",
      "weekly",
      "everyotherweek",
      "twiceamonth",
      "every4weeks",
      "monthly",
      "everyothermonth",
      "every3months",
      "every4months",
      "twiceayear",
      "yearly",
      "every2years",
    ]);
  });

  it("formats human-readable labels for all frequencies and aliases", () => {
    expect(frequencyLabel("never")).toBe("Never");
    expect(frequencyLabel("daily")).toBe("Daily");
    expect(frequencyLabel("weekly")).toBe("Weekly");
    expect(frequencyLabel("everyotherweek")).toBe("Every Other Week");
    expect(frequencyLabel("biweekly")).toBe("Every Other Week");
    expect(frequencyLabel("twiceamonth")).toBe("Twice a Month");
    expect(frequencyLabel("semimonthly")).toBe("Twice a Month");
    expect(frequencyLabel("every4weeks")).toBe("Every 4 Weeks");
    expect(frequencyLabel("monthly")).toBe("Monthly");
    expect(frequencyLabel("everyothermonth")).toBe("Every Other Month");
    expect(frequencyLabel("bimonthly")).toBe("Every Other Month");
    expect(frequencyLabel("every3months")).toBe("Every 3 Months");
    expect(frequencyLabel("quarterly")).toBe("Every 3 Months");
    expect(frequencyLabel("every4months")).toBe("Every 4 Months");
    expect(frequencyLabel("twiceayear")).toBe("Twice a Year");
    expect(frequencyLabel("semiannually")).toBe("Twice a Year");
    expect(frequencyLabel("yearly")).toBe("Yearly");
    expect(frequencyLabel("annually")).toBe("Yearly");
    expect(frequencyLabel("every2years")).toBe("Every 2 Years");
    expect(frequencyLabel("unknown")).toBe("unknown");
  });
});
