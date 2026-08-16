import { describe, expect, it } from "vitest";
import { computeNetWorthReport, getMonthsBetween } from "../src/reports.js";
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
    expect(pts[0]?.assets).toBe(50160000);
    expect(pts[0]?.debts).toBe(-30000000);
    expect(pts[0]?.net).toBe(20160000);

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

  it("handles reversed start and end month parameters gracefully", () => {
    const data = makeBaseData();
    const pts = computeNetWorthReport(data, "2026-06", "2026-04");
    expect(pts).toHaveLength(3);
    expect(pts[0]?.month).toBe("2026-04");
    expect(pts[2]?.month).toBe("2026-06");
  });
});
