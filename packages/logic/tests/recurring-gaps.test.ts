/**
 * recurring-gaps.test.ts
 *
 * Focused coverage for recurring helpers: the every-4-months multiplier,
 * unknown-frequency default, Map-based accounts, non-liquid transfer flow,
 * and split/single liquid-flow legs.
 */
import { describe, expect, it } from "vitest";
import {
  frequencyMonthlyMultiplier,
  recurringLiquidFlow,
} from "../src/recurring.js";
import type {
  Account,
  Recurring,
  RecurringSubTransaction,
} from "../src/types.js";

const rec = (over: Partial<Recurring> = {}): Recurring => ({
  id: 1,
  accountId: 1,
  categoryId: null,
  payee: "P",
  amount: "-1000",
  frequency: "monthly",
  nextDate: "2026-07-01",
  active: true,
  ...over,
});

const child = (over: Partial<RecurringSubTransaction> = {}): RecurringSubTransaction => ({
  id: 1,
  recurringId: 1,
  categoryId: null,
  amount: "-1000",
  memo: "",
  sort: 0,
  ...over,
});

const liquid: Account = {
  id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0,
};
const credit: Account = {
  id: 2, name: "Visa", kind: "credit", groupLabel: "CC", balance: "0", onBudget: true, sort: 1,
};
const offbudget: Account = {
  id: 3, name: "Brokerage", kind: "offbudget", groupLabel: "Inv", balance: "0", onBudget: false, sort: 2,
};

describe("frequencyMonthlyMultiplier gaps", () => {
  it("returns 0.25 for every4months", () => {
    expect(frequencyMonthlyMultiplier("every4months")).toBe(0.25);
  });

  it("defaults unknown frequencies to 1", () => {
    expect(frequencyMonthlyMultiplier("fortnightly")).toBe(1);
  });
});

describe("recurringLiquidFlow gaps", () => {
  it("accepts accounts as a Map", () => {
    const accounts = new Map([
      [1, { kind: "liquid" }],
      [2, { kind: "credit" }],
    ]);
    expect(recurringLiquidFlow(rec({ amount: "-1000" }), [], accounts)).toBe(-1000);
  });

  it("returns the signed amount for a single on a liquid account", () => {
    expect(recurringLiquidFlow(rec({ amount: "-1000" }), [], [liquid])).toBe(-1000);
    expect(recurringLiquidFlow(rec({ amount: "2500" }), [], [liquid])).toBe(2500);
  });

  it("returns 0 for transfers that never touch liquid", () => {
    expect(
      recurringLiquidFlow(rec({ accountId: 3, transferAccountId: 2 }), [], [liquid, credit, offbudget])
    ).toBe(0);
  });

  it("sums split legs by transfer direction", () => {
    // Liquid source: outflow leg to credit counts, liquid-to-liquid leg is neutral.
    expect(
      recurringLiquidFlow(
        rec({ accountId: 1 }),
        [
          child({ id: 1, amount: "-800", transferAccountId: 2 }),
          child({ id: 2, amount: "-200", transferAccountId: 1 }),
          child({ id: 3, amount: "-500" }),
        ],
        [liquid, credit]
      )
    ).toBe(-1300);

    // Non-liquid source: inflow leg from... a leg into liquid counts negated,
    // plain legs on non-liquid are ignored.
    expect(
      recurringLiquidFlow(
        rec({ accountId: 3 }),
        [
          child({ id: 1, amount: "-800", transferAccountId: 1 }),
          child({ id: 2, amount: "-500" }),
        ],
        [liquid, credit, offbudget]
      )
    ).toBe(800);
  });
});
