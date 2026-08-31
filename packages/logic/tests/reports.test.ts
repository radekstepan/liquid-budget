import { describe, expect, it } from "vitest";
import {
  computeNetWorthReport,
  computeTrailingNetWorth,
  getMonthsBetween,
  computeSpendingTrends,
  getSpendingTransactions,
} from "../src/reports.js";
import type { BudgetData } from "../src/types.js";

function makeBaseData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Credit Card", kind: "credit", groupLabel: "Credit Cards", balance: "-20000", onBudget: true, sort: 1 },
      { id: 3, name: "Home Value", kind: "offbudget", groupLabel: "Property", balance: "50000000", onBudget: false, sort: 2 },
      { id: 4, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-30000000", onBudget: false, sort: 3 },
    ],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

describe("getMonthsBetween", () => {
  it("generates single month when start equals end", () => {
    expect(getMonthsBetween("2026-06", "2026-06")).toEqual(["2026-06"]);
  });

  it("generates contiguous list across calendar years", () => {
    expect(getMonthsBetween("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("computeNetWorthReport", () => {
  it("maintains steady base balances for accounts with no transactions", () => {
    const data = makeBaseData();
    const pts = computeNetWorthReport(data, "2026-04", "2026-06");
    expect(pts).toHaveLength(3);
    for (const p of pts) {
      // Assets = Chequing (100000) + Home Value (50000000) = 50100000
      expect(p.assets).toBe(50100000);
      // Debts = Credit Card (-20000) + Mortgage (-30000000) = -30020000
      expect(p.debts).toBe(-30020000);
      // Net = 50100000 - 30020000 = 20080000
      expect(p.net).toBe(20080000);
    }
  });

  it("properly advances balances month by month with regular transactions", () => {
    const data = makeBaseData();
    data.transactions = [
      { id: 1, accountId: 1, categoryId: null, date: "2026-04-01", payee: "Salary", memo: "", amount: "300000", status: "c" },
      { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Rent", memo: "", amount: "-100000", status: "c" },
      { id: 3, accountId: 2, categoryId: 11, date: "2026-05-05", payee: "Target", memo: "", amount: "-30000", status: "c" },
      { id: 4, accountId: 1, categoryId: 12, date: "2026-06-02", payee: "Dining", memo: "", amount: "-50000", status: "c" },
    ];

    const pts = computeNetWorthReport(data, "2026-04", "2026-06");
    expect(pts).toHaveLength(3);

    expect(pts[0]?.month).toBe("2026-04");
    expect(pts[0]?.assets).toBe(50150000);
    expect(pts[0]?.debts).toBe(-30000000);
    expect(pts[0]?.net).toBe(20150000);

    expect(pts[1]?.month).toBe("2026-05");
    expect(pts[1]?.assets).toBe(50150000);
    expect(pts[1]?.debts).toBe(-30020000);
    expect(pts[1]?.net).toBe(20130000);

    expect(pts[2]?.month).toBe("2026-06");
    expect(pts[2]?.assets).toBe(50100000);
    expect(pts[2]?.debts).toBe(-30020000);
    expect(pts[2]?.net).toBe(20080000);
  });

  it("handles inter-account transfers without losing money", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "400000", onBudget: true, sort: 0 },
        { id: 2, name: "Credit Card", kind: "credit", groupLabel: "Credit Cards", balance: "0", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Salary", memo: "", amount: "500000", status: "c" },
        { id: 2, accountId: 2, categoryId: 10, date: "2026-02-05", payee: "Store", memo: "", amount: "-100000", status: "c" },
        { id: 3, accountId: 1, transferAccountId: 2, categoryId: null, date: "2026-03-01", payee: "Transfer : Credit Card", memo: "", amount: "-100000", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-03");
    expect(pts).toHaveLength(3);

    expect(pts[0]).toEqual({ month: "2026-01", assets: 500000, debts: 0, net: 500000 });
    expect(pts[1]).toEqual({ month: "2026-02", assets: 500000, debts: -100000, net: 400000 });
    expect(pts[2]).toEqual({ month: "2026-03", assets: 400000, debts: 0, net: 400000 });
  });

  it("skips split parent transactions to avoid double-counting", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "90000", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "100000", status: "c" },
        { id: 10, accountId: 1, categoryId: null, date: "2026-02-10", payee: "Costco", memo: "Split parent", amount: "-10000", status: "c" },
        { id: 11, accountId: 1, parentId: 10, categoryId: 1, date: "2026-02-10", payee: "Costco", memo: "Groceries", amount: "-6000", status: "c" },
        { id: 12, accountId: 1, parentId: 10, categoryId: 2, date: "2026-02-10", payee: "Costco", memo: "Household", amount: "-4000", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-02");
    expect(pts).toHaveLength(2);

    expect(pts[0]?.net).toBe(100000);
    expect(pts[1]?.net).toBe(90000);
  });

  it("handles split transactions with sub-transfer accounts correctly", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "90000", onBudget: true, sort: 0 },
        { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget Accounts", balance: "4000", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "100000", status: "c" },
        { id: 10, accountId: 1, categoryId: null, date: "2026-02-10", payee: "Multiple", memo: "", amount: "-10000", status: "c" },
        { id: 11, accountId: 1, parentId: 10, categoryId: 1, date: "2026-02-10", payee: "Costco", memo: "Groceries", amount: "-6000", status: "c" },
        { id: 12, accountId: 1, parentId: 10, transferAccountId: 2, categoryId: null, date: "2026-02-10", payee: "Transfer : Savings", memo: "", amount: "-4000", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-02");
    expect(pts).toHaveLength(2);

    expect(pts[0]?.net).toBe(100000);
    expect(pts[1]?.net).toBe(94000);
  });

  it("BUG-21: does not create phantom accounts for transactions referencing deleted or unknown account IDs", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "100000", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "100000", status: "c" },
        // Transaction referencing deleted account 999
        { id: 2, accountId: 999, categoryId: null, date: "2026-02-01", payee: "Orphaned", memo: "", amount: "50000", status: "c" },
        // Transfer to deleted account 888
        { id: 3, accountId: 1, transferAccountId: 888, categoryId: null, date: "2026-03-01", payee: "Transfer : Deleted", memo: "", amount: "-10000", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-03");
    expect(pts).toHaveLength(3);

    // 2026-01: Chequing = 110000 (100000 balance + 10000 delta from 2026-03)
    // Account 999 is ignored completely.
    expect(pts[0]).toEqual({ month: "2026-01", assets: 110000, debts: 0, net: 110000 });
    // 2026-02: Chequing = 110000, no phantom account 999
    expect(pts[1]).toEqual({ month: "2026-02", assets: 110000, debts: 0, net: 110000 });
    // 2026-03: Chequing = 100000, no phantom account 888
    expect(pts[2]).toEqual({ month: "2026-03", assets: 100000, debts: 0, net: 100000 });
  });

  it("clamps account balances to 0 for months prior to their opening activity (UNI-36 / F-17)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "100000", onBudget: true, sort: 0 },
        { id: 2, name: "New Savings", kind: "liquid", groupLabel: "Budget Accounts", balance: "50000", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // Chequing exists since 2026-01
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Opening", memo: "", amount: "100000", status: "c" },
        // New Savings opened in 2026-04 with $500
        { id: 2, accountId: 2, categoryId: null, date: "2026-04-01", payee: "Opening Savings", memo: "", amount: "50000", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-04");
    expect(pts).toHaveLength(4);

    // Months 2026-01 through 2026-03 should only reflect Chequing (100000)
    expect(pts[0]?.month).toBe("2026-01");
    expect(pts[0]?.assets).toBe(100000);
    expect(pts[0]?.net).toBe(100000);

    expect(pts[1]?.month).toBe("2026-02");
    expect(pts[1]?.assets).toBe(100000);
    expect(pts[1]?.net).toBe(100000);

    expect(pts[2]?.month).toBe("2026-03");
    expect(pts[2]?.assets).toBe(100000);
    expect(pts[2]?.net).toBe(100000);

    // Month 2026-04 includes New Savings (100000 + 50000 = 150000)
    expect(pts[3]?.month).toBe("2026-04");
    expect(pts[3]?.assets).toBe(150000);
    expect(pts[3]?.net).toBe(150000);
  });

  it("BUG-15: includes tracking account base balance in net worth from account createdAt before first transaction month", () => {
    const data: BudgetData = {
      accounts: [
        {
          id: 1,
          name: "House Tracking",
          kind: "offbudget",
          groupLabel: "Property",
          balance: "105000",
          onBudget: false,
          sort: 0,
          createdAt: "2025-01-15T00:00:00.000Z",
        },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // First adjustment transaction in Feb 2025 ($5,000 appreciation)
        {
          id: 1,
          accountId: 1,
          categoryId: null,
          date: "2025-02-10",
          payee: "Market Value Adjustment",
          memo: "",
          amount: "5000",
          status: "c",
        },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2024-12", "2025-03");
    expect(pts).toHaveLength(4);

    // 2024-12: Prior to account creation in Jan 2025 -> clamped to 0
    expect(pts[0]?.month).toBe("2024-12");
    expect(pts[0]?.assets).toBe(0);
    expect(pts[0]?.net).toBe(0);

    // 2025-01: Created in Jan 2025 with base balance $100,000 (105000 - 5000)
    expect(pts[1]?.month).toBe("2025-01");
    expect(pts[1]?.assets).toBe(100000);
    expect(pts[1]?.net).toBe(100000);

    // 2025-02: After first transaction in Feb 2025 ($100,000 + $5,000 = $105,000)
    expect(pts[2]?.month).toBe("2025-02");
    expect(pts[2]?.assets).toBe(105000);
    expect(pts[2]?.net).toBe(105000);

    // 2025-03: Steady at $105,000
    expect(pts[3]?.month).toBe("2025-03");
    expect(pts[3]?.assets).toBe(105000);
    expect(pts[3]?.net).toBe(105000);
  });

  it("BUG-15: includes starting balance from transaction date when createdAt is not explicitly set", () => {
    const data: BudgetData = {
      accounts: [
        {
          id: 1,
          name: "Car Asset",
          kind: "offbudget",
          groupLabel: "Property",
          balance: "2450000",
          onBudget: false,
          sort: 0,
        },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // Starting balance transaction in Jan 2025 ($25,000)
        {
          id: 1,
          accountId: 1,
          categoryId: null,
          date: "2025-01-01",
          payee: "Starting Balance",
          memo: "",
          amount: "2500000",
          status: "c",
        },
        // First maintenance transaction in March 2025 (-$500)
        {
          id: 2,
          accountId: 1,
          categoryId: null,
          date: "2025-03-15",
          payee: "Depreciation",
          memo: "",
          amount: "-50000",
          status: "c",
        },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2024-12", "2025-03");
    expect(pts).toHaveLength(4);

    // 2024-12: Clamped to 0 before starting balance transaction in Jan 2025
    expect(pts[0]?.month).toBe("2024-12");
    expect(pts[0]?.assets).toBe(0);
    expect(pts[0]?.net).toBe(0);

    // 2025-01 & 2025-02: Includes $25,000.00
    expect(pts[1]?.month).toBe("2025-01");
    expect(pts[1]?.assets).toBe(2500000);
    expect(pts[2]?.month).toBe("2025-02");
    expect(pts[2]?.assets).toBe(2500000);

    // 2025-03: $25,000 - $500 = $24,500
    expect(pts[3]?.month).toBe("2025-03");
    expect(pts[3]?.assets).toBe(2450000);
  });
});

describe("computeTrailingNetWorth", () => {
  it("calculates percentage delta correctly when startNet is positive (UNI-34 / BUG-27)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "150000", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "100000", status: "c" },
        { id: 2, accountId: 1, categoryId: null, date: "2026-03-01", payee: "Bonus", memo: "", amount: "50000", status: "c" },
      ],
      recurring: [],
    };

    const res = computeTrailingNetWorth(data, "2026-03", 3);
    expect(res.startNet).toBe(100000);
    expect(res.currentNet).toBe(150000);
    expect(res.delta).toBe(50000);
    expect(res.pctDelta).toBe(50); // 50%
  });

  it("returns null pctDelta when startNet === 0 and delta !== 0 (UNI-34 / BUG-27)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "50000", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-02-01", payee: "Deposit", memo: "", amount: "50000", status: "c" },
      ],
      recurring: [],
    };

    const res = computeTrailingNetWorth(data, "2026-03", 3);
    expect(res.startNet).toBe(0);
    expect(res.currentNet).toBe(50000);
    expect(res.delta).toBe(50000);
    expect(res.pctDelta).toBeNull();
  });

  it("returns 0 pctDelta when startNet === 0 and delta === 0", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [],
      recurring: [],
    };

    const res = computeTrailingNetWorth(data, "2026-03", 3);
    expect(res.startNet).toBe(0);
    expect(res.currentNet).toBe(0);
    expect(res.delta).toBe(0);
    expect(res.pctDelta).toBe(0);
  });
});

describe("computeSpendingTrends", () => {
  function makeSpendingData(): BudgetData {
    return {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "100000", onBudget: true, sort: 0 },
      ],
      groups: [
        { id: 1, name: "Everyday Expenses", sort: 0, isCreditCardPayments: false },
        { id: 2, name: "Monthly Bills", sort: 1, isCreditCardPayments: false },
        { id: 3, name: "CC Payments", sort: 2, isCreditCardPayments: true },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 1, name: "Fuel", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 20, groupId: 2, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 21, groupId: 2, name: "Internet", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // 2026-04
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-15000", status: "c" },
        { id: 2, accountId: 1, categoryId: 11, date: "2026-04-10", payee: "Gas Station", memo: "", amount: "-5000", status: "c" },
        { id: 3, accountId: 1, categoryId: 20, date: "2026-04-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        // 2026-05
        { id: 4, accountId: 1, categoryId: 10, date: "2026-05-02", payee: "Supermarket", memo: "", amount: "-20000", status: "c" },
        { id: 5, accountId: 1, categoryId: 10, date: "2026-05-15", payee: "Refund", memo: "Return", amount: "5000", status: "c" }, // refund net 15000
        { id: 6, accountId: 1, categoryId: 20, date: "2026-05-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        { id: 7, accountId: 1, categoryId: 21, date: "2026-05-10", payee: "ISP", memo: "", amount: "-6000", status: "c" },
        // 2026-06
        { id: 8, accountId: 1, categoryId: 10, date: "2026-06-08", payee: "Supermarket", memo: "", amount: "-18000", status: "c" },
        { id: 9, accountId: 1, categoryId: 11, date: "2026-06-12", payee: "Gas Station", memo: "", amount: "-6000", status: "c" },
        { id: 10, accountId: 1, categoryId: 20, date: "2026-06-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        // Split parent + children in 2026-06
        { id: 100, accountId: 1, categoryId: null, date: "2026-06-20", payee: "Costco", memo: "Parent", amount: "-10000", status: "c" },
        { id: 101, accountId: 1, parentId: 100, categoryId: 10, date: "2026-06-20", payee: "Costco", memo: "Food", amount: "-7000", status: "c" },
        { id: 102, accountId: 1, parentId: 100, categoryId: 11, date: "2026-06-20", payee: "Costco", memo: "Gas", amount: "-3000", status: "c" },
        // Transfer (should be ignored)
        { id: 200, accountId: 1, transferAccountId: 2, categoryId: null, date: "2026-06-25", payee: "Transfer", memo: "", amount: "-5000", status: "c" },
        // Income (should be ignored)
        { id: 300, accountId: 1, categoryId: null, date: "2026-06-01", payee: "Paycheck", memo: "", amount: "300000", status: "c" },
      ],
      recurring: [],
    };
  }

  it("computes top-level spending by master category across months", () => {
    const data = makeSpendingData();
    const result = computeSpendingTrends(data, "2026-04", "2026-06");

    expect(result.drillLevel).toBe("all");
    expect(result.months).toHaveLength(3);

    // 2026-04: Everyday (15000 + 5000 = 20000), Bills (100000) -> total 120000
    expect(result.months[0]?.month).toBe("2026-04");
    expect(result.months[0]?.total).toBe(120000);
    expect(result.months[0]?.segments).toEqual([
      { id: 1, name: "Everyday Expenses", amount: 20000 },
      { id: 2, name: "Monthly Bills", amount: 100000 },
    ]);

    // 2026-05: Everyday (20000 - 5000 = 15000), Bills (100000 + 6000 = 106000) -> total 121000
    expect(result.months[1]?.month).toBe("2026-05");
    expect(result.months[1]?.total).toBe(121000);

    // 2026-06: Everyday (18000 + 6000 + 7000 + 3000 = 34000), Bills (100000) -> total 134000
    expect(result.months[2]?.month).toBe("2026-06");
    expect(result.months[2]?.total).toBe(134000);

    // Overall stats
    expect(result.total).toBe(120000 + 121000 + 134000); // 375000
    expect(result.avgPerMonth).toBe(125000);
    expect(result.maxMonthSpend).toBe(134000);

    // Constituents: Monthly Bills (306000) > Everyday Expenses (69000)
    expect(result.constituents).toHaveLength(2);
    expect(result.constituents[0]?.name).toBe("Monthly Bills");
    expect(result.constituents[0]?.total).toBe(306000);
    expect(result.constituents[1]?.name).toBe("Everyday Expenses");
    expect(result.constituents[1]?.total).toBe(69000);
  });

  it("drills down into a master category to show constituent subcategories", () => {
    const data = makeSpendingData();
    const result = computeSpendingTrends(data, "2026-04", "2026-06", {
      drillGroupId: 1,
    });

    expect(result.drillLevel).toBe("group");
    expect(result.currentGroupId).toBe(1);
    expect(result.currentGroupName).toBe("Everyday Expenses");
    expect(result.months).toHaveLength(3);

    // 2026-04: Groceries (15000), Fuel (5000) -> total 20000
    expect(result.months[0]?.total).toBe(20000);
    expect(result.months[0]?.segments).toEqual([
      { id: 10, name: "Groceries", amount: 15000 },
      { id: 11, name: "Fuel", amount: 5000 },
    ]);

    // 2026-05: Groceries (20000 - 5000 = 15000) -> total 15000
    expect(result.months[1]?.total).toBe(15000);
    expect(result.months[1]?.segments).toEqual([
      { id: 10, name: "Groceries", amount: 15000 },
    ]);

    // 2026-06: Groceries (18000 + 7000 = 25000), Fuel (6000 + 3000 = 9000) -> total 34000
    expect(result.months[2]?.total).toBe(34000);

    // Constituents: Groceries (15000 + 15000 + 25000 = 55000), Fuel (5000 + 0 + 9000 = 14000)
    expect(result.constituents[0]?.name).toBe("Groceries");
    expect(result.constituents[0]?.total).toBe(55000);
    expect(result.constituents[1]?.name).toBe("Fuel");
    expect(result.constituents[1]?.total).toBe(14000);
  });

  it("drills down into a specific subcategory", () => {
    const data = makeSpendingData();
    const result = computeSpendingTrends(data, "2026-04", "2026-06", {
      drillCategoryId: 10,
    });

    expect(result.drillLevel).toBe("category");
    expect(result.currentCategoryId).toBe(10);
    expect(result.currentCategoryName).toBe("Groceries");
    expect(result.currentGroupId).toBe(1);
    expect(result.currentGroupName).toBe("Everyday Expenses");

    expect(result.months[0]?.total).toBe(15000);
    expect(result.months[1]?.total).toBe(15000);
    expect(result.months[2]?.total).toBe(25000);
    expect(result.total).toBe(55000);
    expect(result.constituents).toHaveLength(1);
  });

  it("respects activeCategoryIds filter", () => {
    const data = makeSpendingData();
    // Only Groceries (10) and Rent (20) are active
    const active = new Set([10, 20]);
    const result = computeSpendingTrends(data, "2026-04", "2026-06", {
      activeCategoryIds: active,
    });

    // 2026-04: Groceries (15000) + Rent (100000) = 115000 (Fuel is excluded)
    expect(result.months[0]?.total).toBe(115000);
    expect(result.months[0]?.segments).toEqual([
      { id: 1, name: "Everyday Expenses", amount: 15000 },
      { id: 2, name: "Monthly Bills", amount: 100000 },
    ]);
  });

  it("counts a liquidation transfer (off-budget -> on-budget) as negative spending", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "EQ Bank", kind: "liquid", groupLabel: "Budget", balance: "50000000", onBudget: true, sort: 0 },
        { id: 2, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [{ id: 4, name: "Savings, Investments", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 30, groupId: 4, name: "Other Investments", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      transactions: [
        // Feb: contribution $3,000 out of budget -> positive spending
        { id: 1, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-02-15", payee: "Transfer : Wealthsimple Trade", memo: "deposit", amount: "-300000", status: "c" },
        // Mar: withdrawal/liquidation $338,269.92 into budget -> negative spending
        { id: 2, accountId: 1, transferAccountId: 2, categoryId: 30, date: "2026-03-06", payee: "Transfer : Wealthsimple Trade", memo: "sell all", amount: "33826992", status: "c" },
      ],
      recurring: [],
    };

    const result = computeSpendingTrends(data, "2026-02", "2026-03");
    expect(result.months).toHaveLength(2);

    // Feb: +$3,000.00
    expect(result.months[0]?.month).toBe("2026-02");
    expect(result.months[0]?.total).toBe(300000);
    expect(result.months[0]?.segments).toEqual([
      { id: 4, name: "Savings, Investments", amount: 300000 },
    ]);

    // Mar: -$338,269.92
    expect(result.months[1]?.month).toBe("2026-03");
    expect(result.months[1]?.total).toBe(-33826992);
    expect(result.months[1]?.segments).toEqual([
      { id: 4, name: "Savings, Investments", amount: -33826992 },
    ]);

    expect(result.maxMonthSpend).toBe(300000);
    expect(result.minMonthSpend).toBe(-33826992);
    expect(result.total).toBe(300000 - 33826992);
  });

  it("sets pctOfTotal to 0 for constituents when overall total is negative (BUG-37)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
        { id: 2, name: "Brokerage", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 1 },
      ],
      groups: [
        { id: 1, name: "Groceries Group", sort: 0, isCreditCardPayments: false },
        { id: 2, name: "Investments Group", sort: 1, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Food", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 20, groupId: 2, name: "Stocks", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        // Group 1 contributes +10000 ($100 spend)
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-10000", status: "c" },
        // Group 2 contributes -20000 ($200 liquidation / refund)
        { id: 2, accountId: 1, transferAccountId: 2, categoryId: 20, date: "2026-04-10", payee: "Transfer : Brokerage", memo: "", amount: "20000", status: "c" },
      ],
      recurring: [],
    };

    const result = computeSpendingTrends(data, "2026-04", "2026-04");
    expect(result.total).toBe(-10000);
    expect(result.constituents).toHaveLength(2);
    // When overallTotal is non-positive, pctOfTotal must not produce inverted -100% or 200%
    for (const c of result.constituents) {
      expect(c.pctOfTotal).toBe(0);
    }
  });
});

describe("getSpendingTransactions", () => {
  it("filters transactions by date range and category", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 }],
      groups: [{ id: 1, name: "Bills", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 10, groupId: 1, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        { id: 2, accountId: 1, categoryId: 10, date: "2026-05-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
        { id: 3, accountId: 1, categoryId: 10, date: "2026-06-01", payee: "Landlord", memo: "", amount: "-100000", status: "c" },
      ],
      recurring: [],
    };

    const all = getSpendingTransactions(data, "2026-04", "2026-06", { categoryId: 10 });
    expect(all).toHaveLength(3);

    const mayOnly = getSpendingTransactions(data, "2026-04", "2026-06", { categoryId: 10, month: "2026-05" });
    expect(mayOnly).toHaveLength(1);
    expect(mayOnly[0]?.date).toBe("2026-05-01");
  });

  it("includes transfers with a category (e.g. to off-budget investment accounts)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
        { id: 2, name: "Wealthsimple RRSP", kind: "offbudget", groupLabel: "Investments", balance: "25000", onBudget: false, sort: 1 },
      ],
      groups: [{ id: 1, name: "Savings, Investments", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 50, groupId: 1, name: "Retirement", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, transferAccountId: 2, categoryId: 50, date: "2026-04-15", payee: "Transfer : Wealthsimple RRSP", memo: "", amount: "-25000", status: "c" },
      ],
      recurring: [],
    };

    const trends = computeSpendingTrends(data, "2026-04", "2026-04");
    expect(trends.total).toBe(25000);
    expect(trends.constituents[0]?.name).toBe("Savings, Investments");
    expect(trends.constituents[0]?.total).toBe(25000);

    const txs = getSpendingTransactions(data, "2026-04", "2026-04", { categoryId: 50 });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.payee).toBe("Transfer : Wealthsimple RRSP");
  });

  it("excludes CC-payment group transactions at top level ('all') but allows them when explicitly filtered", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
      ],
      groups: [
        { id: 1, name: "Everyday Expenses", sort: 0, isCreditCardPayments: false },
        { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 20, groupId: 2, name: "Visa Payment", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 10, date: "2026-04-05", payee: "Supermarket", memo: "", amount: "-15000", status: "c" },
        { id: 2, accountId: 1, categoryId: 20, date: "2026-04-10", payee: "Chase Visa", memo: "", amount: "-50000", status: "c" },
      ],
      recurring: [],
    };

    // Top-level chart total excludes CC-payments group
    const trends = computeSpendingTrends(data, "2026-04", "2026-04");
    expect(trends.total).toBe(15000);
    expect(trends.constituents).toHaveLength(1);
    expect(trends.constituents[0]?.name).toBe("Everyday Expenses");

    // Drilldown list at top-level ("all") with no filter or just month filter excludes CC-payments
    const allTxs = getSpendingTransactions(data, "2026-04", "2026-04");
    expect(allTxs).toHaveLength(1);
    expect(allTxs[0]?.id).toBe(1);

    const monthTxs = getSpendingTransactions(data, "2026-04", "2026-04", { month: "2026-04" });
    expect(monthTxs).toHaveLength(1);
    expect(monthTxs[0]?.id).toBe(1);

    // Summing drilldown transactions matches chart total
    const sumTxs = allTxs.reduce((sum, t) => sum + -Number(t.amount), 0);
    expect(sumTxs).toBe(trends.total);

    // Explicit group filter includes the CC payment group transactions
    const ccGroupTxs = getSpendingTransactions(data, "2026-04", "2026-04", { groupId: 2 });
    expect(ccGroupTxs).toHaveLength(1);
    expect(ccGroupTxs[0]?.id).toBe(2);

    // Explicit category filter includes the CC payment category transactions
    const ccCatTxs = getSpendingTransactions(data, "2026-04", "2026-04", { categoryId: 20 });
    expect(ccCatTxs).toHaveLength(1);
    expect(ccCatTxs[0]?.id).toBe(2);
  });
});
