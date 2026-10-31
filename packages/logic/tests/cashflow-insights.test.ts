import { describe, expect, it } from "vitest";
import {
  computeCashFlow,
  computeCashFlowRange,
  computeMonthlySurplus,
  computeTrailingNetWorth,
  computeMonthlyInsights,
  computeTrendline,
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

  it("computes cash flow across a multi-month range and excludes off-budget account activity", () => {
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
        { id: 1, accountId: 1, categoryId: null, date: "2026-04-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-100000", status: "c" },
        { id: 3, accountId: 1, categoryId: null, date: "2026-05-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
        { id: 4, accountId: 2, categoryId: null, date: "2026-05-10", payee: "Offbudget Outflow", memo: "", amount: "-50000", status: "c" },
        { id: 5, accountId: 2, categoryId: null, date: "2026-05-15", payee: "Dividend", memo: "", amount: "100000", status: "c", isIncome: true },
        { id: 6, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
        { id: 7, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "Supermarket", memo: "", amount: "-50000", status: "c" },
      ],
    };

    const rangeFlow = computeCashFlowRange(data, "2026-04", "2026-06");
    expect(rangeFlow.income).toBe(900000); // 300k + 300k + 300k, excluding dividend
    expect(rangeFlow.outflow).toBe(150000); // 100k + 50k, excluding offbudget fee
    expect(rangeFlow.net).toBe(750000);
  });
});

describe("computeMonthlySurplus", () => {
  function makeData(): BudgetData {
    return {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 },
        { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "200000", onBudget: true, sort: 2 },
      ],
      groups: [],
      categories: [{ id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      recurring: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-04-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-100000", status: "c" },
        { id: 3, accountId: 1, categoryId: null, date: "2026-05-01", payee: "Employer", memo: "", amount: "300000", status: "c", isIncome: true },
        { id: 4, accountId: 1, categoryId: 10, date: "2026-05-05", payee: "Supermarket", memo: "", amount: "-350000", status: "c" },
      ],
    };
  }

  it("returns one point per month with income, outflow, and surplus", () => {
    const pts = computeMonthlySurplus(makeData(), "2026-04", "2026-06");
    expect(pts).toEqual([
      { month: "2026-04", income: 300000, outflow: 100000, surplus: 200000 },
      { month: "2026-05", income: 300000, outflow: 350000, surplus: -50000 },
      { month: "2026-06", income: 0, outflow: 0, surplus: 0 },
    ]);
  });

  it("matches computeCashFlow for each month in the range", () => {
    const data = makeData();
    const pts = computeMonthlySurplus(data, "2026-04", "2026-05");
    for (const p of pts) {
      const flow = computeCashFlow(data, p.month);
      expect(p.income).toBe(flow.income);
      expect(p.outflow).toBe(flow.outflow);
      expect(p.surplus).toBe(flow.net);
    }
  });

  it("excludes internal transfers and split parents like the cash-flow summary", () => {
    const data = makeData();
    data.transactions.push(
      // Internal on-budget transfer: must not move income or outflow.
      { id: 10, accountId: 1, transferAccountId: 2, categoryId: null, date: "2026-04-15", payee: "Transfer : Savings", memo: "", amount: "-50000", status: "c" },
      // Split parent: only the children carry deltas.
      { id: 20, accountId: 1, categoryId: null, date: "2026-04-20", payee: "Costco", memo: "Split parent", amount: "-60000", status: "c" },
      { id: 21, parentId: 20, accountId: 1, categoryId: 10, date: "2026-04-20", payee: "Costco", memo: "", amount: "-60000", status: "c" },
    );
    const pts = computeMonthlySurplus(data, "2026-04", "2026-04");
    expect(pts).toEqual([
      { month: "2026-04", income: 300000, outflow: 160000, surplus: 140000 },
    ]);
  });

  it("normalizes a swapped start/end range", () => {
    const pts = computeMonthlySurplus(makeData(), "2026-05", "2026-04");
    expect(pts.map((p) => p.month)).toEqual(["2026-04", "2026-05"]);
    expect(pts[0]?.surplus).toBe(200000);
    expect(pts[1]?.surplus).toBe(-50000);
  });
});

describe("computeTrendline", () => {
  it("returns null when fewer than 2 values are available", () => {
    expect(computeTrendline([])).toBeNull();
    expect(computeTrendline([100000])).toBeNull();
  });

  it("fits a perfect line through collinear values", () => {
    const fit = computeTrendline([100, 200, 300, 400]);
    expect(fit).not.toBeNull();
    expect(fit?.slope).toBeCloseTo(100, 10);
    expect(fit?.intercept).toBeCloseTo(100, 10);
    expect(fit?.fitted).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(fit?.fitted[i]).toBeCloseTo(100 + 100 * i, 10);
    }
  });

  it("fits a zero slope for a constant series", () => {
    const fit = computeTrendline([50000, 50000, 50000]);
    expect(fit?.slope).toBeCloseTo(0, 10);
    expect(fit?.intercept).toBeCloseTo(50000, 10);
    expect(fit?.fitted).toEqual([50000, 50000, 50000]);
  });

  it("fits a negative slope for a declining series", () => {
    const fit = computeTrendline([300, 100, -100]);
    expect(fit?.slope).toBeCloseTo(-200, 10);
    expect(fit?.intercept).toBeCloseTo(300, 10);
  });

  it("fits two points exactly", () => {
    const fit = computeTrendline([200000, -50000]);
    expect(fit?.slope).toBeCloseTo(-250000, 10);
    expect(fit?.intercept).toBeCloseTo(200000, 10);
    expect(fit?.fitted?.[0]).toBeCloseTo(200000, 10);
    expect(fit?.fitted?.[1]).toBeCloseTo(-50000, 10);
  });

  it("matches the hand-computed least-squares fit on noisy data", () => {
    // x = 0..3, y = [1, 3, 2, 4]: slope 0.8, intercept 1.3.
    const fit = computeTrendline([1, 3, 2, 4]);
    expect(fit?.slope).toBeCloseTo(0.8, 10);
    expect(fit?.intercept).toBeCloseTo(1.3, 10);
    expect(fit?.fitted).toHaveLength(4);
    expect(fit?.fitted?.[0]).toBeCloseTo(1.3, 10);
    expect(fit?.fitted?.[3]).toBeCloseTo(3.7, 10);
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
  it("calculates 3-month average comparison and sorts by largest absolute move", () => {
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
        // Current month Groceries: 30000 (+50%)
        { id: 8, accountId: 1, categoryId: 11, date: "2026-06-10", payee: "Market", memo: "", amount: "-30000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(2);
    // Sorted by absolute dollar move: Dining Out's $150 move ($250 vs $100
    // avg) beats Groceries' $100 move ($300 vs $200 avg) despite the
    // smaller spend.
    expect(insights[0]?.categoryName).toBe("Dining Out");
    expect(insights[0]?.amount).toBe(25000);
    expect(insights[0]?.pctChange).toBe(150);
    expect(insights[1]?.categoryName).toBe("Groceries");
    expect(insights[1]?.amount).toBe(30000);
    expect(insights[1]?.pctChange).toBe(50);
  });

  it("suppresses near-zero % changes as noise", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Flat", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Nearly Flat", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-10", payee: "Shop", memo: "", amount: "-20000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Shop", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Shop", memo: "", amount: "-20000", status: "c" },
        // Exactly on baseline: +0% is not a trend.
        { id: 4, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Shop", memo: "", amount: "-20000", status: "c" },
        { id: 5, accountId: 1, categoryId: 11, date: "2026-03-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 6, accountId: 1, categoryId: 11, date: "2026-04-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 7, accountId: 1, categoryId: 11, date: "2026-05-10", payee: "Market", memo: "", amount: "-20000", status: "c" },
        // +3% is noise too.
        { id: 8, accountId: 1, categoryId: 11, date: "2026-06-10", payee: "Market", memo: "", amount: "-20600", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(1);
    expect(insights[0]?.type).toBe("clean");
  });

  it("divides baseline average by months present in the window and handles 0-spend categories (BUG-23)", () => {
    const data1PriorMonth: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Category A", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Category B", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Spend 30000 cents ($300) in one prior month (May) for Category A
        { id: 1, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Shop", memo: "", amount: "-30000", status: "c" },
        // Current month spend is $450 in June -> baseline is 30000 / 1 = 30000, % change is +50%
        { id: 2, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Shop", memo: "", amount: "-45000", status: "c" },
        // Category B has $100 spent in May, $0 in June -> baseline is 10000 / 1 = 10000, % change is -100%
        { id: 3, accountId: 1, categoryId: 11, date: "2026-05-10", payee: "Market", memo: "", amount: "-10000", status: "c" },
      ],
    };

    const insights1 = computeMonthlyInsights(data1PriorMonth, "2026-06");
    expect(insights1).toHaveLength(2);
    expect(insights1[0]?.categoryName).toBe("Category A");
    expect(insights1[0]?.avgAmount).toBe(30000); // 30000 / 1 = 30000
    expect(insights1[0]?.pctChange).toBe(50); // (45000 - 30000) / 30000 = +50%
    expect(insights1[1]?.categoryName).toBe("Category B");
    expect(insights1[1]?.amount).toBe(0);
    expect(insights1[1]?.avgAmount).toBe(10000);
    expect(insights1[1]?.pctChange).toBe(-100);

    // 2 prior months with data (April & May)
    const data2PriorMonths: BudgetData = {
      ...data1PriorMonth,
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Shop", memo: "", amount: "-40000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Shop", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Shop", memo: "", amount: "-45000", status: "c" },
      ],
    };

    const insights2 = computeMonthlyInsights(data2PriorMonths, "2026-06");
    expect(insights2).toHaveLength(1);
    expect(insights2[0]?.categoryName).toBe("Category A");
    expect(insights2[0]?.avgAmount).toBe(30000); // (40000 + 20000) / 2 = 30000
    expect(insights2[0]?.pctChange).toBe(50); // (45000 - 30000) / 30000 = +50%

    // 0 prior months with data -> clean insight
    const data0PriorMonths: BudgetData = {
      ...data1PriorMonth,
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Shop", memo: "", amount: "-30000", status: "c" },
      ],
    };

    const insights0 = computeMonthlyInsights(data0PriorMonths, "2026-06");
    expect(insights0).toHaveLength(1);
    expect(insights0[0]?.type).toBe("clean");
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
        // Prior 3 months: $200 spent each month (March, April, May) -> avg $200 (20000 cents)
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-10", payee: "BestBuy", memo: "", amount: "-20000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "BestBuy", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "BestBuy", memo: "", amount: "-20000", status: "c" },
        // Current month: $200 purchase + $100 return/refund in June -> net spend $100 (-50% vs $200 3-mo avg)
        { id: 4, accountId: 1, categoryId: 10, date: "2026-06-05", payee: "BestBuy", memo: "Purchase", amount: "-20000", status: "c" },
        { id: 5, accountId: 1, categoryId: 10, date: "2026-06-15", payee: "BestBuy Return", memo: "Refund", amount: "10000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    expect(insights).toHaveLength(1);
    expect(insights[0]?.categoryName).toBe("Electronics");
    expect(insights[0]?.amount).toBe(10000); // $100 net
    expect(insights[0]?.avgAmount).toBe(20000); // $200 avg
    expect(insights[0]?.pctChange).toBe(-50); // -50%
  });

  it("excludes CC payment categories from insights to match computeSpendingTrends (BUG-12)", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [
        { id: 1, name: "Daily", sort: 1, isCreditCardPayments: false },
        { id: 2, name: "Credit Card Payments", sort: 2, isCreditCardPayments: true },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 2, name: "Visa Card", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Groceries: $50 in each of prior 3 months, $100 current month
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-10", payee: "Market", memo: "", amount: "-5000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Market", memo: "", amount: "-5000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-10", payee: "Market", memo: "", amount: "-5000", status: "c" },
        { id: 4, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Market", memo: "", amount: "-10000", status: "c" },
        // CC Payment: $100 in each of prior 3 months, $200 current month (should be excluded)
        { id: 5, accountId: 1, categoryId: 11, date: "2026-03-15", payee: "Visa Payment", memo: "", amount: "-10000", status: "c" },
        { id: 6, accountId: 1, categoryId: 11, date: "2026-04-15", payee: "Visa Payment", memo: "", amount: "-10000", status: "c" },
        { id: 7, accountId: 1, categoryId: 11, date: "2026-05-15", payee: "Visa Payment", memo: "", amount: "-10000", status: "c" },
        { id: 8, accountId: 1, categoryId: 11, date: "2026-06-15", payee: "Visa Payment", memo: "", amount: "-20000", status: "c" },
      ],
    };

    const insights = computeMonthlyInsights(data, "2026-06");
    // Only Groceries should appear, not Visa Card
    expect(insights).toHaveLength(1);
    expect(insights[0]?.categoryName).toBe("Groceries");
  });
});

describe("computeMonthlyInsights month-to-date alignment", () => {
  function makeMtdData(): BudgetData {
    return {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Bills", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 10, groupId: 1, name: "Condo Fees", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Groceries", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        // Condo Fees: $500 due late each prior month (28th), not yet paid in June.
        { id: 1, accountId: 1, categoryId: 10, date: "2026-03-28", payee: "HOA", memo: "", amount: "-50000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-04-28", payee: "HOA", memo: "", amount: "-50000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-05-28", payee: "HOA", memo: "", amount: "-50000", status: "c" },
        // Groceries: $200 early (5th) + $200 late (25th) each prior month.
        { id: 4, accountId: 1, categoryId: 11, date: "2026-03-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 5, accountId: 1, categoryId: 11, date: "2026-03-25", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 6, accountId: 1, categoryId: 11, date: "2026-04-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 7, accountId: 1, categoryId: 11, date: "2026-04-25", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 8, accountId: 1, categoryId: 11, date: "2026-05-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 9, accountId: 1, categoryId: 11, date: "2026-05-25", payee: "Market", memo: "", amount: "-20000", status: "c" },
        // June so far: only the early groceries trip.
        { id: 10, accountId: 1, categoryId: 11, date: "2026-06-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
      ],
    };
  }

  it("suppresses not-yet-due bills instead of reporting them as savings", () => {
    const insights = computeMonthlyInsights(makeMtdData(), "2026-06", undefined, {
      asOfDate: "2026-06-15",
    });
    // Condo Fees ($0 MTD vs $500 full-month avg) must not appear as -100% "saving".
    expect(insights.find((i) => i.categoryName === "Condo Fees")).toBeUndefined();
  });

  it("hides on-pace categories instead of showing +0% vs the MTD baseline", () => {
    const insights = computeMonthlyInsights(makeMtdData(), "2026-06", undefined, {
      asOfDate: "2026-06-15",
    });
    // Groceries at $200 MTD vs the $200 MTD baseline is exactly on pace:
    // not -50% vs the $400 full-month avg, and not worth showing as +0%.
    expect(insights.find((i) => i.categoryName === "Groceries")).toBeUndefined();
    expect(insights).toHaveLength(1);
    expect(insights[0]?.type).toBe("clean");
  });

  it("still flags early overspend against the MTD baseline", () => {
    const data = makeMtdData();
    data.transactions.push(
      { id: 11, accountId: 1, categoryId: 11, date: "2026-06-08", payee: "Market", memo: "", amount: "-40000", status: "c" },
    );
    const insights = computeMonthlyInsights(data, "2026-06", undefined, {
      asOfDate: "2026-06-15",
    });
    const groceries = insights.find((i) => i.categoryName === "Groceries");
    // $600 MTD vs $200 MTD baseline -> +200%.
    expect(groceries?.amount).toBe(60000);
    expect(groceries?.pctChange).toBe(200);
  });

  it("shows zero-spend categories as -100% (rendered as $0) against a positive MTD baseline", () => {
    const data = makeMtdData();
    // Remove the June groceries trip: $0 MTD vs $200 MTD baseline.
    data.transactions = data.transactions.filter((t) => t.id !== 10);
    const insights = computeMonthlyInsights(data, "2026-06", undefined, {
      asOfDate: "2026-06-15",
    });
    const groceries = insights.find((i) => i.categoryName === "Groceries");
    expect(groceries?.amount).toBe(0);
    expect(groceries?.avgAmount).toBe(20000);
    expect(groceries?.pctChange).toBe(-100);
    expect(groceries?.basis).toBe("mtd");
    // Condo Fees has no MTD baseline either (nothing due yet), so it stays hidden.
    expect(insights.find((i) => i.categoryName === "Condo Fees")).toBeUndefined();
  });

  it("suppresses mid-month net-refund spend as timing noise", () => {
    const data = makeMtdData();
    // June: $200 purchase + $300 refund -> net -$100 MTD (negative spend).
    data.transactions.push(
      { id: 11, accountId: 1, categoryId: 11, date: "2026-06-08", payee: "Market Return", memo: "Refund", amount: "30000", status: "c" },
    );
    const insights = computeMonthlyInsights(data, "2026-06", undefined, {
      asOfDate: "2026-06-15",
    });
    expect(insights.find((i) => i.categoryName === "Groceries")).toBeUndefined();
  });

  it("excludes future-dated transactions within the viewed month from the MTD total", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 }],
      groups: [{ id: 1, name: "Daily", sort: 1, isCreditCardPayments: false }],
      categories: [
        { id: 11, groupId: 1, name: "Groceries", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      recurring: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 11, date: "2026-03-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 2, accountId: 1, categoryId: 11, date: "2026-04-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 3, accountId: 1, categoryId: 11, date: "2026-05-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 4, accountId: 1, categoryId: 11, date: "2026-06-05", payee: "Market", memo: "", amount: "-20000", status: "c" },
        { id: 5, accountId: 1, categoryId: 11, date: "2026-06-08", payee: "Market", memo: "", amount: "-40000", status: "c" },
        // Entered ahead of time but not yet spent as of the 10th.
        { id: 6, accountId: 1, categoryId: 11, date: "2026-06-25", payee: "Market", memo: "", amount: "-20000", status: "c" },
      ],
    };
    const insights = computeMonthlyInsights(data, "2026-06", undefined, {
      asOfDate: "2026-06-10",
    });
    const groceries = insights.find((i) => i.categoryName === "Groceries");
    // $600 MTD (future-dated $200 excluded) vs $200 MTD baseline -> +200%,
    // not +300% on the $800 dated total vs the $200 full-month avg.
    expect(groceries?.amount).toBe(60000);
    expect(groceries?.avgAmount).toBe(20000);
    expect(groceries?.pctChange).toBe(200);
    expect(groceries?.basis).toBe("mtd");
  });

  it("uses full-month comparison when viewing a completed past month", () => {
    const data = makeMtdData();
    data.transactions.push(
      { id: 11, accountId: 1, categoryId: 10, date: "2026-06-28", payee: "HOA", memo: "", amount: "-60000", status: "c" },
    );
    const insights = computeMonthlyInsights(data, "2026-06", undefined, {
      asOfDate: "2026-07-15",
    });
    // Full month vs full-month average: Condo $600 vs $500 avg (+20%),
    // Groceries $200 (late trip never happened) vs $400 avg (-50%).
    // Groceries' $200 saving outranks Condo's $100 overspend.
    expect(insights).toHaveLength(2);
    expect(insights[0]?.categoryName).toBe("Groceries");
    expect(insights[0]?.amount).toBe(20000);
    expect(insights[0]?.pctChange).toBe(-50);
    expect(insights[1]?.categoryName).toBe("Condo Fees");
    expect(insights[1]?.amount).toBe(60000);
    expect(insights[1]?.avgAmount).toBe(50000);
    expect(insights[1]?.pctChange).toBe(20);
    expect(insights[1]?.basis).toBe("full");
  });

  it("returns a clean insight when viewing a future month", () => {
    const insights = computeMonthlyInsights(makeMtdData(), "2026-07", undefined, {
      asOfDate: "2026-06-15",
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]?.type).toBe("clean");
  });
});
