/**
 * oracle-b1-sub-list-agg.test.ts
 *
 * Oracle port: sub-category list aggregation mapped through `computeBudget`.
 *
 * Source (8 tests):
 * - ynab4-modern/packages/domain/src/MonthlySubCategoryBudgetList.test.ts:61-77
 *   (update removes missing leaves), :79-97 (update adds without churning),
 *   :99-123 (uncategorised factory rule), :125-142 (findBySubCategory),
 *   :144-159 (deleteEntity veto + clearData), :161-184 (removeAndDispose*),
 *   :186-203 (removeAndDisposeAll slice-copy), :205-236 (UPDATE synthesis).
 * - YNAB4 MonthlySubCategoryBudgetList behavior :28-34 (deleteEntity veto),
 *   :39-54 (update add/remove), :82-109 (findBySubCategory/removeAndDispose*).
 *
 * Mapping: no leaf-entity store exists here — the SQLite layer owns rows, so
 * entity-list update/remove/dispose semantics are N/A with reason per test.
 * Applicable analogues: adding/removing categories (or their assignments and
 * transactions) then recomputing diffuses into GroupRow/CatRow sums, lookups
 * resolve CatRows by category id, and assignment/transaction edits synthesize
 * the UPDATE old/new-value diffusion the oracle observes as events.
 *
 * Amounts: integer cents strings. Oracle float dollars adapt ×100
 * (e.g. oracle `budgeted = 100` → `"10000"`).
 */
import { describe, expect, it } from "vitest";
import {
  computeBudget,
  invalidateBudgetIndex,
} from "../src/budget-engine.js";
import type { BudgetData, Category, CategoryGroup } from "../src/types.js";

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

function makeGroup(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Everyday",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    groupId: 1,
    name: "Groceries",
    sort: 0,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...overrides,
  };
}

/** Oracle sub-list: master "Everyday" with Groceries + Dining leaves. */
function twoCatData(): BudgetData {
  return {
    ...emptyData(),
    groups: [makeGroup({ id: 1, name: "Everyday" })],
    categories: [
      makeCategory({ id: 1, groupId: 1, name: "Groceries", sort: 0 }),
      makeCategory({ id: 2, groupId: 1, name: "Dining", sort: 1 }),
    ],
    assignments: [
      { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
      { id: 2, categoryId: 2, month: "2026-01", amount: "5000" },
    ],
    transactions: [],
    recurring: [],
  };
}

describe("oracle B1 sub-list aggregation (MonthlySubCategoryBudgetList)", () => {
  it("removing a category drops its leaf row and its sums", () => {
    // Oracle ynab4-modern/...:61-77; YNAB4 MonthlySubCategoryBudgetList:39-54.
    // N/A: no leaf list with dispose here (SQLite owns rows); applicable
    // analogue: update-with-fewer-categories then recompute.
    const data = twoCatData();
    expect(computeBudget(data, "2026-01").groups[0]!.rows.length).toBe(2);
    data.categories = data.categories.filter((c) => c.id !== 2);
    data.assignments = data.assignments.filter((a) => a.categoryId !== 2);
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.rows.length).toBe(1);
    expect(result.groups[0]!.rows[0]!.category.id).toBe(1);
    expect(result.groups[0]!.assigned).toBe(10000);
  });

  it("adding a category adds a row without disturbing existing rows", () => {
    // Oracle ynab4-modern/...:79-97 (existing instance retained = identity).
    // Identity retention is N/A (rows are rebuilt per compute); applicable
    // analogue: existing rows keep values and order, the new row appears.
    const data = twoCatData();
    const before = computeBudget(data, "2026-01").groups[0]!.rows.map((r) => [
      r.category.id,
      r.assigned,
      r.available,
    ]);
    data.categories.push(makeCategory({ id: 3, groupId: 1, name: "Extra", sort: 2 }));
    data.assignments.push({ id: 3, categoryId: 3, month: "2026-01", amount: "2500" });
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.rows.length).toBe(3);
    expect(result.groups[0]!.rows.slice(0, 2).map((r) => [
      r.category.id,
      r.assigned,
      r.available,
    ])).toEqual(before);
    const added = result.groups[0]!.rows.find((r) => r.category.id === 3)!;
    expect(added.assigned).toBe(2500);
    expect(added.available).toBe(2500);
  });

  it("uncategorised positive rows are income, not outflow", () => {
    // Oracle ynab4-modern/...:99-123 (uncategorised-iff-parent factory rule).
    // N/A with reason: no Uncategorised leaf subclass exists here; applicable
    // analogue: uncategorised positive rows aggregate into totalIncome and
    // never into a category outflow.
    const data: BudgetData = {
      ...twoCatData(),
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-15", payee: "Payroll", memo: "", amount: "200000", status: "c", isIncome: true },
      ],
    };
    const result = computeBudget(data, "2026-01");
    expect(result.totalIncome).toBe(200000);
    expect(result.groups[0]!.outflow).toBe(0);
    expect(result.tbb).toBe(200000 - 15000);
  });

  it("findBySubCategory analogue resolves by category id and misses to undefined", () => {
    // Oracle ynab4-modern/...:125-142; YNAB4 MonthlySubCategoryBudgetList:82-88.
    const data = twoCatData();
    const result = computeBudget(data, "2026-01");
    const rows = result.groups[0]!.rows;
    expect(rows.find((r) => r.category.id === 1)!.assigned).toBe(10000);
    expect(rows.find((r) => r.category.id === 2)).toBe(rows[1]);
    expect(rows.find((r) => r.category.id === 999)).toBeUndefined();
  });

  it("zeroing a category clears its contribution while the row remains", () => {
    // Oracle ynab4-modern/...:144-159; YNAB4 MonthlySubCategoryBudgetList:28-34.
    // N/A with reason: no deleteEntity veto — deletes live in the SQLite
    // store, not an entity list; applicable analogue: clearing a category's
    // assignment (clearData) zeroes its sums while the row stays a member.
    const data = twoCatData();
    data.assignments = data.assignments.filter((a) => a.categoryId !== 1);
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.rows.length).toBe(2);
    const cleared = result.groups[0]!.rows.find((r) => r.category.id === 1)!;
    expect(cleared.assigned).toBe(0);
    expect(cleared.available).toBe(0);
    expect(result.groups[0]!.assigned).toBe(5000);
  });

  it("removing categories one by one shrinks sums in order", () => {
    // Oracle ynab4-modern/...:161-184 (removeAndDispose* return values).
    // Return-value/dispose semantics are N/A (no entity disposal); applicable
    // analogue: each removal recomputes smaller totals.
    const data = twoCatData();
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(15000);
    data.categories = data.categories.filter((c) => c.id !== 1);
    data.assignments = data.assignments.filter((a) => a.categoryId !== 1);
    invalidateBudgetIndex(data);
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(5000);
    data.categories = [];
    data.assignments = [];
    invalidateBudgetIndex(data);
    const drained = computeBudget(data, "2026-01");
    expect(drained.groups[0]!.rows).toEqual([]);
    expect(drained.groups[0]!.assigned).toBe(0);
    expect(drained.groups[0]!.available).toBe(0);
  });

  it("clearing all categories over a slice-copy drains every row", () => {
    // Oracle ynab4-modern/...:186-203 (removeAndDisposeAll slice-copy).
    const data = twoCatData();
    const ids = data.categories.map((c) => c.id);
    data.categories = data.categories.filter((c) => !ids.includes(c.id));
    data.assignments = [];
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.rows).toEqual([]);
    expect(result.totalAssigned).toBe(0);
  });

  it("assignment and outflow edits diffuse as UPDATE old/new values", () => {
    // Oracle ynab4-modern/...:205-236 (UPDATE synthesis: budgeted 0→100 moves
    // balance 0→100). Re-emission is N/A (no event layer); applicable
    // analogue: the recomputed row carries the new value with the exact delta.
    // FORK: outflow attribution is exact-only matching on categoryId.
    const data = twoCatData();
    const before = computeBudget(data, "2026-01").groups[0]!.rows.find(
      (r) => r.category.id === 1,
    )!;
    expect([before.assigned, before.available]).toEqual([10000, 10000]);
    data.assignments = data.assignments.map((a) =>
      a.categoryId === 1 ? { ...a, amount: "20000" } : a,
    );
    data.transactions = [
      { id: 1, accountId: 1, categoryId: 1, date: "2026-01-10", payee: "", memo: "", amount: "-3000", status: "c" },
    ];
    invalidateBudgetIndex(data);
    const after = computeBudget(data, "2026-01").groups[0]!.rows.find(
      (r) => r.category.id === 1,
    )!;
    // budgeted 10000→20000 and spent 0→3000: available 10000→17000.
    expect([after.assigned, after.outflow, after.available]).toEqual([20000, -3000, 17000]);
    expect(after.available - before.available).toBe(7000);
  });
});
