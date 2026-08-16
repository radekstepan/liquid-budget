import { describe, expect, it } from "vitest";
import { computeNetWorthReport, getMonthsBetween } from "../src/reports.js";
import type { BudgetData, Transaction } from "../src/types.js";

function makeBaseData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "1000.00", onBudget: true, sort: 0 },
      { id: 2, name: "Credit Card", kind: "credit", groupLabel: "Credit Cards", balance: "-200.00", onBudget: true, sort: 1 },
      { id: 3, name: "Home Value", kind: "offbudget", groupLabel: "Property", balance: "500000.00", onBudget: false, sort: 2 },
      { id: 4, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-300000.00", onBudget: false, sort: 3 },
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
      // Assets = Chequing (1000) + Home Value (500000) = 501000
      expect(p.assets).toBe(501000);
      // Debts = Credit Card (-200) + Mortgage (-300000) = -300200
      expect(p.debts).toBe(-300200);
      // Net = 501000 - 300200 = 200800
      expect(p.net).toBe(200800);
    }
  });

  it("properly advances balances month by month with regular transactions", () => {
    const data = makeBaseData();
    // Current balances: Chequing = 1000, Credit Card = -200
    // Transactions:
    // April: Chequing income +3000, Chequing expense -1000 (net +2000)
    // May: Credit Card charge -300
    // June: Chequing expense -500, Credit Card payment/transfer +100
    //
    // Total deltas across all transactions:
    // Chequing: +3000 - 1000 - 500 = +1500 => Initial balance = 1000 - 1500 = -500
    // Credit Card: -300 => Initial balance = -200 - (-300) = +100
    //
    // At end of April:
    // Chequing = -500 + 2000 = 1500
    // Credit Card = 100
    // Assets = 1500 + 100 + 500000 = 501600
    // Debts = -300000
    // Net = 201600
    //
    // At end of May:
    // Credit Card = 100 - 300 = -200
    // Chequing = 1500
    // Assets = 1500 + 500000 = 501500
    // Debts = -200 - 300000 = -300200
    // Net = 201300
    //
    // At end of June (final month):
    // Chequing = 1500 - 500 = 1000 (matches current balance!)
    // Credit Card = -200 (matches current balance!)
    // Assets = 1000 + 500000 = 501000
    // Debts = -200 - 300000 = -300200
    // Net = 200800
    data.transactions = [
      { id: 1, accountId: 1, categoryId: null, date: "2026-04-01", payee: "Salary", memo: "", amount: "3000.00", status: "c" },
      { id: 2, accountId: 1, categoryId: 10, date: "2026-04-10", payee: "Rent", memo: "", amount: "-1000.00", status: "c" },
      { id: 3, accountId: 2, categoryId: 11, date: "2026-05-05", payee: "Target", memo: "", amount: "-300.00", status: "c" },
      { id: 4, accountId: 1, categoryId: 12, date: "2026-06-02", payee: "Dining", memo: "", amount: "-500.00", status: "c" },
    ];

    const pts = computeNetWorthReport(data, "2026-04", "2026-06");
    expect(pts).toHaveLength(3);

    expect(pts[0]?.month).toBe("2026-04");
    expect(pts[0]?.assets).toBe(501600);
    expect(pts[0]?.debts).toBe(-300000);
    expect(pts[0]?.net).toBe(201600);

    expect(pts[1]?.month).toBe("2026-05");
    expect(pts[1]?.assets).toBe(501500);
    expect(pts[1]?.debts).toBe(-300200);
    expect(pts[1]?.net).toBe(201300);

    expect(pts[2]?.month).toBe("2026-06");
    expect(pts[2]?.assets).toBe(501000);
    expect(pts[2]?.debts).toBe(-300200);
    expect(pts[2]?.net).toBe(200800);
  });

  it("handles inter-account transfers without losing money", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "4000.00", onBudget: true, sort: 0 },
        { id: 2, name: "Credit Card", kind: "credit", groupLabel: "Credit Cards", balance: "0.00", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // Jan: Salary +5000 into Chequing
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Salary", memo: "", amount: "5000.00", status: "c" },
        // Feb: CC Charge -1000 on Credit Card
        { id: 2, accountId: 2, categoryId: 10, date: "2026-02-05", payee: "Store", memo: "", amount: "-1000.00", status: "c" },
        // Mar: Transfer from Chequing to Credit Card to pay the bill (-1000 from Chequing -> +1000 to Credit Card)
        { id: 3, accountId: 1, transferAccountId: 2, categoryId: null, date: "2026-03-01", payee: "Transfer : Credit Card", memo: "", amount: "-1000.00", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-03");
    expect(pts).toHaveLength(3);

    // Jan: Chequing = 5000, CC = 0 => Assets 5000, Debts 0, Net 5000
    expect(pts[0]).toEqual({ month: "2026-01", assets: 5000, debts: 0, net: 5000 });
    // Feb: Chequing = 5000, CC = -1000 => Assets 5000, Debts -1000, Net 4000
    expect(pts[1]).toEqual({ month: "2026-02", assets: 5000, debts: -1000, net: 4000 });
    // Mar: Chequing = 4000, CC = 0 => Assets 4000, Debts 0, Net 4000
    expect(pts[2]).toEqual({ month: "2026-03", assets: 4000, debts: 0, net: 4000 });
  });

  it("skips split parent transactions to avoid double-counting", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "900.00", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        // Starting balance: +1000 in Jan
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "1000.00", status: "c" },
        // Feb split transaction: parent row (-100) + two children (-60, -40)
        { id: 10, accountId: 1, categoryId: null, date: "2026-02-10", payee: "Costco", memo: "Split parent", amount: "-100.00", status: "c" },
        { id: 11, accountId: 1, parentId: 10, categoryId: 1, date: "2026-02-10", payee: "Costco", memo: "Groceries", amount: "-60.00", status: "c" },
        { id: 12, accountId: 1, parentId: 10, categoryId: 2, date: "2026-02-10", payee: "Costco", memo: "Household", amount: "-40.00", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-02");
    expect(pts).toHaveLength(2);

    expect(pts[0]?.net).toBe(1000);
    // If split parent was counted, net would be 800 instead of 900
    expect(pts[1]?.net).toBe(900);
  });

  it("handles split transactions with sub-transfer accounts correctly", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: "900.00", onBudget: true, sort: 0 },
        { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget Accounts", balance: "40.00", onBudget: true, sort: 1 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-01", payee: "Starting", memo: "", amount: "1000.00", status: "c" },
        // Split with sub-transfer: $100 outflow from Chequing = $60 Groceries + $40 Transfer to Savings
        { id: 10, accountId: 1, categoryId: null, date: "2026-02-10", payee: "Multiple", memo: "", amount: "-100.00", status: "c" },
        { id: 11, accountId: 1, parentId: 10, categoryId: 1, date: "2026-02-10", payee: "Costco", memo: "", amount: "-60.00", status: "c" },
        { id: 12, accountId: 1, parentId: 10, transferAccountId: 2, categoryId: null, date: "2026-02-10", payee: "Transfer : Savings", memo: "", amount: "-40.00", status: "c" },
      ],
      recurring: [],
    };

    const pts = computeNetWorthReport(data, "2026-01", "2026-02");
    expect(pts).toHaveLength(2);

    expect(pts[0]?.net).toBe(1000); // Chequing 1000, Savings 0
    expect(pts[1]?.net).toBe(940);  // Chequing 900 + Savings 40 = 940 (only the $60 grocery expense was lost)
  });

  it("handles reversed start and end month parameters gracefully", () => {
    const data = makeBaseData();
    const pts = computeNetWorthReport(data, "2026-06", "2026-04");
    expect(pts).toHaveLength(3);
    expect(pts[0]?.month).toBe("2026-04");
    expect(pts[2]?.month).toBe("2026-06");
  });
});
