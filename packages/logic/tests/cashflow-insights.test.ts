import { describe, expect, it } from "vitest";
import {
  computeCashFlow,
  computeTrailingNetWorth,
  computeMonthlyInsights,
  getOffsetMonth,
} from "../src/reports.js";
import { makeSeedBudgetData } from "../src/seed-fixture.js";
import type { BudgetData } from "../src/types.js";

describe("getOffsetMonth", () => {
  it("offsets months correctly within year and across year boundaries", () => {
    expect(getOffsetMonth("2026-06", -1)).toBe("2026-05");
    expect(getOffsetMonth("2026-06", -5)).toBe("2026-01");
    expect(getOffsetMonth("2026-06", -6)).toBe("2025-12");
    expect(getOffsetMonth("2026-06", -11)).toBe("2025-07");
    expect(getOffsetMonth("2026-01", -1)).toBe("2025-12");
    expect(getOffsetMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("computeCashFlow", () => {
  it("calculates income, outflow, net savings, and savings rate", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "1000", onBudget: true, sort: 1 }],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        // Income
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: "5000", status: "c" },
        // Outflow
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Supermarket", memo: "", amount: "-1000", status: "c" },
        // Transfer (should not count as income or outflow)
        { id: 3, accountId: 1, categoryId: null, date: "2026-06-10", payee: "Transfer", memo: "", amount: "-500", status: "c", transferAccountId: 2 },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(5000);
    expect(flow.outflow).toBe(1000);
    expect(flow.net).toBe(4000);
    expect(flow.savingsRate).toBe(80); // (4000 / 5000) * 100
  });

  it("handles negative net (deficit) gracefully", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "1000", onBudget: true, sort: 1 }],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Freelance", memo: "", amount: "1000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Landlord", memo: "", amount: "-1500", status: "c" },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(1000);
    expect(flow.outflow).toBe(1500);
    expect(flow.net).toBe(-500);
    expect(flow.savingsRate).toBe(-50);
  });
});

describe("computeTrailingNetWorth", () => {
  it("returns exactly 12 months ending at the specified month with delta and % change", () => {
    const seed = makeSeedBudgetData();
    const result = computeTrailingNetWorth(seed, "2026-06", 12);
    expect(result.points).toHaveLength(12);
    expect(result.points[0]?.month).toBe("2025-07");
    expect(result.points[11]?.month).toBe("2026-06");
    expect(result.currentNet).toBe(result.points[11]?.net);
    expect(result.delta).toBe(Math.round((result.currentNet - (result.points[0]?.net ?? 0)) * 100) / 100);
  });
});

describe("computeMonthlyInsights", () => {
  it("calculates 3-month average comparison and sorts by % change descending", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "5000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Dining Out", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Groceries", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Previous 3 months for Dining Out: avg ~100
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-10", payee: "Cafe", memo: "", amount: "-100", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Cafe", memo: "", amount: "-100", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Cafe", memo: "", amount: "-100", status: "c" },
        // Current month Dining Out: 250 (+150%)
        { id: 4, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Steakhouse", memo: "", amount: "-250", status: "c" },

        // Previous 3 months for Groceries: avg ~200
        { id: 5, accountId: 1, categoryId: 11, date: "2026-03-10", payee: "Market", memo: "", amount: "-200", status: "c" },
        { id: 6, accountId: 1, categoryId: 11, date: "2026-04-10", payee: "Market", memo: "", amount: "-200", status: "c" },
        { id: 7, accountId: 1, categoryId: 11, date: "2026-05-10", payee: "Market", memo: "", amount: "-200", status: "c" },
        // Current month Groceries: 240 (+20%)
        { id: 8, accountId: 1, categoryId: 11, date: "2026-06-10", payee: "Market", memo: "", amount: "-240", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(2);
    // Dining Out (+150%) should come before Groceries (+20%)
    expect(insights[0]?.categoryName).toBe("Dining Out");
    expect(insights[0]?.pctChange).toBe(150);
    expect(insights[1]?.categoryName).toBe("Groceries");
    expect(insights[1]?.pctChange).toBe(20);
  });
});
