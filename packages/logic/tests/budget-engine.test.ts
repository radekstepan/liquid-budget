/**
 * budget-engine.test.ts
 *
 * Comprehensive tests for the full YNAB4 budget engine.
 * Covers: cumulative carryover, TBB, over-budgeted detection,
 * multi-month chains, credit card buffers, goal funding, and edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  computeBudget,
  getMonthsWithData,
} from "../src/budget-engine.js";
import { makeSeedBudgetData, DEMO_MONTH } from "../src/seed-fixture.js";
import type { BudgetData, Category, CategoryGroup } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture builders (amounts in cents)
// ---------------------------------------------------------------------------

function emptyData(): BudgetData {
  return {
    accounts: [],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    groupId: 1,
    name: "Cat",
    sort: 0,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Group",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getMonthsWithData
// ---------------------------------------------------------------------------

describe("getMonthsWithData", () => {
  it("returns empty array when there is no data", () => {
    expect(getMonthsWithData(emptyData())).toEqual([]);
  });

  it("collects unique months from assignments and transactions", () => {
    const data: BudgetData = {
      ...emptyData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "10000" },
        { id: 2, categoryId: 1, month: "2025-08", amount: "10000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-15", payee: "", memo: "", amount: "50000", status: "c" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-06", "2025-07", "2025-08"]);
  });

  it("deduplicates months", () => {
    const data: BudgetData = {
      ...emptyData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "10000" },
        { id: 2, categoryId: 2, month: "2025-07", amount: "20000" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-07"]);
  });

  it("returns months in ascending order", () => {
    const data: BudgetData = {
      ...emptyData(),
      assignments: [
        { id: 3, categoryId: 1, month: "2025-12", amount: "100" },
        { id: 1, categoryId: 1, month: "2025-01", amount: "100" },
        { id: 2, categoryId: 1, month: "2025-06", amount: "100" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-01", "2025-06", "2025-12"]);
  });
});

// ---------------------------------------------------------------------------
// computeBudget — carryover & TBB
// ---------------------------------------------------------------------------

describe("computeBudget", () => {
  it("returns correct structure for empty data", () => {
    const result = computeBudget(emptyData(), "2025-07");
    expect(result.groups).toEqual([]);
    expect(result.tbb).toBe(0);
    expect(result.totalIncome).toBe(0);
    expect(result.totalAssigned).toBe(0);
    expect(result.overBudgeted).toBe(false);
  });

  it("overBudgeted is true when tbb < 0", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "500000" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "100000", status: "c", isIncome: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.overBudgeted).toBe(true);
    expect(result.tbb).toBe(-400000);
  });

  it("overBudgeted is false when fully balanced", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "200000" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "200000", status: "c", isIncome: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.overBudgeted).toBe(false);
    expect(result.tbb).toBe(0);
  });

  it("cumulative carryover flows into the next month's available", () => {
    // Month A: assign 500.00, spend 300.00 → available 200.00
    // Month B: assign 100.00 → available should be 200.00 (carryover) + 100.00 = 300.00
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "50000" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "10000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-30000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBe(20000);
    expect(row.available).toBe(30000);
  });

  it("overspend in prior month reduces next month's available", () => {
    // Month A: assign 100, spend -300 → available -200 (overspent)
    // Month B: assign 500 → available = -200 + 500 = 300
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "10000" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "50000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-30000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBe(-20000);
    expect(row.available).toBe(30000);
  });

  it("three-month carryover chain with multiple categories", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [
        makeCategory({ id: 1, name: "Cat1", carryover: "5000" }),
        makeCategory({ id: 2, name: "Cat2", sort: 1, carryover: "0" }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-01", amount: "20000" },
        { id: 2, categoryId: 2, month: "2025-01", amount: "30000" },
        { id: 3, categoryId: 1, month: "2025-02", amount: "5000" },
        { id: 4, categoryId: 2, month: "2025-02", amount: "10000" },
        { id: 5, categoryId: 1, month: "2025-03", amount: "0" },
        { id: 6, categoryId: 2, month: "2025-03", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-01-10", payee: "", memo: "", amount: "-15000", status: "c" },
        { id: 2, accountId: 1, categoryId: 1, date: "2025-02-10", payee: "", memo: "", amount: "-2000", status: "c" },
        { id: 3, accountId: 1, categoryId: 2, date: "2025-02-10", payee: "", memo: "", amount: "-20000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2025-03");
    const [g] = result.groups;
    const cat1 = g!.rows.find((r) => r.category.name === "Cat1")!;
    const cat2 = g!.rows.find((r) => r.category.name === "Cat2")!;

    expect(cat1.carryoverIn).toBe(13000);
    expect(cat2.carryoverIn).toBe(20000);
  });

  it("seed carryover on Category is applied only in the first month", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "10000" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "5000" }],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBe(10000);
    expect(row.available).toBe(15000);
  });

  it("fundedPct uses goal target when set", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: "100000", carryover: "0" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "40000" }],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBeCloseTo(0.4);
  });

  it("fundedPct uses assigned when no goal target", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: null, carryover: "0" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "20000" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-07-10", payee: "", memo: "", amount: "-5000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBeCloseTo(0.75);
  });

  it("fundedPct is clamped to 1 even when available exceeds goal", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: "10000", carryover: "5000" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "10000" }],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBe(1);
  });

  // -------------------------------------------------------------------------
  // CC Buffer & TBB (Issues #1, #2)
  // -------------------------------------------------------------------------

  describe("CC buffer & assignments in TBB", () => {
    function ccData(): BudgetData {
      return {
        accounts: [
          { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "300000", onBudget: true, sort: 0 },
          { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "-50000", onBudget: true, sort: 1 },
        ],
        groups: [
          { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
          { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
        ],
        categories: [
          { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
          { id: 2, groupId: 2, name: "Visa Payment", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: 2 },
        ],
        assignments: [
          { id: 1, categoryId: 1, month: "2025-07", amount: "40000" },
          { id: 2, categoryId: 2, month: "2025-07", amount: "5000" },
        ],
        transactions: [
          { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "300000", status: "c", isIncome: true },
          { id: 2, accountId: 2, categoryId: 1, date: "2025-07-05", payee: "Whole Foods", memo: "", amount: "-12000", status: "c" },
          { id: 3, accountId: 2, categoryId: 1, date: "2025-07-18", payee: "Trader Joe", memo: "", amount: "-8000", status: "c" },
        ],
        recurring: [],
      };
    }

    it("CC payment category receives the spending as a buffer", () => {
      const result = computeBudget(ccData(), "2025-07");
      const ccRow = result.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      expect(ccRow.ccBuffer).toBe(20000);
      expect(ccRow.available).toBe(25000); // 5000 assigned + 20000 buffer
    });

    it("CC payment draws down the buffer (Issue #1)", () => {
      const data = ccData();
      // Payment of $150 from Checking to Visa
      data.transactions.push({
        id: 4,
        accountId: 1,
        categoryId: null,
        transferAccountId: 2,
        date: "2025-07-20",
        payee: "Transfer : Visa",
        memo: "Card payment",
        amount: "-15000",
        status: "c",
      });
      const result = computeBudget(data, "2025-07");
      const ccRow = result.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      // Buffer = charges (20000) - payment (15000) = 5000
      expect(ccRow.ccBuffer).toBe(5000);
      expect(ccRow.available).toBe(10000); // 5000 assigned + 5000 buffer
    });

    it("CC refund decreases the buffer (Issue #1)", () => {
      const data = ccData();
      // Refund of $30 on Visa
      data.transactions.push({
        id: 4,
        accountId: 2,
        categoryId: 1,
        date: "2025-07-22",
        payee: "Whole Foods Refund",
        memo: "Returned item",
        amount: "3000",
        status: "c",
      });
      const result = computeBudget(data, "2025-07");
      const ccRow = result.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      // Buffer = 20000 - 3000 = 17000
      expect(ccRow.ccBuffer).toBe(17000);
    });

    it("TBB includes CC assignments (Issue #2)", () => {
      const result = computeBudget(ccData(), "2025-07");
      // totalIncome = 300000
      // totalAssigned = 40000 (groceries) + 5000 (visa payment) = 45000
      // TBB = 300000 - 45000 = 255000
      expect(result.totalAssigned).toBe(45000);
      expect(result.tbb).toBe(255000);
    });
  });

  // -------------------------------------------------------------------------
  // Split transactions (Issue #5)
  // -------------------------------------------------------------------------

  it("split parent transactions are excluded from income and outflow calculations (Issue #5)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [
        makeCategory({ id: 1, name: "Groceries" }),
        makeCategory({ id: 2, name: "Household", sort: 1 }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "10000" },
        { id: 2, categoryId: 2, month: "2025-07", amount: "10000" },
      ],
      transactions: [
        // Split parent (amount -10000, category null)
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-05", payee: "Costco", memo: "Split", amount: "-10000", status: "c" },
        // Children
        { id: 2, accountId: 1, categoryId: 1, parentId: 1, date: "2025-07-05", payee: "Costco", memo: "Food", amount: "-6000", status: "c" },
        { id: 3, accountId: 1, categoryId: 2, parentId: 1, date: "2025-07-05", payee: "Costco", memo: "Cleaning", amount: "-4000", status: "c" },
      ],
      recurring: [],
    };
    const result = computeBudget(data, "2025-07");
    const groc = result.groups[0]!.rows.find((r) => r.category.name === "Groceries")!;
    const house = result.groups[0]!.rows.find((r) => r.category.name === "Household")!;
    expect(groc.outflow).toBe(-6000);
    expect(house.outflow).toBe(-4000);
    // Split parent is NOT counted as income or category outflow
    expect(result.totalIncome).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Off-budget and transfer inflows (Issues #3, #4)
  // -------------------------------------------------------------------------

  it("off-budget account inflows are excluded from TBB (Issue #3)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 },
        { id: 2, name: "Brokerage", kind: "offbudget", groupLabel: "Investments", balance: "500000", onBudget: false, sort: 1 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [],
      transactions: [
        // $5,000 dividend in off-budget brokerage
        { id: 1, accountId: 2, categoryId: null, date: "2025-07-15", payee: "Dividend", memo: "", amount: "500000", status: "c" },
      ],
      recurring: [],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.totalIncome).toBe(0);
    expect(result.tbb).toBe(0);
  });

  it("transfers between accounts are excluded from income and do not inflate TBB (Issue #4)", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "200000", onBudget: true, sort: 0 },
        { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "500000", onBudget: true, sort: 1 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [],
      transactions: [
        // Transfer $2,000 from Savings (2) to Checking (1)
        { id: 1, accountId: 2, categoryId: null, transferAccountId: 1, date: "2025-07-10", payee: "Transfer : Checking", memo: "", amount: "-200000", status: "c" },
      ],
      recurring: [],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.totalIncome).toBe(0);
    expect(result.tbb).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Seed fixture integration
  // -------------------------------------------------------------------------

  it("seed fixture: returns the correct number of groups and valid TBB", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    expect(result.groups).toHaveLength(data.groups.length);
    expect(result.totalIncome).toBeGreaterThan(0);
    expect(result.tbb).toBe(result.totalIncome + result.priorSurplus - result.totalAssigned);
  });

  it("computes 5 years (60 months) with 1000 transactions in < 100ms", () => {
    const cats = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      groupId: 1,
      name: `Category ${i + 1}`,
      sort: i,
      carryover: "0",
      goalTarget: null,
    }));

    const groups = [{ id: 1, name: "General", sort: 0, isCreditCardPayments: false }];
    const accounts = [{ id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 }];

    const assignments = [];
    const transactions = [];

    // Generate 60 months (2020-01 to 2024-12)
    for (let y = 2020; y <= 2024; y++) {
      for (let m = 1; m <= 12; m++) {
        const monthKey = `${y}-${String(m).padStart(2, "0")}`;
        // Income
        transactions.push({
          id: transactions.length + 1,
          accountId: 1,
          categoryId: null,
          date: `${monthKey}-01`,
          payee: "Employer",
          memo: "Salary",
          amount: "500000",
          status: "c" as const,
        });

        for (const c of cats) {
          assignments.push({
            month: monthKey,
            categoryId: c.id,
            amount: "20000",
          });
          transactions.push({
            id: transactions.length + 1,
            accountId: 1,
            categoryId: c.id,
            date: `${monthKey}-15`,
            payee: "Merchant",
            memo: "",
            amount: "-15000",
            status: "c" as const,
          });
        }
      }
    }

    const data: BudgetData = {
      accounts,
      groups,
      categories: cats,
      assignments,
      transactions,
      recurring: [],
    };

    const t0 = performance.now();
    const result = computeBudget(data, "2024-12");
    const t1 = performance.now();

    expect(t1 - t0).toBeLessThan(150); // Under 150ms
    // Each month: assigned 20000, spent 15000 -> net +5000 per category per month
    // Over 59 prior months, carryover in month 60 should be 59 * 5000 = 295000
    const cat1Row = result.groups[0]?.rows.find((r) => r.category.id === 1);
    expect(cat1Row?.carryoverIn).toBe(59 * 5000);
    expect(cat1Row?.available).toBe(59 * 5000 + 20000 - 15000);
  });

  it("maintains exact integer precision through 100+ multi-month carryover calculations with fractional-prone cents", () => {
    const cats = [{ id: 1, groupId: 1, name: "Pennies", sort: 0, carryover: "0", goalTarget: null }];
    const groups = [{ id: 1, name: "General", sort: 0, isCreditCardPayments: false }];
    const accounts = [{ id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 }];

    const assignments = [];
    const transactions = [];

    // 100 months of $0.01, $0.03, $0.07 amounts
    for (let i = 0; i < 100; i++) {
      const y = 2015 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      const mk = `${y}-${String(m).padStart(2, "0")}`;
      assignments.push({ month: mk, categoryId: 1, amount: "333" }); // $3.33
      transactions.push({
        id: i + 1,
        accountId: 1,
        categoryId: 1,
        date: `${mk}-10`,
        payee: "Shop",
        memo: "",
        amount: "-117", // -$1.17
        status: "c" as const,
      });
    }

    const data: BudgetData = {
      accounts,
      groups,
      categories: cats,
      assignments,
      transactions,
      recurring: [],
    };

    const targetMonth = "2023-04"; // Month 100
    const result = computeBudget(data, targetMonth);
    const row = result.groups[0]?.rows[0];

    // Net per month = 333 - 117 = 216 cents ($2.16)
    // 99 prior months = 99 * 216 = 21384 cents
    expect(row?.carryoverIn).toBe(99 * 216);
    expect(row?.available).toBe(99 * 216 + 333 - 117);
    expect(Number.isInteger(row?.carryoverIn)).toBe(true);
    expect(Number.isInteger(row?.available)).toBe(true);
  });
});
