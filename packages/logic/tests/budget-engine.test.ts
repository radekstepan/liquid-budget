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
  computeTBB,
  computeCarryover,
  getMonthsWithData,
} from "../src/budget-engine.js";
import { makeSeedBudgetData, DEMO_MONTH } from "../src/seed-fixture.js";
import type { BudgetData, Category, CategoryGroup } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture builders
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
        { id: 1, categoryId: 1, month: "2025-07", amount: "100" },
        { id: 2, categoryId: 1, month: "2025-08", amount: "100" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-15", payee: "", memo: "", amount: "500", cleared: true },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-06", "2025-07", "2025-08"]);
  });

  it("deduplicates months", () => {
    const data: BudgetData = {
      ...emptyData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "100" },
        { id: 2, categoryId: 2, month: "2025-07", amount: "200" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-07"]);
  });

  it("returns months in ascending order", () => {
    const data: BudgetData = {
      ...emptyData(),
      assignments: [
        { id: 3, categoryId: 1, month: "2025-12", amount: "1" },
        { id: 1, categoryId: 1, month: "2025-01", amount: "1" },
        { id: 2, categoryId: 1, month: "2025-06", amount: "1" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2025-01", "2025-06", "2025-12"]);
  });
});

// ---------------------------------------------------------------------------
// computeCarryover
// ---------------------------------------------------------------------------

describe("computeCarryover", () => {
  it("returns 0 for unknown category id", () => {
    expect(computeCarryover(emptyData(), 999, "2025-07")).toBe(0);
  });

  it("returns seed carryover when no prior months exist", () => {
    const data: BudgetData = {
      ...emptyData(),
      categories: [makeCategory({ id: 1, carryover: "150.00" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "100" }],
    };
    // Only 2025-07 exists and it equals the target — no prior months to walk.
    expect(computeCarryover(data, 1, "2025-07")).toBeCloseTo(150);
  });

  it("accumulates one prior month correctly", () => {
    // Month A: seed=0, assigned=500, spent=-300 → available=200
    // Month B: carryoverIn should be 200
    const data: BudgetData = {
      ...emptyData(),
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "500" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "400" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-20", payee: "", memo: "", amount: "-300", cleared: true },
      ],
    };
    expect(computeCarryover(data, 1, "2025-07")).toBeCloseTo(200);
  });

  it("chains three months correctly", () => {
    // Seed=100
    // Jan: +200 assigned, -50 spent → end: 250
    // Feb: +300 assigned, -100 spent → end: 450
    // Mar target: carryoverIn should be 450
    const data: BudgetData = {
      ...emptyData(),
      categories: [makeCategory({ id: 1, carryover: "100" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-01", amount: "200" },
        { id: 2, categoryId: 1, month: "2025-02", amount: "300" },
        { id: 3, categoryId: 1, month: "2025-03", amount: "400" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-01-15", payee: "", memo: "", amount: "-50", cleared: true },
        { id: 2, accountId: 1, categoryId: 1, date: "2025-02-20", payee: "", memo: "", amount: "-100", cleared: true },
      ],
    };
    expect(computeCarryover(data, 1, "2025-03")).toBeCloseTo(450);
  });

  it("negative available carries over as-is (overspending in prior month)", () => {
    // Month A: seed=0, assigned=100, spent=-200 → available=-100
    // Month B: carryoverIn = -100
    const data: BudgetData = {
      ...emptyData(),
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "100" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "50" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-200", cleared: true },
      ],
    };
    expect(computeCarryover(data, 1, "2025-07")).toBeCloseTo(-100);
  });
});

// ---------------------------------------------------------------------------
// computeTBB
// ---------------------------------------------------------------------------

describe("computeTBB", () => {
  it("returns 0 when there are no transactions and no assignments", () => {
    expect(computeTBB(emptyData(), "2025-07")).toBe(0);
  });

  it("equals income when nothing is assigned", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory()],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "3200", cleared: true },
      ],
    };
    expect(computeTBB(data, "2025-07")).toBeCloseTo(3200);
  });

  it("is income minus assigned for non-CC categories", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup({ id: 1, isCreditCardPayments: false })],
      categories: [
        makeCategory({ id: 1, groupId: 1 }),
        makeCategory({ id: 2, groupId: 1, name: "Cat2" }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "1000" },
        { id: 2, categoryId: 2, month: "2025-07", amount: "500" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "2000", cleared: true },
      ],
    };
    // TBB = 2000 - (1000 + 500) = 500
    expect(computeTBB(data, "2025-07")).toBeCloseTo(500);
  });

  it("is negative when more is assigned than earned (over-budgeted)", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "5000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "3000", cleared: true },
      ],
    };
    // TBB = 3000 - 5000 = -2000
    expect(computeTBB(data, "2025-07")).toBeCloseTo(-2000);
  });

  it("excludes CC payment assignments from TBB calculation", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [
        makeGroup({ id: 1, isCreditCardPayments: false }),
        makeGroup({ id: 2, name: "CC Payments", isCreditCardPayments: true }),
      ],
      categories: [
        makeCategory({ id: 1, groupId: 1 }),
        makeCategory({ id: 2, groupId: 2, name: "Visa Payment" }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-07", amount: "1000" },
        // This CC payment assignment should NOT reduce TBB
        { id: 2, categoryId: 2, month: "2025-07", amount: "500" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "2000", cleared: true },
      ],
    };
    // TBB = 2000 - 1000 = 1000 (CC assignment excluded)
    expect(computeTBB(data, "2025-07")).toBeCloseTo(1000);
  });

  it("only counts income from uncategorised positive transactions", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      transactions: [
        // Uncategorised income — counts
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "2000", cleared: true },
        // Categorised positive (refund) — does NOT count as income for TBB
        { id: 2, accountId: 1, categoryId: 1, date: "2025-07-05", payee: "Refund", memo: "", amount: "100", cleared: true },
      ],
    };
    expect(computeTBB(data, "2025-07")).toBeCloseTo(2000);
  });
});

// ---------------------------------------------------------------------------
// computeBudget — integration / full flow
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
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "5000" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "1000", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.overBudgeted).toBe(true);
    expect(result.tbb).toBeCloseTo(-4000);
  });

  it("overBudgeted is false when fully balanced", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1 })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "2000" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "2000", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.overBudgeted).toBe(false);
    expect(result.tbb).toBeCloseTo(0);
  });

  it("cumulative carryover flows into the next month's available", () => {
    // Month A: assign 500, spend 300 → available 200
    // Month B: assign 100 → available should be 200 (carryover) + 100 = 300
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "500" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "100" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-300", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBeCloseTo(200);
    expect(row.available).toBeCloseTo(300);
  });

  it("overspend in prior month reduces next month's available", () => {
    // Month A: assign 100, spend -300 → available -200 (overspent)
    // Month B: assign 500 → available = -200 + 500 = 300
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "0" })],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: "100" },
        { id: 2, categoryId: 1, month: "2025-07", amount: "500" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-06-15", payee: "", memo: "", amount: "-300", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBeCloseTo(-200);
    expect(row.available).toBeCloseTo(300);
  });

  it("three-month carryover chain with multiple categories", () => {
    // Cat1: seed=50, Jan assigned=200 spent=-150=100, Feb assigned=50 spent=-20=130
    // Cat2: seed=0,  Jan assigned=300 spent=-0=300,   Feb assigned=100 spent=-200=200
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [
        makeCategory({ id: 1, name: "Cat1", carryover: "50" }),
        makeCategory({ id: 2, name: "Cat2", sort: 1, carryover: "0" }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-01", amount: "200" },
        { id: 2, categoryId: 2, month: "2025-01", amount: "300" },
        { id: 3, categoryId: 1, month: "2025-02", amount: "50" },
        { id: 4, categoryId: 2, month: "2025-02", amount: "100" },
        { id: 5, categoryId: 1, month: "2025-03", amount: "0" },
        { id: 6, categoryId: 2, month: "2025-03", amount: "0" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-01-10", payee: "", memo: "", amount: "-150", cleared: true },
        { id: 2, accountId: 1, categoryId: 1, date: "2025-02-10", payee: "", memo: "", amount: "-20", cleared: true },
        { id: 3, accountId: 1, categoryId: 2, date: "2025-02-10", payee: "", memo: "", amount: "-200", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-03");
    const [g] = result.groups;
    const cat1 = g!.rows.find((r) => r.category.name === "Cat1")!;
    const cat2 = g!.rows.find((r) => r.category.name === "Cat2")!;

    // Cat1: Jan end = 50+200-150=100; Feb end = 100+50-20=130; Mar carryoverIn=130
    expect(cat1.carryoverIn).toBeCloseTo(130);
    // Cat2: Jan end = 0+300-0=300; Feb end = 300+100-200=200; Mar carryoverIn=200
    expect(cat2.carryoverIn).toBeCloseTo(200);
  });

  it("seed carryover on Category is applied only in the first month", () => {
    // seed=100, target month is 2025-07 (only month with data)
    // → carryoverIn should be 100 (the seed), not 200
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, carryover: "100" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "50" }],
    };
    const result = computeBudget(data, "2025-07");
    const row = result.groups[0]!.rows[0]!;
    expect(row.carryoverIn).toBeCloseTo(100);
    expect(row.available).toBeCloseTo(150); // 100 seed + 50 assigned
  });

  it("fundedPct uses goal target when set", () => {
    // goal=1000, available=400 → fundedPct = 0.4
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: "1000", carryover: "0" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "400" }],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBeCloseTo(0.4);
  });

  it("fundedPct uses assigned when no goal target", () => {
    // assigned=200, spent=-50 → available=150; pct = 150/200 = 0.75
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: null, carryover: "0" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "200" }],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2025-07-10", payee: "", memo: "", amount: "-50", cleared: true },
      ],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBeCloseTo(0.75);
  });

  it("fundedPct is 1 when available > 0 and nothing assigned", () => {
    // seed=100, no assignment, no spend → available=100, pct=1
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: null, carryover: "100" })],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBe(1);
  });

  it("fundedPct is 0 when available is 0 and nothing assigned", () => {
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: null, carryover: "0" })],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBe(0);
  });

  it("fundedPct is clamped to 1 even when available exceeds goal", () => {
    // goal=100, available=150 → fundedPct = min(1, 150/100) = 1
    const data: BudgetData = {
      ...emptyData(),
      groups: [makeGroup()],
      categories: [makeCategory({ id: 1, goalTarget: "100", carryover: "50" })],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "100" }],
    };
    const result = computeBudget(data, "2025-07");
    expect(result.groups[0]!.rows[0]!.fundedPct).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Seed fixture integration
  // -------------------------------------------------------------------------

  it("seed fixture: returns the correct number of groups", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    expect(result.groups).toHaveLength(data.groups.length);
  });

  it("seed fixture: totalIncome equals the two paychecks", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    // Two paycheck transactions at $3200 each = $6400
    expect(result.totalIncome).toBeCloseTo(6400);
  });

  it("seed fixture: TBB = totalIncome − totalAssigned", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    expect(result.tbb).toBeCloseTo(result.totalIncome - result.totalAssigned);
  });

  it("seed fixture: CC payment categories are excluded from totalAssigned", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    const ccGroupIds = new Set(data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id));
    const ccCatIds = new Set(data.categories.filter((c) => ccGroupIds.has(c.groupId)).map((c) => c.id));
    const manualAssigned = data.assignments
      .filter((a) => a.month === DEMO_MONTH && !ccCatIds.has(a.categoryId))
      .reduce((s, a) => s + parseFloat(a.amount), 0);
    expect(result.totalAssigned).toBeCloseTo(manualAssigned);
  });

  it("seed fixture: Mortgage category has available ≈ 0 (fully spent)", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    const mortgage = result.groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Mortgage");
    // Assigned $1850, spent $1850 → available = 0 + 1850 - 1850 = 0
    expect(mortgage!.available).toBeCloseTo(0);
  });

  it("seed fixture: all category available values are arithmetically correct", () => {
    const data = makeSeedBudgetData();
    const result = computeBudget(data, DEMO_MONTH);
    for (const g of result.groups) {
      for (const r of g.rows) {
        // We need raw flow for this check — recompute it
        const rawFlow = data.transactions
          .filter((t) => t.date.startsWith(DEMO_MONTH) && t.categoryId === r.category.id)
          .reduce((s, t) => s + parseFloat(t.amount), 0);
        // available = carryoverIn + assigned + rawFlow + ccBuffer
        expect(r.available).toBeCloseTo(r.carryoverIn + r.assigned + rawFlow + r.ccBuffer);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CC Buffer (YNAB4's auto-transfer to CC payment category)
// ---------------------------------------------------------------------------

describe("CC buffer auto-calculation", () => {
  function ccData(): BudgetData {
    return {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "3000", onBudget: true, sort: 0 },
        { id: 2, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "-500", onBudget: true, sort: 1 },
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
        { id: 1, categoryId: 1, month: "2025-07", amount: "400" },
        { id: 2, categoryId: 2, month: "2025-07", amount: "0" },
      ],
      transactions: [
        // Uncategorised income
        { id: 1, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: "3000", cleared: true },
        // Grocery spend on the Visa card (negative, categorised)
        { id: 2, accountId: 2, categoryId: 1, date: "2025-07-05", payee: "Whole Foods", memo: "", amount: "-120", cleared: true },
        { id: 3, accountId: 2, categoryId: 1, date: "2025-07-18", payee: "Trader Joe", memo: "", amount: "-80", cleared: true },
      ],
      recurring: [],
    };
  }

  it("CC payment category receives the spending as a buffer", () => {
    const result = computeBudget(ccData(), "2025-07");
    const ccRow = result.groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Visa Payment")!;
    // $120 + $80 = $200 spent on Visa → buffer = $200
    expect(ccRow.ccBuffer).toBeCloseTo(200);
    // available = 0 (carryover) + 0 (assigned) + 0 (rawFlow on cat2) + 200 (buffer) = 200
    expect(ccRow.available).toBeCloseTo(200);
  });

  it("non-CC categories have ccBuffer = 0", () => {
    const result = computeBudget(ccData(), "2025-07");
    const groceries = result.groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Groceries")!;
    expect(groceries.ccBuffer).toBe(0);
  });

  it("CC buffer does not double-count income transactions (positive on CC account)", () => {
    const data = ccData();
    // Add a credit/refund on the CC account — should NOT increase buffer (it's positive)
    data.transactions.push(
      { id: 4, accountId: 2, categoryId: 1, date: "2025-07-20", payee: "Refund", memo: "", amount: "50", cleared: true }
    );
    const result = computeBudget(data, "2025-07");
    const ccRow = result.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa Payment")!;
    // Only negative transactions count: 120 + 80 = 200, refund ignored
    expect(ccRow.ccBuffer).toBeCloseTo(200);
  });

  it("CC buffer accumulates into carryoverIn for the following month", () => {
    // Month A: $200 charged on Visa → buffer = $200 in Visa Payment
    // Month B: carryoverIn for Visa Payment = $200 (end balance of month A)
    const data = ccData();
    data.assignments.push(
      { id: 3, categoryId: 1, month: "2025-08", amount: "300" },
      { id: 4, categoryId: 2, month: "2025-08", amount: "0" }
    );
    const result = computeBudget(data, "2025-08");
    const ccRow = result.groups.flatMap((g) => g.rows).find((r) => r.category.name === "Visa Payment")!;
    // Month A available = 0 + 0 + 0 + 200(buffer) = 200 → carries into Aug
    expect(ccRow.carryoverIn).toBeCloseTo(200);
  });

  it("TBB is not affected by CC buffer (buffer is not income)", () => {
    // TBB should only reflect income - assigned (non-CC)
    // Buffer on CC payment category is a movement of money, not new income
    const result = computeBudget(ccData(), "2025-07");
    // income=3000, assigned(Groceries)=400, cc-assigned excluded → TBB = 3000 - 400 = 2600
    expect(result.tbb).toBeCloseTo(2600);
    expect(result.totalIncome).toBeCloseTo(3000);
  });
});

// ---------------------------------------------------------------------------
// Cumulative TBB carryforward
// ---------------------------------------------------------------------------

describe("cumulative TBB carryforward", () => {
  function twoMonthData(opts: { incomeA: number; assignedA: number; incomeB: number; assignedB: number }): BudgetData {
    return {
      accounts: [],
      groups: [{ id: 1, name: "Bills", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 1, groupId: 1, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-06", amount: String(opts.assignedA) },
        { id: 2, categoryId: 1, month: "2025-07", amount: String(opts.assignedB) },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-06-01", payee: "Payroll", memo: "", amount: String(opts.incomeA), cleared: true },
        { id: 2, accountId: 1, categoryId: null, date: "2025-07-01", payee: "Payroll", memo: "", amount: String(opts.incomeB), cleared: true },
      ],
      recurring: [],
    };
  }

  it("positive TBB surplus from prior month carries forward to next month's TBB", () => {
    // June: income=3000, assigned=2000 → surplus=1000
    // July: income=3000, assigned=3000, surplus from June=1000 → TBB = 3000-3000+1000 = 1000
    const data = twoMonthData({ incomeA: 3000, assignedA: 2000, incomeB: 3000, assignedB: 3000 });
    const result = computeBudget(data, "2025-07");
    expect(result.priorSurplus).toBeCloseTo(1000);
    expect(result.tbb).toBeCloseTo(1000);
  });

  it("negative TBB (deficit) in prior month does NOT carry forward", () => {
    // June: income=1000, assigned=3000 → tbb=-2000 (over-budgeted) — deficit stays in June
    // July: income=3000, assigned=1000, no surplus carried → TBB = 3000-1000+0 = 2000
    const data = twoMonthData({ incomeA: 1000, assignedA: 3000, incomeB: 3000, assignedB: 1000 });
    const result = computeBudget(data, "2025-07");
    expect(result.priorSurplus).toBe(0);
    expect(result.tbb).toBeCloseTo(2000);
  });

  it("surplus accumulates across three months before being consumed", () => {
    // Jan: income=3000, assigned=2000 → surplus=1000
    // Feb: income=3000, assigned=2500, surplus=1000 → tbb=1500 → surplus=1500
    // Mar: income=3000, assigned=3000, surplus=1500 → tbb=1500
    const data: BudgetData = {
      accounts: [],
      groups: [{ id: 1, name: "G", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 1, groupId: 1, name: "Cat", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [
        { id: 1, categoryId: 1, month: "2025-01", amount: "2000" },
        { id: 2, categoryId: 1, month: "2025-02", amount: "2500" },
        { id: 3, categoryId: 1, month: "2025-03", amount: "3000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2025-01-01", payee: "Payroll", memo: "", amount: "3000", cleared: true },
        { id: 2, accountId: 1, categoryId: null, date: "2025-02-01", payee: "Payroll", memo: "", amount: "3000", cleared: true },
        { id: 3, accountId: 1, categoryId: null, date: "2025-03-01", payee: "Payroll", memo: "", amount: "3000", cleared: true },
      ],
      recurring: [],
    };
    const result = computeBudget(data, "2025-03");
    expect(result.priorSurplus).toBeCloseTo(1500);
    expect(result.tbb).toBeCloseTo(1500);
  });

  it("computeTBB also includes prior surplus", () => {
    // Single prior month surplus of 500 should appear in computeTBB result
    const data = twoMonthData({ incomeA: 2000, assignedA: 1500, incomeB: 2000, assignedB: 2000 });
    const tbb = computeTBB(data, "2025-07");
    // priorSurplus=500, income=2000, assigned=2000 → TBB = 500
    expect(tbb).toBeCloseTo(500);
  });
});
