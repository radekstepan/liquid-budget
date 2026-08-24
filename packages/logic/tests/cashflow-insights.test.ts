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
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 1 }],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        // Income
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: "500000", status: "c", isIncome: true },
        // Outflow
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Supermarket", memo: "", amount: "-100000", status: "c" },
        // Transfer (should not count as income or outflow)
        { id: 3, accountId: 1, categoryId: null, date: "2026-06-10", payee: "Transfer", memo: "", amount: "-50000", status: "c", transferAccountId: 2 },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(500000);
    expect(flow.outflow).toBe(100000);
    expect(flow.net).toBe(400000);
    expect(flow.savingsRate).toBe(80); // (400000 / 500000) * 100
  });

  it("handles negative net (deficit) gracefully", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 1 }],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Freelance", memo: "", amount: "100000", status: "c", isIncome: true },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Landlord", memo: "", amount: "-150000", status: "c" },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(100000);
    expect(flow.outflow).toBe(150000);
    expect(flow.net).toBe(-50000);
    expect(flow.savingsRate).toBe(-50);
  });

  it("factors in categorized refunds to reduce outflow (8.1)", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        // Income: $500.00
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: "500000", status: "c", isIncome: true },
        // Outflow: $100.00
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Supermarket", memo: "", amount: "-100000", status: "c" },
        // Categorized store refund: +$20.00
        { id: 3, accountId: 1, categoryId: 10, date: "2026-06-15", payee: "Supermarket Return", memo: "Refund", amount: "20000", status: "c" },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(500000);
    expect(flow.outflow).toBe(80000); // 100000 - 20000
    expect(flow.net).toBe(420000);
    expect(flow.savingsRate).toBe(84); // (420000 / 500000) * 100
  });

  it("excludes off-budget transactions such as investment fees and dividends (8.2)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 },
        { id: 2, name: "Investments", kind: "offbudget", groupLabel: "Tracking", balance: "1000000", onBudget: false, sort: 2 },
      ],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        // On-budget income: $500.00
        { id: 1, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: "500000", status: "c", isIncome: true },
        // On-budget outflow: $100.00
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Supermarket", memo: "", amount: "-100000", status: "c" },
        // Off-budget investment management fee: -$50.00 (should NOT count as budget outflow)
        { id: 3, accountId: 2, categoryId: null, date: "2026-06-10", payee: "Broker Fee", memo: "", amount: "-50000", status: "c" },
        // Off-budget dividend: +$200.00 (should NOT count as budget income)
        { id: 4, accountId: 2, categoryId: null, date: "2026-06-15", payee: "Dividend", memo: "", amount: "200000", status: "c", isIncome: true },
      ],
    };

    const flow = computeCashFlow(data, "2026-06");
    expect(flow.income).toBe(500000);
    expect(flow.outflow).toBe(100000);
    expect(flow.net).toBe(400000);
    expect(flow.savingsRate).toBe(80);
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
    expect(result.delta).toBe(result.currentNet - (result.points[0]?.net ?? 0));
  });
});

describe("computeMonthlyInsights", () => {
  it("calculates 3-month average comparison and sorts by % change descending", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Dining Out", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Groceries", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Previous 3 months for Dining Out: avg ~10000 ($100)
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-10", payee: "Cafe", memo: "", amount: "-10000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Cafe", memo: "", amount: "-10000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Cafe", memo: "", amount: "-10000", status: "c" },
        // Current month Dining Out: 25000 (+150%)
        { id: 4, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Steakhouse", memo: "", amount: "-25000", status: "c" },

        // Previous 3 months for Groceries: avg ~20000 ($200)
        { id: 5, accountId: 1, categoryId: 11, date: "2026-03-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 6, accountId: 1, categoryId: 11, date: "2026-04-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 7, accountId: 1, categoryId: 11, date: "2026-05-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        // Current month Groceries: 24000 (+20%)
        { id: 8, accountId: 1, categoryId: 11, date: "2026-06-10", payee: "Market", memo: "", amount: "-24000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(2);
    expect(insights[0]?.categoryName).toBe("Dining Out");
    expect(insights[0]?.pctChange).toBe(150);
    expect(insights[1]?.categoryName).toBe("Groceries");
    expect(insights[1]?.pctChange).toBe(20);
  });

  it("averages over only active prior months for newly created categories (Issue #17)", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "New Category", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Category only has 1 prior month of data ($100 in May)
        { id: 1, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Shop", memo: "", amount: "-10000", status: "c" },
        // Current month spend is $100 in June -> 0% change, not +200%
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Shop", memo: "", amount: "-10000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(1);
    expect(insights[0]?.categoryName).toBe("New Category");
    expect(insights[0]?.avgAmount).toBe(10000); // Divided by 1, not 3
    expect(insights[0]?.pctChange).toBe(0);
  });

  it("factors in refunds and returns to reduce net category spend (UNI-35 / BUG-28)", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Electronics", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Prior month: $200 spent in May
        { id: 1, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "BestBuy", memo: "", amount: "-20000", status: "c" },
        // Current month: $200 purchase + $100 return/refund in June -> net spend $100 (-50% vs May)
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "BestBuy", memo: "Purchase", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-06-15", payee: "BestBuy Return", memo: "Refund", amount: "10000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(1);
    expect(insights[0]?.categoryName).toBe("Electronics");
    expect(insights[0]?.amount).toBe(10000); // $100 net
    expect(insights[0]?.avgAmount).toBe(20000); // $200 avg
    expect(insights[0]?.pctChange).toBe(-50); // -50%
  });
});
