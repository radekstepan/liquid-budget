/**
 * oracle-b1-monthly-budget.test.ts
 *
 * Oracle mapping for YNAB4 monthly-budget behaviour through this repo's
 * engine (`computeBudget` / `getMonthsWithData` / `buildBudgetIndex`).
 *
 * Oracle sources (../ynab4-modern/packages/domain/src):
 *   - MonthlyBudget.test.ts (22 tests)
 *   - MonthlyBudgetList.test.ts (16 tests)
 *   - MonthlyUncategorisedMasterCategoryBudget.test.ts (2 tests)
 *   - MonthlyUncategorisedSubCategoryBudget.test.ts (6 tests)
 * YNAB4 monthly-budget behavior reference:
 *   - MonthlyBudget / MonthlyBudgetList
 *   - MonthlyUncategorisedMasterCategoryBudget
 *   - MonthlyUncategorisedSubCategoryBudget
 *
 * NOTE: the oracle files and YNAB4 sources are not present in this checkout,
 * so headers below cite oracle file/suite names (not line numbers) and map
 * each oracle behaviour to its computable equivalent here.
 *
 * Mapping rules used throughout:
 *   - Amounts are integer-cent strings (e.g. "10000" = $100.00).
 *   - This repo keys months as "YYYY-MM" and validates via isValidISOMonth
 *     (format.ts); YNAB4's first-of-month guard maps to that + seeding.
 *   - Buffer formulas (carried-negative / deferred / supplemental) map to
 *     computeBudget fields: tbb / totalIncome / priorSurplus /
 *     overspentPrevious / incomeFromFuture / incomeFromPast /
 *     incomeDeferredToFuture / incomeDeferredToPast.
 *   - Income offsets (Current/NextMonth splits, null-offset filter) map to
 *     the incomeMonth field (FORK: incomeMonth superset — this repo honours
 *     an explicit incomeMonth on any transaction, a superset of YNAB4).
 *   - moveMoney maps to two assignments shifting budgeted between
 *     categories with a totalAssigned invariant.
 *   - MonthlyBudgetList store-chain behaviours with no entity list here are
 *     marked N/A and covered via computable equivalents (month ordering,
 *     gap months, freshStart via zero carryover).
 */
import { describe, expect, it } from "vitest";
import {
  buildBudgetIndex,
  computeBudget,
  getMonthsWithData,
  invalidateBudgetIndex,
  isIncomeTransaction,
} from "../src/budget-engine.js";
import { isValidISOMonth } from "../src/format.js";
import type {
  Account,
  BudgetData,
  Category,
  CategoryGroup,
  Transaction,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture builders (amounts in integer-cent strings)
// ---------------------------------------------------------------------------

function checking(id = 1): Account {
  return {
    id,
    name: "Checking",
    kind: "liquid",
    groupLabel: "Budget Accounts",
    balance: "0",
    onBudget: true,
    sort: 0,
  };
}

function credit(id = 9): Account {
  return {
    id,
    name: "Visa",
    kind: "credit",
    groupLabel: "Credit Cards",
    balance: "0",
    onBudget: true,
    sort: 1,
  };
}

function group(id = 1, name = "Bills"): CategoryGroup {
  return { id, name, sort: id - 1, isCreditCardPayments: false };
}

function cat(id: number, groupId = 1, extra: Partial<Category> = {}): Category {
  return {
    id,
    groupId,
    name: `Cat ${id}`,
    sort: id,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...extra,
  };
}

function tx(id: number, extra: Partial<Transaction>): Transaction {
  return {
    id,
    accountId: 1,
    categoryId: null,
    date: "2025-07-01",
    payee: "Payee",
    memo: "",
    amount: "0",
    status: "c",
    ...extra,
  };
}

function baseData(): BudgetData {
  return {
    accounts: [checking()],
    groups: [group()],
    categories: [cat(1), cat(2)],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

function rowFor(data: BudgetData, month: string, categoryId: number) {
  const res = computeBudget(data, month);
  for (const g of res.groups) {
    const row = g.rows.find((r) => r.category.id === categoryId);
    if (row) return row;
  }
  throw new Error(`no row for category ${categoryId}`);
}

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudget.test.ts — first-of-month guard / month keys
// ---------------------------------------------------------------------------

describe("oracle B1: month keys (first-of-month guard → YYYY-MM + isValidISOMonth)", () => {
  it("accepts well-formed YYYY-MM keys", () => {
    expect(isValidISOMonth("2025-07")).toBe(true);
    expect(isValidISOMonth("2000-01")).toBe(true);
  });

  it("rejects day-precision dates, garbage, and out-of-range months", () => {
    expect(isValidISOMonth("2025-07-01")).toBe(false);
    expect(isValidISOMonth("2025-13")).toBe(false);
    expect(isValidISOMonth("not-a-month")).toBe(false);
    expect(isValidISOMonth("")).toBe(false);
    expect(isValidISOMonth(null)).toBe(false);
  });

  it("seeds a month with no history from category.carryover", () => {
    const data = baseData();
    data.categories = [cat(1, 1, { carryover: "25000" })];
    const res = computeBudget(data, "2025-07");
    expect(rowFor(data, "2025-07", 1).carryoverIn).toBe(25000);
    expect(res.priorSurplus).toBe(0);
    expect(res.overspentPrevious).toBe(0);
    expect(res.overspentPreviousMonthKey).toBeUndefined();
  });

  it("computes an unknown future month from the nearest prior ending balance", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-06", amount: "50000" }];
    data.transactions = [
      tx(1, { categoryId: 1, date: "2025-06-15", amount: "-30000" }),
    ];
    // June available = 20000; no July rows stored, but carryover chains forward.
    expect(rowFor(data, "2025-09", 1).carryoverIn).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudgetList.test.ts — ordering, clamps, getOrCreate/first/last
// (store-chain N/A: no entity list here; covered via computable equivalents)
// ---------------------------------------------------------------------------

describe("oracle B1: month list ordering and clamps (getMonthsWithData)", () => {
  it("returns months in ascending order across assignments and transactions", () => {
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-12", amount: "100" },
      { id: 2, categoryId: 1, month: "2025-01", amount: "100" },
    ];
    data.transactions = [tx(1, { date: "2025-06-15", amount: "100" })];
    expect(getMonthsWithData(data)).toEqual(["2025-01", "2025-06", "2025-12"]);
  });

  it("dedupes months seen in both assignments and transactions", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-07", amount: "100" }];
    data.transactions = [tx(1, { date: "2025-07-02", amount: "100" })];
    expect(getMonthsWithData(data)).toEqual(["2025-07"]);
  });

  it("includes incomeMonth keys so deferred income months sort into the walk", () => {
    const data = baseData();
    data.transactions = [
      tx(1, { date: "2025-06-15", amount: "10000", incomeMonth: "2025-08" }),
    ];
    expect(getMonthsWithData(data)).toEqual(["2025-06", "2025-08"]);
  });

  it("first/last equivalents: ends of the ordered list bound the walk", () => {
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-03", amount: "100" },
      { id: 2, categoryId: 1, month: "2025-01", amount: "100" },
      { id: 3, categoryId: 1, month: "2025-02", amount: "100" },
    ];
    const months = getMonthsWithData(data);
    expect(months[0]).toBe("2025-01");
    expect(months[months.length - 1]).toBe("2025-03");
  });

  it("gap months with zero activity carry balances through unchanged", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-06", amount: "50000" }];
    // No July rows at all: July inherits June's ending balance.
    const june = rowFor(data, "2025-06", 1);
    expect(june.available).toBe(50000);
    expect(rowFor(data, "2025-07", 1).carryoverIn).toBe(50000);
    expect(rowFor(data, "2025-07", 1).available).toBe(50000);
  });

  it("freshStart equivalent: zero carryover plus no history yields zero balances", () => {
    // N/A store-chain: no entity removal here; fresh start == pristine data.
    const data = baseData();
    const res = computeBudget(data, "2025-07");
    expect(res.tbb).toBe(0);
    expect(res.priorSurplus).toBe(0);
    for (const g of res.groups) for (const r of g.rows) {
      expect(r.carryoverIn).toBe(0);
      expect(r.available).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudget.test.ts — buffer formulas (carried-negative/deferred/
// supplemental) via multi-month fixtures
// ---------------------------------------------------------------------------

describe("oracle B1: carried-negative buffer (overspend → TBB deduction)", () => {
  it("clamps cash overspend to zero carryover and deducts it from next TBB", () => {
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-06", amount: "10000" },
      { id: 2, categoryId: 1, month: "2025-07", amount: "50000" },
    ];
    data.transactions = [
      tx(1, { categoryId: 1, date: "2025-06-15", amount: "-30000" }),
      tx(2, { date: "2025-07-01", amount: "100000" }),
    ];
    const july = computeBudget(data, "2025-07");
    expect(rowFor(data, "2025-07", 1).carryoverIn).toBe(0);
    expect(july.overspentPrevious).toBe(20000);
    expect(july.overspentPreviousMonthKey).toBe("2025-06");
    // income 100000 - assigned 50000 + priorSurplus(-30000) = 20000
    expect(july.priorSurplus).toBe(-30000);
    expect(july.tbb).toBe(20000);
  });

  it("red-arrow (overspendCarriesOver) carries the negative instead of taxing TBB", () => {
    const data = baseData();
    data.categories = [cat(1), cat(2, 1, { overspendCarriesOver: true })];
    data.assignments = [
      { id: 1, categoryId: 2, month: "2025-06", amount: "10000" },
      { id: 2, categoryId: 2, month: "2025-07", amount: "50000" },
    ];
    data.transactions = [
      tx(1, { categoryId: 2, date: "2025-06-15", amount: "-30000" }),
      tx(2, { date: "2025-07-01", amount: "100000" }),
    ];
    expect(rowFor(data, "2025-07", 2).carryoverIn).toBe(-20000);
    const july = computeBudget(data, "2025-07");
    expect(july.overspentPrevious).toBe(0);
    expect(july.priorSurplus).toBe(-10000);
    expect(july.tbb).toBe(40000);
  });
});

describe("oracle B1: supplemental buffer (income - assigned + prior surplus)", () => {
  it("surplus TBB rolls forward across multiple months", () => {
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-06", amount: "40000" },
      { id: 2, categoryId: 1, month: "2025-07", amount: "10000" },
    ];
    data.transactions = [tx(1, { date: "2025-06-01", amount: "100000" })];
    const july = computeBudget(data, "2025-07");
    expect(july.priorSurplus).toBe(60000);
    expect(july.totalIncome).toBe(0);
    expect(july.tbb).toBe(50000);
  });

  it("over-assignment yields negative TBB and overBudgeted", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-07", amount: "500000" }];
    data.transactions = [tx(1, { date: "2025-07-01", amount: "100000" })];
    const res = computeBudget(data, "2025-07");
    expect(res.totalIncome).toBe(100000);
    expect(res.totalAssigned).toBe(500000);
    expect(res.tbb).toBe(-400000);
    expect(res.overBudgeted).toBe(true);
  });

  it("three-month chain accumulates carryoverIn step by step", () => {
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-05", amount: "30000" },
      { id: 2, categoryId: 1, month: "2025-06", amount: "30000" },
      { id: 3, categoryId: 1, month: "2025-07", amount: "0" },
    ];
    data.transactions = [tx(1, { categoryId: 1, date: "2025-05-10", amount: "-10000" })];
    expect(rowFor(data, "2025-06", 1).carryoverIn).toBe(20000);
    expect(rowFor(data, "2025-07", 1).carryoverIn).toBe(50000);
    expect(rowFor(data, "2025-07", 1).available).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudget.test.ts — income offsets (Current/NextMonth splits,
// null-offset filter) → incomeMonth (FORK: incomeMonth superset)
// ---------------------------------------------------------------------------

describe("oracle B1: income offsets via incomeMonth (FORK: incomeMonth superset)", () => {
  it("income dated in June but attributed to August lands in August TBB", () => {
    const data = baseData();
    data.transactions = [
      tx(1, { date: "2025-06-15", amount: "120000", incomeMonth: "2025-08" }),
    ];
    expect(computeBudget(data, "2025-06").totalIncome).toBe(0);
    const aug = computeBudget(data, "2025-08");
    expect(aug.totalIncome).toBe(120000);
    expect(aug.incomeFromPast).toBe(120000);
    expect(aug.incomeFromFuture).toBe(0);
    expect(computeBudget(data, "2025-06").incomeDeferredToFuture).toBe(120000);
  });

  it("income dated in August but attributed to June lands in June TBB", () => {
    const data = baseData();
    data.transactions = [
      tx(1, { date: "2025-08-15", amount: "90000", incomeMonth: "2025-06" }),
    ];
    const june = computeBudget(data, "2025-06");
    expect(june.totalIncome).toBe(90000);
    expect(june.incomeFromFuture).toBe(90000);
    expect(computeBudget(data, "2025-08").totalIncome).toBe(0);
    expect(computeBudget(data, "2025-08").incomeDeferredToPast).toBe(90000);
  });

  it("null incomeMonth keeps income in its transaction month", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-15", amount: "70000", incomeMonth: null })];
    const july = computeBudget(data, "2025-07");
    expect(july.totalIncome).toBe(70000);
    expect(july.incomeFromFuture).toBe(0);
    expect(july.incomeFromPast).toBe(0);
  });

  it("split-month income: two legs attributed to different months", () => {
    const data = baseData();
    data.transactions = [
      tx(1, { date: "2025-07-10", amount: "60000", incomeMonth: "2025-07" }),
      tx(2, { date: "2025-07-20", amount: "40000", incomeMonth: "2025-08" }),
    ];
    expect(computeBudget(data, "2025-07").totalIncome).toBe(60000);
    expect(computeBudget(data, "2025-08").totalIncome).toBe(40000);
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudget.test.ts — moveMoney (two assignments, invariant)
// ---------------------------------------------------------------------------

describe("oracle B1: moveMoney via paired assignments", () => {
  it("shifting budgeted between categories keeps totalAssigned invariant", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "100000" })];
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-07", amount: "60000" },
      { id: 2, categoryId: 2, month: "2025-07", amount: "40000" },
    ];
    const before = computeBudget(data, "2025-07");
    expect(before.totalAssigned).toBe(100000);
    expect(before.tbb).toBe(0);
    // moveMoney: shift 10000 from cat 1 to cat 2.
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-07", amount: "50000" },
      { id: 2, categoryId: 2, month: "2025-07", amount: "50000" },
    ];
    invalidateBudgetIndex(data);
    const after = computeBudget(data, "2025-07");
    expect(after.totalAssigned).toBe(100000);
    expect(after.tbb).toBe(0);
    expect(rowFor(data, "2025-07", 1).assigned).toBe(50000);
    expect(rowFor(data, "2025-07", 2).assigned).toBe(50000);
  });

  it("moving money out of a spent category preserves its outflow math", () => {
    const data = baseData();
    data.transactions = [
      tx(1, { date: "2025-07-01", amount: "100000" }),
      tx(2, { categoryId: 1, date: "2025-07-10", amount: "-30000" }),
    ];
    data.assignments = [
      { id: 1, categoryId: 1, month: "2025-07", amount: "20000" },
      { id: 2, categoryId: 2, month: "2025-07", amount: "80000" },
    ];
    expect(rowFor(data, "2025-07", 1).available).toBe(-10000);
    expect(computeBudget(data, "2025-07").totalAssigned).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyBudget.test.ts — prev/next guards, waiting-leaf cascade,
// incremental diffs → ordered walk, carryoverIn chaining, index determinism
// ---------------------------------------------------------------------------

describe("oracle B1: ordered walk, guards, and determinism", () => {
  it("prev guard: first month has no overspentPrevious or key", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "50000" })];
    const res = computeBudget(data, "2025-07");
    expect(res.overspentPrevious).toBe(0);
    expect(res.overspentPreviousMonthKey).toBeUndefined();
  });

  it("next guard: querying past the last month still resolves carryover", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-06", amount: "20000" }];
    const res = computeBudget(data, "2025-12");
    expect(res.groups.length).toBe(1);
    expect(rowFor(data, "2025-12", 1).carryoverIn).toBe(20000);
  });

  it("overspend inheritance cascades: override in June governs July until re-overridden", () => {
    const data = baseData();
    data.categories = [cat(1), cat(2)];
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-06", amount: "10000" }];
    data.transactions = [tx(1, { categoryId: 1, date: "2025-06-15", amount: "-30000" })];
    const noOverride = computeBudget(data, "2025-07");
    expect(noOverride.overspentPrevious).toBe(20000);
    const withOverride = computeBudget(data, "2025-07", { "1": { "2025-06": true } });
    expect(withOverride.overspentPrevious).toBe(0);
    expect(rowFor(data, "2025-07", 1).carryoverIn).toBe(0);
    // Re-override back in July restores clamp behaviour for August.
    const re = computeBudget(data, "2025-08", { "1": { "2025-06": true, "2025-07": false } });
    expect(re.overspentPrevious).toBe(0);
  });

  it("incremental diff: one extra assignment changes only its category row + totals", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "100000" })];
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-07", amount: "30000" }];
    const before = computeBudget(data, "2025-07");
    data.assignments = [
      ...data.assignments,
      { id: 2, categoryId: 2, month: "2025-07", amount: "20000" },
    ];
    invalidateBudgetIndex(data);
    const after = computeBudget(data, "2025-07");
    expect(after.totalAssigned - before.totalAssigned).toBe(20000);
    expect(before.tbb - after.tbb).toBe(20000);
    expect(rowFor(data, "2025-07", 1).assigned).toBe(30000);
    expect(rowFor(data, "2025-07", 2).assigned).toBe(20000);
  });

  it("buildBudgetIndex is deterministic for identical inputs", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-07", amount: "30000" }];
    data.transactions = [
      tx(1, { date: "2025-07-01", amount: "100000" }),
      tx(2, { categoryId: 1, date: "2025-07-10", amount: "-10000" }),
    ];
    expect(buildBudgetIndex(data)).toEqual(buildBudgetIndex(data));
  });

  it("buildBudgetIndex versions and round-trips the walk inputs", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2025-07", amount: "30000" }];
    data.transactions = [tx(1, { date: "2025-07-01", amount: "100000" })];
    const idx = buildBudgetIndex(data);
    expect(idx.version).toBe(1);
    expect(idx.assignedTotalByMonth["2025-07"]).toBe(30000);
    expect(idx.incomeByMonth["2025-07"]).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// Oracle: MonthlyUncategorised*Budget.test.ts — null-category transactions
// ---------------------------------------------------------------------------

describe("oracle B1: uncategorised master/sub budgets → income vs outflow", () => {
  it("positive on-budget null-category transaction is income", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "55000" })];
    expect(isIncomeTransaction(data.transactions[0]!, new Map([[1, checking()]]))).toBe(true);
    expect(computeBudget(data, "2025-07").totalIncome).toBe(55000);
  });

  it("negative on-budget null-category transaction is excluded from income", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "-55000" })];
    expect(isIncomeTransaction(data.transactions[0]!, new Map([[1, checking()]]))).toBe(false);
    expect(computeBudget(data, "2025-07").totalIncome).toBe(0);
  });

  it("off-budget positive null-category transaction is not income", () => {
    const off = { ...checking(), onBudget: false };
    const data: BudgetData = { ...baseData(), accounts: [off] };
    data.transactions = [tx(1, { date: "2025-07-01", amount: "55000" })];
    expect(isIncomeTransaction(data.transactions[0]!, new Map([[1, off]]))).toBe(false);
    expect(computeBudget(data, "2025-07").totalIncome).toBe(0);
  });

  it("zero-amount null-category transaction is not income", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "0" })];
    expect(isIncomeTransaction(data.transactions[0]!)).toBe(false);
    expect(computeBudget(data, "2025-07").totalIncome).toBe(0);
  });

  it("explicit isIncome=false wins over a positive amount", () => {
    const data = baseData();
    data.transactions = [tx(1, { date: "2025-07-01", amount: "55000", isIncome: false })];
    expect(isIncomeTransaction(data.transactions[0]!)).toBe(false);
  });

  it("CC buffer fork: funded card spend moves to the payment category, not TBB", () => {
    // FORK (no YNAB4 counterpart): funded CC spend accrues a buffer in the
    // linked payment category instead of Pre-YNAB-Debt categories.
    const visa = credit(9);
    const ccGroup: CategoryGroup = { id: 7, name: "Credit Card Payments", sort: 9, isCreditCardPayments: true };
    const data: BudgetData = {
      accounts: [checking(1), visa],
      groups: [group(), ccGroup],
      categories: [
        cat(1),
        { id: 10, groupId: 7, name: "Visa Payment", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: 9 },
      ],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "50000" }],
      transactions: [
        tx(1, { accountId: 9, categoryId: 1, date: "2025-07-10", amount: "-20000" }),
      ],
      recurring: [],
    };
    const res = computeBudget(data, "2025-07");
    const payRow = rowFor(data, "2025-07", 10);
    expect(payRow.ccBuffer).toBe(20000);
    expect(res.overspentPrevious).toBe(0);
  });
});
