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
  buildBudgetIndex,
  getMonthsWithData,
  isIncomeTransaction,
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

  it("overspend in prior month is clamped to zero and deducted from TBB", () => {
    // Month A: assign 100, spend -300 → available -200 (overspent)
    // Month B: assign 500 → available = 0 + 500 = 500 (clamped to zero carryover)
    // TBB = income - assigned + priorSurplus
    //      = 0 - 500 + (-300 priorSurplus from June: -100 assigned - 200 overspent) = -800
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
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
    // Carryover is clamped to 0 (not -20000)
    expect(row.carryoverIn).toBe(0);
    // Available = 0 + 50000 = 50000
    expect(row.available).toBe(50000);
    // Overspent from previous month is 20000
    expect(result.overspentPrevious).toBe(20000);
    // TBB = 0 - 50000 + (-30000 priorSurplus from June: -10000 assigned - 20000 overspent) = -80000
    expect(result.tbb).toBe(-80000);
  });

  it("cash overspending reduces TBB but not available in next month", () => {
    // Month 1: income 5000, assign 1000 to groceries, spend 3000 → groceries available -2000
    // Month 2: income 0, assign 0 → groceries available 0 (clamped), TBB reduced by 2000
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "100000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-01", payee: "Payroll", memo: "", amount: "500000", status: "c", isIncome: true },
        { id: 2, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "Store", memo: "", amount: "-300000", status: "c" },
      ],
    };
    const june = computeBudget(data, "2025-06");
    // June: groceries available = 100000 - 300000 = -200000
    expect(june.groups[0]!.rows[0]!.available).toBe(-200000);
    expect(june.tbb).toBe(400000); // 500000 - 100000

    const july = computeBudget(data, "2025-07");
    // July: groceries carryover = 0 (clamped from -200000)
    expect(july.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    expect(july.groups[0]!.rows[0]!.available).toBe(0);
    // July: TBB = 0 - 0 + 200000 (priorSurplus from June: 500000 income - 100000 assigned - 200000 overspent) = 200000
    expect(july.overspentPrevious).toBe(200000);
    expect(july.tbb).toBe(200000);
  });

  it("multiple categories overspent in prior month are summed", () => {
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [
        makeCategory({ id: 1, name: "Cat1", carryover: "0" }),
        makeCategory({ id: 2, name: "Cat2", sort: 1, carryover: "0" }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "0" },
        { id: 2, categoryId: 2, month: "2025-06", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-10", payee: "", memo: "", amount: "-15000", status: "c" },
        { id: 2, accountId: 1, categoryId: 2, date: "2025-06-10", payee: "", memo: "", amount: "-25000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2025-07");
    // Both categories overspent, total = 15000 + 25000 = 40000
    expect(result.overspentPrevious).toBe(40000);
    expect(result.tbb).toBe(-40000);
  });

  it("overspent that is covered in the next month does not cascade", () => {
    // Month 1: overspend by 200
    // Month 2: assign 500 (covers the overspent), TBB reduced by 200
    // Month 3: TBB should not be reduced by the month 1 overspent again
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "0" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "50000" },
        { id: 3, categoryId: 1, month: "2025-08", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-20000", status: "c" },
      ],
    };

    const july = computeBudget(data, "2025-07");
    expect(july.overspentPrevious).toBe(20000);
    expect(july.tbb).toBe(-70000); // 0 - 50000 - 20000

    const august = computeBudget(data, "2025-08");
    // Month 3: July had no overspent (available = 0 + 50000 = 50000, positive)
    expect(august.overspentPrevious).toBe(0);
    // Total deficit of -70000 persists (-20000 June overspend + -50000 July assignment)
    expect(august.tbb).toBe(-70000);
  });

  it("overspentPrevious is 0 when the previous data-bearing month is not the immediate previous calendar month", () => {
    // June: assign 0, spend 200000 -> overspent 200000
    // July: no assignments, no transactions (empty)
    // August: no assignments, no transactions (empty)
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "Store", memo: "", amount: "-200000", status: "c" },
      ],
    };

    // June: current month overspent
    const june = computeBudget(data, "2025-06");
    expect(june.overspentPrevious).toBe(0);

    // July: June is the immediate preceding calendar month -> returns 200000
    const july = computeBudget(data, "2025-07");
    expect(july.overspentPrevious).toBe(200000);

    // August: June is NOT the immediate preceding calendar month (July is, and July had no overspend) -> returns 0
    const august = computeBudget(data, "2025-08");
    expect(august.overspentPrevious).toBe(0);

    // Cache hit path for August: still returns 0
    const augustCached = computeBudget(data, "2025-08");
    expect(augustCached.overspentPrevious).toBe(0);
  });

  it("overspentPrevious correctly handles year boundaries", () => {
    // Overspend in 2025-11 only
    const dataNov: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-11-10", payee: "Store", memo: "", amount: "-10000", status: "c" },
      ],
    };

    // 2025-12 has immediate previous month (2025-11) with overspend
    expect(computeBudget(dataNov, "2025-12").overspentPrevious).toBe(10000);
    // 2026-01 previous calendar month is 2025-12 (which had no data/overspend) -> 0
    expect(computeBudget(dataNov, "2026-01").overspentPrevious).toBe(0);

    // Overspend in 2025-12
    const dataDec: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-12-10", payee: "Store", memo: "", amount: "-15000", status: "c" },
      ],
    };

    // 2026-01 previous calendar month is 2025-12 -> 15000
    expect(computeBudget(dataDec, "2026-01").overspentPrevious).toBe(15000);
  });

  it("credit card overspending does NOT get clamped and does NOT affect TBB", () => {
    const data: BudgetData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "300000", onBudget: true, sort: 0 },
        { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "0", onBudget: true, sort: 1 },
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
        { id: 1, categoryId: 1, month: "2025-06", amount: "10000" },
        { id: 2, categoryId: 2, month: "2025-06", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-01", payee: "Payroll", memo: "", amount: "500000", status: "c", isIncome: true },
        { id: 2, accountId: 2, categoryId: 1, date: "2025-06-15", payee: "Store", memo: "", amount: "-50000", status: "c" },
      ],
      recurring: [],
    };

    const june = computeBudget(data, "2025-06");
    // Groceries: carryover 0 + assigned 10000 + outflow -50000 = -40000 (overspent on CC)
    const groc = june.groups.find((g) => !g.group.isCreditCardPayments)!.rows[0]!;
    expect(groc.available).toBe(-40000);
    // CC buffer still accumulates when spending on CC
    const ccRow = june.groups.find((g) => g.group.isCreditCardPayments)!.rows[0]!;
    expect(ccRow.ccBuffer).toBe(50000);

    const july = computeBudget(data, "2025-07");
    // Groceries carryover is clamped to 0 (cash overspending rule)
    const grocJuly = july.groups.find((g) => !g.group.isCreditCardPayments)!.rows[0]!;
    expect(grocJuly.carryoverIn).toBe(0);
    // CC payment category: overspending persists as debt (NOT clamped)
    // carryover = 0 + 0 + 0 + 50000 (buffer from June) = 50000, then in July: 0 + 0 + 0 + 0 = 50000
    const ccRowJuly = july.groups.find((g) => g.group.isCreditCardPayments)!.rows[0]!;
    expect(ccRowJuly.carryoverIn).toBe(50000);
    // Overspent from June: groceries was -40000, clamped to 0, overspent = 40000
    expect(july.overspentPrevious).toBe(40000);
    // June: income 500000 - assigned 10000 - overspent 40000 = 450000 priorSurplus
    // July: 0 income - 0 assigned + 450000 priorSurplus = 450000
    expect(july.priorSurplus).toBe(450000);
    expect(july.tbb).toBe(450000);
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

    it("CC payment recorded as inflow on CC account draws down the buffer identically (Issue 1.1)", () => {
      const data = ccData();
      // Payment of $150 recorded from Visa perspective: inflow +15000 from Checking
      data.transactions.push({
        id: 4,
        accountId: 2,
        categoryId: null,
        transferAccountId: 1,
        date: "2025-07-20",
        payee: "Transfer : Checking",
        memo: "Card payment",
        amount: "15000",
        status: "c",
      });
      const result = computeBudget(data, "2025-07");
      const ccRow = result.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      // Buffer = charges (20000) - payment (15000) = 5000
      expect(ccRow.ccBuffer).toBe(5000);
      expect(ccRow.available).toBe(10000); // 5000 assigned + 5000 buffer

      // Also verify via buildBudgetIndex
      data.budgetIndex = buildBudgetIndex(data);
      const indexedResult = computeBudget(data, "2025-07");
      const indexedCcRow = indexedResult.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      expect(indexedCcRow.ccBuffer).toBe(5000);
      expect(indexedCcRow.available).toBe(10000);
    });

    it("cash advance from CC to checking does not draw down CC buffer (Issue 1.1)", () => {
      // 1. Recorded as inflow in Checking from Visa: accountId=1, transferAccountId=2, amount=+10000
      const dataInflow = ccData();
      dataInflow.transactions.push({
        id: 4,
        accountId: 1,
        categoryId: null,
        transferAccountId: 2,
        date: "2025-07-20",
        payee: "Transfer : Visa",
        memo: "Cash advance",
        amount: "10000",
        status: "c",
      });
      const resultInflow = computeBudget(dataInflow, "2025-07");
      const ccRowInflow = resultInflow.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      expect(ccRowInflow.ccBuffer).toBe(20000);
      expect(ccRowInflow.available).toBe(25000);

      // 2. Recorded as outflow in Visa to Checking: accountId=2, transferAccountId=1, amount=-10000
      const dataOutflow = ccData();
      dataOutflow.transactions.push({
        id: 4,
        accountId: 2,
        categoryId: null,
        transferAccountId: 1,
        date: "2025-07-20",
        payee: "Transfer : Checking",
        memo: "Cash advance",
        amount: "-10000",
        status: "c",
      });
      const resultOutflow = computeBudget(dataOutflow, "2025-07");
      const ccRowOutflow = resultOutflow.groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.name === "Visa Payment")!;
      expect(ccRowOutflow.ccBuffer).toBe(20000);
      expect(ccRowOutflow.available).toBe(25000);
    });

    it("CC to CC balance transfer draws down receiving card buffer and leaves source card untouched (Issue 1.1)", () => {
      const data: BudgetData = {
        accounts: [
          { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "300000", onBudget: true, sort: 0 },
          { id: 2, name: "Visa 1", kind: "credit", groupLabel: "Credit Cards", balance: "-50000", onBudget: true, sort: 1 },
          { id: 3, name: "Visa 2", kind: "credit", groupLabel: "Credit Cards", balance: "-50000", onBudget: true, sort: 2 },
        ],
        groups: [
          { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
          { id: 2, name: "Credit Card Payments", sort: 1, isCreditCardPayments: true },
        ],
        categories: [
          { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
          { id: 2, groupId: 2, name: "Visa 1 Payment", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: 2 },
          { id: 3, groupId: 2, name: "Visa 2 Payment", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: 3 },
        ],
        assignments: [
          { id: 1, categoryId: 1, month: "2025-07", amount: "40000" },
        ],
        transactions: [
          { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "300000", status: "c", isIncome: true },
          // Spending on both cards
          { id: 2, accountId: 2, categoryId: 1, date: "2025-07-05", payee: "Store 1", memo: "", amount: "-10000", status: "c" },
          { id: 3, accountId: 3, categoryId: 1, date: "2025-07-05", payee: "Store 2", memo: "", amount: "-10000", status: "c" },
        ],
        recurring: [],
      };

      // Case A: recorded from Visa 1 perspective (outflow -5000 to Visa 2)
      const dataA: BudgetData = {
        ...data,
        transactions: [
          ...data.transactions,
          {
            id: 4,
            accountId: 2,
            categoryId: null,
            transferAccountId: 3,
            date: "2025-07-10",
            payee: "Transfer : Visa 2",
            memo: "Balance transfer",
            amount: "-5000",
            status: "c",
          },
        ],
      };

      const resultA = computeBudget(dataA, "2025-07");
      const v1RowA = resultA.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa 1 Payment")!;
      const v2RowA = resultA.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa 2 Payment")!;
      expect(v1RowA.ccBuffer).toBe(10000); // untouched
      expect(v2RowA.ccBuffer).toBe(5000);  // 10000 - 5000 = 5000

      // Case B: recorded from Visa 2 perspective (inflow +5000 from Visa 1)
      const dataB: BudgetData = {
        ...data,
        transactions: [
          ...data.transactions,
          {
            id: 4,
            accountId: 3,
            categoryId: null,
            transferAccountId: 2,
            date: "2025-07-10",
            payee: "Transfer : Visa 1",
            memo: "Balance transfer",
            amount: "5000",
            status: "c",
          },
        ],
      };

      const resultB = computeBudget(dataB, "2025-07");
      const v1RowB = resultB.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa 1 Payment")!;
      const v2RowB = resultB.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa 2 Payment")!;
      expect(v1RowB.ccBuffer).toBe(10000); // untouched
      expect(v2RowB.ccBuffer).toBe(5000);  // 10000 - 5000 = 5000
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

  it("UNI-01 / F-02: empty intervening month preserves cash overspend deduction and budget integrity invariant", () => {
    // June: income 5000, assign 1000, spend 3000 (overspend 2000)
    // July: empty
    // August: empty
    const data: BudgetData = {
      ...emptyData(),
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "200000", onBudget: true, sort: 0 },
      ],
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "100000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-01", payee: "Payroll", memo: "", amount: "500000", status: "c", isIncome: true },
        { id: 2, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "Store", memo: "", amount: "-300000", status: "c" },
      ],
    };

    const june = computeBudget(data, "2025-06");
    expect(june.tbb).toBe(400000); // 5000 - 1000

    const july = computeBudget(data, "2025-07");
    expect(july.priorSurplus).toBe(200000); // 4000 surplus - 2000 overspend
    expect(july.tbb).toBe(200000);

    const august = computeBudget(data, "2025-08");
    // In August, the $2000 cash overspent in June must NOT re-emerge as phantom TBB!
    expect(august.priorSurplus).toBe(200000);
    expect(august.tbb).toBe(200000);

    // Verify budget integrity invariant: onBudgetAccountBalance - categoryAvailable - tbb === 0
    const totalOnBudget = 200000;
    const totalCatAvailable = august.groups.reduce((s, g) => s + g.available, 0); // 0
    expect(totalOnBudget - totalCatAvailable - august.tbb).toBe(0);
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

  describe("transaction deletion impact on budget computations", () => {
    it("restores available category amounts when a split transaction is deleted", () => {
      const groups = [makeGroup({ id: 1, name: "Living" })];
      const cats = [
        makeCategory({ id: 10, groupId: 1, name: "Groceries" }),
        makeCategory({ id: 11, groupId: 1, name: "Household" }),
      ];
      const accounts = [
        { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "100000", onBudget: true, sort: 0 },
      ];
      const assignments = [
        { month: "2026-06", categoryId: 10, amount: "20000" }, // $200 budgeted to Groceries
        { month: "2026-06", categoryId: 11, amount: "10000" }, // $100 budgeted to Household
      ];

      // Split transaction: $150 parent (-$100 to Groceries, -$50 to Household)
      const splitParent = {
        id: 100,
        accountId: 1,
        categoryId: null,
        date: "2026-06-15",
        payee: "Costco Split",
        memo: "",
        amount: "-15000",
        status: "c" as const,
      };
      const splitChild1 = {
        id: 101,
        parentId: 100,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-15",
        payee: "Costco Split",
        memo: "",
        amount: "-10000",
        status: "c" as const,
      };
      const splitChild2 = {
        id: 102,
        parentId: 100,
        accountId: 1,
        categoryId: 11,
        date: "2026-06-15",
        payee: "Costco Split",
        memo: "",
        amount: "-5000",
        status: "c" as const,
      };

      const dataWithSplit: BudgetData = {
        accounts,
        groups,
        categories: cats,
        assignments,
        transactions: [splitParent, splitChild1, splitChild2],
        recurring: [],
      };

      const withSplit = computeBudget(dataWithSplit, "2026-06");
      const grocWith = withSplit.groups[0]?.rows.find((r) => r.category.id === 10);
      const houseWith = withSplit.groups[0]?.rows.find((r) => r.category.id === 11);
      expect(grocWith?.outflow).toBe(-10000);
      expect(grocWith?.available).toBe(10000); // $200 - $100 = $100
      expect(houseWith?.outflow).toBe(-5000);
      expect(houseWith?.available).toBe(5000); // $100 - $50 = $50

      // When the split parent and children are deleted:
      const dataAfterDelete: BudgetData = {
        ...dataWithSplit,
        transactions: [],
      };

      const afterDelete = computeBudget(dataAfterDelete, "2026-06");
      const grocAfter = afterDelete.groups[0]?.rows.find((r) => r.category.id === 10);
      const houseAfter = afterDelete.groups[0]?.rows.find((r) => r.category.id === 11);
      expect(grocAfter?.outflow).toBe(0);
      expect(grocAfter?.available).toBe(20000); // Full $200 restored
      expect(houseAfter?.outflow).toBe(0);
      expect(houseAfter?.available).toBe(10000); // Full $100 restored
    });

    it("on-budget transfer deletion does not affect category activity but reverses account activity", () => {
      const groups = [makeGroup({ id: 1, name: "Living" })];
      const cats = [makeCategory({ id: 10, groupId: 1, name: "Groceries" })];
      const accounts = [
        { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "50000", onBudget: true, sort: 0 },
        { id: 2, name: "Savings", kind: "liquid" as const, groupLabel: "Budget", balance: "50000", onBudget: true, sort: 1 },
      ];
      const assignments = [{ id: 1, month: "2026-06", categoryId: 10, amount: "10000" }];

      const transferTx = {
        id: 200,
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        date: "2026-06-15",
        payee: "Transfer : Savings",
        memo: "",
        amount: "-20000",
        status: "c" as const,
      };

      const withTransfer = computeBudget({ accounts, groups, categories: cats, assignments, transactions: [transferTx], recurring: [] }, "2026-06");
      const withoutTransfer = computeBudget({ accounts, groups, categories: cats, assignments, transactions: [], recurring: [] }, "2026-06");

      // On-budget transfers do not have categories, so category outflow is 0 in both
      expect(withTransfer.groups[0]?.rows[0]?.outflow).toBe(0);
      expect(withoutTransfer.groups[0]?.rows[0]?.outflow).toBe(0);
    });

    it("UNI-02 / F-01: deferred income targets next month TBB without affecting current month TBB", () => {
      const groups = [makeGroup({ id: 1, name: "Living" })];
      const cats = [makeCategory({ id: 10, groupId: 1, name: "Groceries" })];
      const accounts = [
        { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "500000", onBudget: true, sort: 0 },
      ];
      const deferredIncomeTx = {
        id: 1,
        accountId: 1,
        categoryId: null,
        date: "2025-06-25",
        payee: "Employer",
        memo: "End of month salary",
        amount: "500000",
        status: "c" as const,
        isIncome: true,
        incomeMonth: "2025-07",
      };

      const data: BudgetData = {
        accounts,
        groups,
        categories: cats,
        assignments: [],
        transactions: [deferredIncomeTx],
        recurring: [],
      };

      // In June (transaction date month): income is 0, TBB is 0
      const june = computeBudget(data, "2025-06");
      expect(june.totalIncome).toBe(0);
      expect(june.tbb).toBe(0);

      // In July (targeted income month): income is 500000, TBB is 500000
      const july = computeBudget(data, "2025-07");
      expect(july.totalIncome).toBe(500000);
      expect(july.tbb).toBe(500000);
    });

    it("UNI-20 / F-16: Red Arrow to the Right carries negative category balance into next month instead of deducting from TBB", () => {
      const groups = [makeGroup({ id: 1, name: "Living" })];
      const accounts = [
        { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "100000", onBudget: true, sort: 0 },
      ];

      // Case A: Default (overspendCarriesOver: false) -> Deducts from next month's TBB, category resets to 0
      const catDefault = makeCategory({ id: 10, groupId: 1, name: "Dining", overspendCarriesOver: false });
      const incomeTx = {
        id: 1,
        accountId: 1,
        categoryId: null,
        date: "2026-01-01",
        payee: "Income",
        memo: "",
        amount: "50000",
        status: "c" as const,
        isIncome: true,
      };
      const spendTx = {
        id: 2,
        accountId: 1,
        categoryId: 10,
        date: "2026-01-15",
        payee: "Restaurant",
        memo: "",
        amount: "-20000",
        status: "c" as const,
      };

      const dataDefault: BudgetData = {
        accounts,
        groups,
        categories: [catDefault],
        assignments: [{ id: 1, categoryId: 10, month: "2026-01", amount: "5000" }], // assigned $50, spent $200 -> -$150 overspent
        transactions: [incomeTx, spendTx],
        recurring: [],
      };

      const janDefault = computeBudget(dataDefault, "2026-01");
      expect(janDefault.groups[0]?.rows[0]?.available).toBe(-15000);

      const febDefault = computeBudget(dataDefault, "2026-02");
      // Available resets to 0 (clamped)
      expect(febDefault.groups[0]?.rows[0]?.available).toBe(0);
      // TBB is reduced by the $150 cash overspent from Jan
      expect(febDefault.tbb).toBe(45000 - 15000); // 30000

      // Case B: Red Arrow enabled (overspendCarriesOver: true) -> Category starts negative in Feb, NOT deducted from TBB
      const catRedArrow = makeCategory({ id: 10, groupId: 1, name: "Dining", overspendCarriesOver: true });
      const dataRedArrow: BudgetData = {
        ...dataDefault,
        categories: [catRedArrow],
      };

      const janRedArrow = computeBudget(dataRedArrow, "2026-01");
      expect(janRedArrow.groups[0]?.rows[0]?.available).toBe(-15000);

      const febRedArrow = computeBudget(dataRedArrow, "2026-02");
      // Available carries over negative (-$150)
      expect(febRedArrow.groups[0]?.rows[0]?.carryoverIn).toBe(-15000);
      expect(febRedArrow.groups[0]?.rows[0]?.available).toBe(-15000);
      // TBB is NOT deducted by $150
      expect(febRedArrow.tbb).toBe(45000);
    });
  });

  describe("buildBudgetIndex & pre-indexing", () => {
    it("produces identical computeBudget results with pre-indexed data", () => {
      const seed = makeSeedBudgetData();
      const rawBudget = computeBudget(seed, DEMO_MONTH);

      const budgetIndex = buildBudgetIndex(seed);
      const indexedData: BudgetData = {
        ...seed,
        budgetIndex,
      };

      const fastBudget = computeBudget(indexedData, DEMO_MONTH);
      expect(fastBudget).toEqual(rawBudget);
    });

    it("correctly pre-computes multi-month carryovers and TBB across history", () => {
      const seed = makeSeedBudgetData();
      const months = getMonthsWithData(seed);
      const budgetIndex = buildBudgetIndex(seed);
      const indexedData: BudgetData = {
        ...seed,
        budgetIndex,
      };

      for (const m of months) {
        const standard = computeBudget(seed, m);
        const fast = computeBudget(indexedData, m);
        expect(fast.tbb).toBe(standard.tbb);
        expect(fast.priorSurplus).toBe(standard.priorSurplus);
        expect(fast.overspentPrevious).toBe(standard.overspentPrevious);
        expect(fast.groups.length).toBe(standard.groups.length);
        for (let g = 0; g < standard.groups.length; g++) {
          expect(fast.groups[g]?.available).toBe(standard.groups[g]?.available);
          expect(fast.groups[g]?.outflow).toBe(standard.groups[g]?.outflow);
          expect(fast.groups[g]?.assigned).toBe(standard.groups[g]?.assigned);
        }
      }
    });
  });

  describe("off-budget account transactions", () => {
    it("ignores category on off-budget account transactions in outflow and budget calculations", () => {
      const onBudgetAccount = { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 };
      const offBudgetAccount = { id: 2, name: "Brokerage", kind: "offbudget" as const, groupLabel: "Off Budget", balance: "500000", onBudget: false, sort: 1 };
      const group = makeGroup({ id: 1, name: "Everyday" });
      const category = makeCategory({ id: 10, groupId: 1, name: "Groceries" });

      const incomeTx = {
        id: 1,
        accountId: onBudgetAccount.id,
        categoryId: null,
        date: "2026-07-01",
        payee: "Employer",
        memo: "Salary",
        amount: "100000", // $1,000 on-budget income
        status: "c" as const,
      };

      const offBudgetCategorizedSpend = {
        id: 2,
        accountId: offBudgetAccount.id,
        categoryId: category.id, // Groceries category tagged on off-budget brokerage
        date: "2026-07-05",
        payee: "Stock Buy",
        memo: "Investment",
        amount: "-25000", // -$250
        status: "c" as const,
      };

      const data: BudgetData = {
        accounts: [onBudgetAccount, offBudgetAccount],
        groups: [group],
        categories: [category],
        assignments: [
          { id: 1, categoryId: category.id, month: "2026-07", amount: "50000" }, // Assign $500 to Groceries
        ],
        transactions: [incomeTx, offBudgetCategorizedSpend],
        recurring: [],
      };

      const res = computeBudget(data, "2026-07");
      // Groceries available should be the full $500 assigned since off-budget -$250 is ignored
      const catRow = res.groups[0]?.rows[0];
      expect(catRow?.outflow).toBe(0);
      expect(catRow?.available).toBe(50000);
      // TBB = $1,000 income - $500 assigned = $500
      expect(res.tbb).toBe(50000);

      // Verify pre-indexed mode also ignores off-budget category outflows
      const index = buildBudgetIndex(data);
      expect(index.outflowByMonth["2026-07"]?.[category.id]).toBeUndefined();
      const indexedRes = computeBudget({ ...data, budgetIndex: index }, "2026-07");
      expect(indexedRes.groups[0]?.rows[0]?.outflow).toBe(0);
      expect(indexedRes.groups[0]?.rows[0]?.available).toBe(50000);
      expect(indexedRes.tbb).toBe(50000);
    });

    it("BUG 1.5: explicit isIncome: true with categoryId != null is not treated as income to avoid double counting", () => {
      const account = {
        id: 1,
        name: "Checking",
        kind: "liquid" as const,
        groupLabel: "Budget",
        balance: "5000",
        onBudget: true,
        sort: 0,
      };
      const group = makeGroup({ id: 1, name: "Everyday" });
      const category = makeCategory({ id: 7, groupId: 1, name: "Groceries" });

      // Transaction has both a category and explicit isIncome: true (e.g. malformed or forged payload)
      const categorizedInflow = {
        id: 1,
        accountId: 1,
        categoryId: 7,
        date: "2026-07-10",
        payee: "Store Refund",
        memo: "Refund",
        amount: "5000", // +$50 refund
        status: "c" as const,
        isIncome: true,
      };

      expect(isIncomeTransaction(categorizedInflow, [account])).toBe(false);

      const data: BudgetData = {
        accounts: [account],
        groups: [group],
        categories: [category],
        assignments: [],
        transactions: [categorizedInflow],
        recurring: [],
      };

      const res = computeBudget(data, "2026-07");
      // TBB should be 0 because it is a category refund, not general income
      expect(res.totalIncome).toBe(0);
      expect(res.tbb).toBe(0);
      // Groceries available should be +$50 (outflow display is clamped to 0 for positive refunds, available is +5000)
      const catRow = res.groups[0]?.rows[0];
      expect(catRow?.outflow).toBe(0);
      expect(catRow?.available).toBe(5000);

      // Verify pre-indexed mode also treats it as category outflow only
      const index = buildBudgetIndex(data);
      expect(index.incomeByMonth["2026-07"]).toBeUndefined();
      expect(index.outflowByMonth["2026-07"]?.[7]).toBe(5000);
      const indexedRes = computeBudget({ ...data, budgetIndex: index }, "2026-07");
      expect(indexedRes.totalIncome).toBe(0);
      expect(indexedRes.tbb).toBe(0);
      expect(indexedRes.groups[0]?.rows[0]?.available).toBe(5000);
    });

    it("BUG 1.5: isIncomeTransaction handles split children and transfer / off-budget guards properly", () => {
      const onBudgetAccount = { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "1000", onBudget: true, sort: 0 };
      const offBudgetAccount = { id: 2, name: "Brokerage", kind: "offbudget" as const, groupLabel: "Tracking", balance: "1000", onBudget: false, sort: 1 };
      const accountMap = [onBudgetAccount, offBudgetAccount];

      // Split child with categoryId == null and isIncome: true is valid income
      const splitChildIncome = {
        id: 2,
        parentId: 1,
        accountId: 1,
        categoryId: null,
        date: "2026-07-01",
        payee: "Paycheck",
        memo: "",
        amount: "5000",
        status: "c" as const,
        isIncome: true,
      };
      expect(isIncomeTransaction(splitChildIncome, accountMap)).toBe(true);

      // Split child with category is not income
      const splitChildCategorized = {
        ...splitChildIncome,
        categoryId: 7,
      };
      expect(isIncomeTransaction(splitChildCategorized, accountMap)).toBe(false);

      // Transfer between on-budget accounts is not income even if isIncome: true is set
      const onBudgetAccount2 = { id: 3, name: "Savings", kind: "liquid" as const, groupLabel: "Budget", balance: "1000", onBudget: true, sort: 1 };
      const accountMapWithSavings = [onBudgetAccount, offBudgetAccount, onBudgetAccount2];

      const internalTransferTx = {
        id: 3,
        accountId: 1,
        transferAccountId: 3,
        categoryId: null,
        date: "2026-07-01",
        payee: "Transfer",
        memo: "",
        amount: "5000",
        status: "c" as const,
        isIncome: true,
      };
      expect(isIncomeTransaction(internalTransferTx, accountMapWithSavings)).toBe(false);

      // Off-budget transaction is not income even if isIncome: true is set
      const offBudgetTx = {
        id: 4,
        accountId: 2,
        categoryId: null,
        date: "2026-07-01",
        payee: "Dividend",
        memo: "",
        amount: "5000",
        status: "c" as const,
        isIncome: true,
      };
      expect(isIncomeTransaction(offBudgetTx, accountMap)).toBe(false);
    });

    describe("BUG 1.6: transfers across budget boundary into/out of TBB", () => {
      const onBudgetAccount = { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Budget", balance: "1000000", onBudget: true, sort: 0 };
      const offBudgetAccount = { id: 2, name: "Brokerage", kind: "offbudget" as const, groupLabel: "Tracking", balance: "5000000", onBudget: false, sort: 1 };
      const group = makeGroup({ id: 1, name: "Everyday" });
      const category = makeCategory({ id: 10, groupId: 1, name: "Investments" });

      it("treats transfer from off-budget to on-budget (uncategorized) as income to TBB (recorded on checking)", () => {
        const transferInflow = {
          id: 1,
          accountId: onBudgetAccount.id,
          transferAccountId: offBudgetAccount.id,
          categoryId: null,
          date: "2026-07-01",
          payee: "Transfer : Brokerage",
          memo: "Withdrawal from brokerage",
          amount: "1000000", // +$10,000 inflow to Checking
          status: "c" as const,
        };

        expect(isIncomeTransaction(transferInflow, [onBudgetAccount, offBudgetAccount])).toBe(true);

        const data: BudgetData = {
          accounts: [onBudgetAccount, offBudgetAccount],
          groups: [group],
          categories: [category],
          assignments: [],
          transactions: [transferInflow],
          recurring: [],
        };

        const res = computeBudget(data, "2026-07");
        expect(res.totalIncome).toBe(1000000);
        expect(res.tbb).toBe(1000000);

        // Budget integrity invariant check
        const totalOnBudget = 1000000;
        const totalCatAvailable = res.groups.reduce((s, g) => s + g.available, 0);
        expect(totalOnBudget - totalCatAvailable - res.tbb).toBe(0);

        // Pre-indexed verification
        const index = buildBudgetIndex(data);
        expect(index.incomeByMonth["2026-07"]).toBe(1000000);
        const indexedRes = computeBudget({ ...data, budgetIndex: index }, "2026-07");
        expect(indexedRes.totalIncome).toBe(1000000);
        expect(indexedRes.tbb).toBe(1000000);
      });

      it("treats transfer from off-budget to on-budget (uncategorized) as income to TBB (recorded on brokerage)", () => {
        const transferInflowFromBrokerage = {
          id: 1,
          accountId: offBudgetAccount.id,
          transferAccountId: onBudgetAccount.id,
          categoryId: null,
          date: "2026-07-01",
          payee: "Transfer : Checking",
          memo: "Transfer to checking",
          amount: "-1000000", // -$10,000 on Brokerage -> +$10,000 on Checking
          status: "c" as const,
        };

        expect(isIncomeTransaction(transferInflowFromBrokerage, [onBudgetAccount, offBudgetAccount])).toBe(true);

        const data: BudgetData = {
          accounts: [onBudgetAccount, offBudgetAccount],
          groups: [group],
          categories: [category],
          assignments: [],
          transactions: [transferInflowFromBrokerage],
          recurring: [],
        };

        const res = computeBudget(data, "2026-07");
        expect(res.totalIncome).toBe(1000000);
        expect(res.tbb).toBe(1000000);

        // Budget integrity invariant check
        const totalOnBudget = 1000000;
        const totalCatAvailable = res.groups.reduce((s, g) => s + g.available, 0);
        expect(totalOnBudget - totalCatAvailable - res.tbb).toBe(0);

        // Pre-indexed verification
        const index = buildBudgetIndex(data);
        expect(index.incomeByMonth["2026-07"]).toBe(1000000);
        const indexedRes = computeBudget({ ...data, budgetIndex: index }, "2026-07");
        expect(indexedRes.totalIncome).toBe(1000000);
        expect(indexedRes.tbb).toBe(1000000);
      });

      it("categorized transfer from off-budget to on-budget increases category available and not TBB", () => {
        const categorizedTransferInflow = {
          id: 1,
          accountId: onBudgetAccount.id,
          transferAccountId: offBudgetAccount.id,
          categoryId: category.id,
          date: "2026-07-01",
          payee: "Transfer : Brokerage",
          memo: "Direct category refund/inflow",
          amount: "1000000", // +$10,000
          status: "c" as const,
        };

        expect(isIncomeTransaction(categorizedTransferInflow, [onBudgetAccount, offBudgetAccount])).toBe(false);

        const data: BudgetData = {
          accounts: [onBudgetAccount, offBudgetAccount],
          groups: [group],
          categories: [category],
          assignments: [],
          transactions: [categorizedTransferInflow],
          recurring: [],
        };

        const res = computeBudget(data, "2026-07");
        expect(res.totalIncome).toBe(0);
        expect(res.tbb).toBe(0);
        expect(res.groups[0]?.rows[0]?.available).toBe(1000000);

        // Budget integrity invariant check
        const totalOnBudget = 1000000;
        const totalCatAvailable = res.groups.reduce((s, g) => s + g.available, 0);
        expect(totalOnBudget - totalCatAvailable - res.tbb).toBe(0);
      });

      it("categorized transfer from on-budget to off-budget decreases category available and preserves integrity", () => {
        const categorizedTransferOutflow = {
          id: 1,
          accountId: onBudgetAccount.id,
          transferAccountId: offBudgetAccount.id,
          categoryId: category.id,
          date: "2026-07-01",
          payee: "Transfer : Brokerage",
          memo: "Fund brokerage",
          amount: "-500000", // -$5,000 from Checking
          status: "c" as const,
        };

        expect(isIncomeTransaction(categorizedTransferOutflow, [onBudgetAccount, offBudgetAccount])).toBe(false);

        const data: BudgetData = {
          accounts: [onBudgetAccount, offBudgetAccount],
          groups: [group],
          categories: [category],
          assignments: [
            { id: 1, categoryId: category.id, month: "2026-07", amount: "500000" }, // Budget $5,000
          ],
          transactions: [
            { id: 10, accountId: onBudgetAccount.id, categoryId: null, date: "2026-07-01", payee: "Salary", memo: "", amount: "500000", status: "c" as const, isIncome: true },
            categorizedTransferOutflow,
          ],
          recurring: [],
        };

        const res = computeBudget(data, "2026-07");
        expect(res.totalIncome).toBe(500000);
        expect(res.tbb).toBe(0);
        expect(res.groups[0]?.rows[0]?.assigned).toBe(500000);
        expect(res.groups[0]?.rows[0]?.outflow).toBe(-500000);
        expect(res.groups[0]?.rows[0]?.available).toBe(0);

        // Budget integrity invariant check: Checking has $5,000 ($5,000 salary - $5,000 transfer)
        const totalOnBudget = 0; // Net 0 cash on Checking (5000 - 5000)
        const totalCatAvailable = res.groups.reduce((s, g) => s + g.available, 0); // 0
        expect(totalOnBudget - totalCatAvailable - res.tbb).toBe(0);
      });

      it("treats inbound boundary transfer with explicit isIncome: false as income to preserve budget identity", () => {
        const transferInflowWithFalse = {
          id: 1,
          accountId: onBudgetAccount.id,
          transferAccountId: offBudgetAccount.id,
          categoryId: null,
          date: "2026-07-01",
          payee: "Transfer : Brokerage",
          memo: "Withdrawal from brokerage",
          amount: "1000000", // +$10,000 inflow to Checking
          status: "c" as const,
          isIncome: false, // explicitly false should not exclude uncategorized boundary inflow
        };

        expect(isIncomeTransaction(transferInflowWithFalse, [onBudgetAccount, offBudgetAccount])).toBe(true);

        const data: BudgetData = {
          accounts: [onBudgetAccount, offBudgetAccount],
          groups: [group],
          categories: [category],
          assignments: [],
          transactions: [transferInflowWithFalse],
          recurring: [],
        };

        const res = computeBudget(data, "2026-07");
        expect(res.totalIncome).toBe(1000000);
        expect(res.tbb).toBe(1000000);

        // Budget integrity invariant: On-budget cash (1000000) = totalCatAvailable (0) + TBB (1000000)
        const totalOnBudget = 1000000;
        const totalCatAvailable = res.groups.reduce((s, g) => s + g.available, 0);
        expect(totalOnBudget - totalCatAvailable - res.tbb).toBe(0);

        const index = buildBudgetIndex(data);
        expect(index.incomeByMonth["2026-07"]).toBe(1000000);
        const indexedRes = computeBudget({ ...data, budgetIndex: index }, "2026-07");
        expect(indexedRes.totalIncome).toBe(1000000);
        expect(indexedRes.tbb).toBe(1000000);
      });
    });
  });
});


