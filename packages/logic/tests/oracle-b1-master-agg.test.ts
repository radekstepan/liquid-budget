/**
 * oracle-b1-master-agg.test.ts
 *
 * Oracle port: master-category aggregation mapped through `computeBudget`.
 *
 * Sources (12 + 9 tests):
 * - ynab4-modern/packages/domain/src/MonthlyMasterCategoryBudget.test.ts:59-74 (id/entity type),
 *   :76-96 (seed + aggregate sums), :98-112 (carried-only-AffectsBuffer),
 *   :114-128 (fast-path non-negative diffs), :130-145 (rescan on negative endpoint),
 *   :147-160 (rescan on handling change), :162-180 (ADD/REMOVE recalc),
 *   :182-193 (findOrCreate idempotence), :195-219 (lastSubCategoryBudgetEvent only),
 *   :221-235 (zeroOut cascade), :237-255 (dispose detach), :257-271 (start/stopListening gate).
 * - ynab4-modern/packages/domain/src/MonthlyMasterCategoryBudgetList.test.ts:62-79 (OUTFLOW-only,
 *   internal skip), :81-98 (Uncategorised factory), :100-127 (rename remove+add),
 *   :129-152 (vanished/non-OUTFLOW removal), :154-170 (find), :172-189 (findSubCategoryBudget),
 *   :191-215 (removeAndDispose*), :217-234 (listen fan-out), :236-248 (monthlyBudget/date).
 * - YNAB4 MonthlyMasterCategoryBudget behavior :20-26 (BINDABLE_* ids), :38-44 (totals),
 *   :67/:95-100 (start/stopListening), :107-157 (total getters), :199-210 (fast-path diffs).
 * - YNAB4 MonthlyMasterCategoryBudgetList behavior :46-74 (update rules),
 *   :112-127 (find/findSubCategoryBudget).
 *
 * Mapping: no per-master entity exists here — aggregation is emulated via
 * `computeBudget` GroupRow sums (assigned/outflow/available); the carried-only-
 * AffectsBuffer core maps to the `overspentPrevious` analogue (derived from
 * carryover/available with `overspendCarriesOver=false`), the UPDATE fast path
 * vs rescan maps to repeated-`computeBudget` stability plus incremental
 * assignment diffusion, findOrCreate idempotence maps to `buildBudgetIndex`
 * caching / `getMonthsWithData`, zeroOut maps to zero assignments, and dispose
 * maps to `invalidateBudgetIndex`.
 *
 * Amounts: integer cents strings. Oracle float dollars adapt ×100
 * (e.g. oracle `budgeted = 100` → `"10000"`).
 */
import { describe, expect, it } from "vitest";
import {
  buildBudgetIndex,
  computeBudget,
  getMonthsWithData,
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

/** Oracle MM budget: master "Everyday" with Groceries + Dining leaves. */
function twoCatData(): BudgetData {
  return {
    ...emptyData(),
    groups: [makeGroup({ id: 1, name: "Everyday" })],
    categories: [
      makeCategory({ id: 1, groupId: 1, name: "Groceries", sort: 0 }),
      makeCategory({ id: 2, groupId: 1, name: "Dining", sort: 1 }),
    ],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

describe("oracle B1 master aggregation (MonthlyMasterCategoryBudget)", () => {
  it("group identity replaces the MMCB id/entity-type layer", () => {
    // Oracle ynab4-modern/...:59-74; YNAB4 MonthlyMasterCategoryBudget:20-26.
    // N/A: no MMCB entity or entityId exists here; applicable analogue: groups
    // keep identity (id/name) and sort order through computeBudget.
    const data: BudgetData = {
      ...twoCatData(),
      groups: [
        makeGroup({ id: 2, name: "Bills", sort: 1 }),
        makeGroup({ id: 1, name: "Everyday", sort: 0 }),
      ],
    };
    const result = computeBudget(data, "2026-01");
    expect(result.groups.map((g) => g.group.name)).toEqual(["Everyday", "Bills"]);
    expect(result.groups[0]!.group.id).toBe(1);
  });

  it("seeds one row per category and aggregates assigned/outflow/available", () => {
    // Oracle ynab4-modern/...:76-96 (150 budgeted, 40 spent, 110 balance).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "5000" },
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2026-01-10", payee: "", memo: "", amount: "-3000", status: "c" },
        { id: 2, accountId: 1, categoryId: 2, date: "2026-01-10", payee: "", memo: "", amount: "-1000", status: "c" },
      ],
    };
    const result = computeBudget(data, "2026-01");
    // FORK: outflow attribution is exact-only matching on categoryId.
    const group = result.groups[0]!;
    expect(group.rows.length).toBe(2);
    expect(group.assigned).toBe(15000);
    expect(group.outflow).toBe(-4000);
    expect(group.available).toBe(11000);
  });

  it("carries only negative AffectsBuffer balances into overspentPrevious", () => {
    // Oracle ynab4-modern/...:98-112; YNAB4 MonthlyMasterCategoryBudget:150-157.
    // Groceries overspent -25 (default AffectsBuffer) feeds next-month TBB;
    // Dining overspent -10 with Confined handling carries as a negative balance.
    const data: BudgetData = {
      ...twoCatData(),
      categories: [
        makeCategory({ id: 1, groupId: 1, name: "Groceries", sort: 0 }),
        makeCategory({ id: 2, groupId: 1, name: "Dining", sort: 1, overspendCarriesOver: true }),
      ],
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2026-01-10", payee: "", memo: "", amount: "-2500", status: "c" },
        { id: 2, accountId: 1, categoryId: 2, date: "2026-01-10", payee: "", memo: "", amount: "-1000", status: "c" },
      ],
    };
    const jan = computeBudget(data, "2026-01");
    expect(jan.groups[0]!.available).toBe(-3500);
    const feb = computeBudget(data, "2026-02");
    // Only the AffectsBuffer (-2500) leaf is carried as overspend; the Confined
    // leaf carries its own -1000 balance forward instead.
    expect(feb.overspentPrevious).toBe(2500);
    const dining = feb.groups[0]!.rows.find((r) => r.category.id === 2)!;
    expect(dining.carryoverIn).toBe(-1000);
    const groceries = feb.groups[0]!.rows.find((r) => r.category.id === 1)!;
    expect(groceries.carryoverIn).toBe(0);
  });

  it("repeated computeBudget is stable and incremental assignment diffuses", () => {
    // Oracle ynab4-modern/...:114-128 (fast-path diffs, non-negative endpoints).
    // UPDATE fast path vs rescan analogue: recompute is idempotent, and a
    // +100 assignment diffuses exactly into assigned/available.
    const data = twoCatData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }];
    const first = computeBudget(data, "2026-01");
    const second = computeBudget(data, "2026-01");
    expect(second).toEqual(first);
    expect(first.groups[0]!.available).toBe(10000);
    data.assignments.push({ id: 2, categoryId: 2, month: "2026-01", amount: "3000" });
    invalidateBudgetIndex(data);
    const third = computeBudget(data, "2026-01");
    expect(third.groups[0]!.available).toBe(13000);
    expect(third.groups[0]!.assigned).toBe(13000);
  });

  it("adding an overspending transaction recomputes totals (rescan analogue)", () => {
    // Oracle ynab4-modern/...:130-145 (negative endpoint forces full rescan).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "2000" },
      ],
    };
    expect(computeBudget(data, "2026-01").groups[0]!.available).toBe(12000);
    data.transactions = [
      { id: 1, accountId: 1, categoryId: 1, date: "2026-01-10", payee: "", memo: "", amount: "-15000", status: "c" },
    ];
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.outflow).toBe(-15000);
    expect(result.groups[0]!.available).toBe(-3000);
    const feb = computeBudget(data, "2026-02");
    expect(feb.overspentPrevious).toBe(5000);
  });

  it("flipping the overspend handling flag recomputes carried overspend", () => {
    // Oracle ynab4-modern/...:147-160 (handling change forces full rescan).
    const data: BudgetData = {
      ...twoCatData(),
      transactions: [
        { id: 1, accountId: 1, categoryId: 1, date: "2026-01-10", payee: "", memo: "", amount: "-4000", status: "c" },
      ],
    };
    expect(computeBudget(data, "2026-02").overspentPrevious).toBe(4000);
    data.categories = [
      makeCategory({ id: 1, groupId: 1, name: "Groceries", sort: 0, overspendCarriesOver: true }),
      makeCategory({ id: 2, groupId: 1, name: "Dining", sort: 1 }),
    ];
    invalidateBudgetIndex(data);
    const feb = computeBudget(data, "2026-02");
    expect(feb.overspentPrevious).toBe(0);
    expect(feb.groups[0]!.rows.find((r) => r.category.id === 1)!.carryoverIn).toBe(-4000);
  });

  it("adding and removing assignments/transactions recalculates totals", () => {
    // Oracle ynab4-modern/...:162-180 (ADD and REMOVE recalc).
    const data = twoCatData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }];
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(10000);
    // ADD: extra leaf assignment diffuses into the group total.
    data.assignments.push({ id: 2, categoryId: 2, month: "2026-01", amount: "2500" });
    invalidateBudgetIndex(data);
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(12500);
    // REMOVE: dropping it restores the prior total.
    data.assignments = data.assignments.filter((a) => a.id !== 2);
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.assigned).toBe(10000);
    expect(result.groups[0]!.available).toBe(10000);
  });

  it("index build is idempotent across repeated computes", () => {
    // Oracle ynab4-modern/...:182-193 (findOrCreate idempotence).
    // findOrCreate analogue: buildBudgetIndex caching / getMonthsWithData.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    data.budgetIndex = buildBudgetIndex(data);
    const monthsBefore = getMonthsWithData(data);
    const first = computeBudget(data, "2026-01");
    const second = computeBudget(data, "2026-01");
    expect(second).toEqual(first);
    expect(getMonthsWithData(data)).toEqual(monthsBefore);
    expect(first.groups[0]!.assigned).toBe(10000);
  });

  it("computeBudget is pure: input data is never mutated", () => {
    // Oracle ynab4-modern/...:195-219 (only lastSubCategoryBudgetEvent notifies;
    // totals assign silently). N/A: no observable layer here; applicable
    // analogue: computation has no silent side effects on its input.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    const snapshot = JSON.parse(JSON.stringify({ ...data, budgetIndex: undefined })) as unknown;
    computeBudget(data, "2026-01");
    expect(JSON.parse(JSON.stringify({ ...data, budgetIndex: undefined })) as unknown).toEqual(snapshot);
  });

  it("zeroing assignments zeroes group totals", () => {
    // Oracle ynab4-modern/...:221-235 (zeroOut cascades to leaves).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "5000" },
      ],
    };
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(15000);
    data.assignments = [];
    invalidateBudgetIndex(data);
    const result = computeBudget(data, "2026-01");
    expect(result.groups[0]!.assigned).toBe(0);
    expect(result.groups[0]!.available).toBe(0);
    expect(result.groups[0]!.rows.every((r) => r.assigned === 0)).toBe(true);
  });

  it("invalidateBudgetIndex forces a fresh walk with equal results", () => {
    // Oracle ynab4-modern/...:237-255 (dispose detaches listeners).
    // dispose analogue: dropping the cached index; later recomputes match.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    const before = computeBudget(data, "2026-01");
    invalidateBudgetIndex(data);
    const after = computeBudget(data, "2026-01");
    expect(after).toEqual(before);
    // Idempotent: invalidating twice is safe.
    invalidateBudgetIndex(data);
    invalidateBudgetIndex(data);
    expect(computeBudget(data, "2026-01")).toEqual(before);
  });

  it("cached index serves repeated months until invalidated", () => {
    // Oracle ynab4-modern/...:257-271 (stop/startListening gates recalc).
    // N/A: no listener gate here; applicable analogue: the shared index cache
    // serves repeats, and invalidation re-walks with fresh values.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    data.budgetIndex = buildBudgetIndex(data);
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(10000);
    data.assignments.push({ id: 2, categoryId: 1, month: "2026-01", amount: "5000" });
    invalidateBudgetIndex(data);
    data.budgetIndex = buildBudgetIndex(data);
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(15000);
  });
});

describe("oracle B1 master-list aggregation (MonthlyMasterCategoryBudgetList)", () => {
  it("every group renders: no inflow/internal filtering exists", () => {
    // Oracle ynab4-modern/...:62-79; YNAB4 MonthlyMasterCategoryBudgetList:46-74.
    // N/A with reason: BudgetData groups carry no OUTFLOW/INFLOW type flag and
    // there is no internal-master entity, so nothing is skipped — every group
    // (even empty ones) renders with zeroed sums.
    const data: BudgetData = {
      ...emptyData(),
      groups: [
        makeGroup({ id: 1, name: "Everyday", sort: 0 }),
        makeGroup({ id: 2, name: "Income", sort: 1 }),
      ],
      categories: [makeCategory({ id: 1, groupId: 1 })],
    };
    const result = computeBudget(data, "2026-01");
    expect(result.groups.length).toBe(2);
    expect(result.groups[1]!.rows).toEqual([]);
    expect(result.groups[1]!.assigned).toBe(0);
    expect(result.groups[1]!.available).toBe(0);
  });

  it("uncategorised income aggregates into totalIncome", () => {
    // Oracle ynab4-modern/...:81-98 (Uncategorised subclass factory).
    // N/A with reason: no Uncategorised master/leaf entities exist here;
    // applicable analogue: uncategorised positive rows are income.
    // FORK: income-month superset — incomeMonth retargets the budget month.
    const data: BudgetData = {
      ...twoCatData(),
      transactions: [
        { id: 1, accountId: 1, categoryId: null, date: "2026-01-15", payee: "Payroll", memo: "", amount: "200000", status: "c", isIncome: true, incomeMonth: "2026-02" },
      ],
    };
    expect(computeBudget(data, "2026-01").totalIncome).toBe(0);
    const feb = computeBudget(data, "2026-02");
    expect(feb.totalIncome).toBe(200000);
    expect(feb.incomeFromPast).toBe(200000);
  });

  it("renaming a group preserves its aggregation", () => {
    // Oracle ynab4-modern/...:100-127 (rename = remove + add by NAME).
    // Name matching is N/A: aggregation keys on stable ids, so a rename keeps
    // every sum intact instead of disposing and rebuilding the budget.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    const before = computeBudget(data, "2026-01");
    data.groups = [makeGroup({ id: 1, name: "Everyday Expenses", sort: 0 })];
    invalidateBudgetIndex(data);
    const after = computeBudget(data, "2026-01");
    expect(after.groups[0]!.group.name).toBe("Everyday Expenses");
    expect(after.groups[0]!.assigned).toBe(before.groups[0]!.assigned);
    expect(after.groups[0]!.available).toBe(before.groups[0]!.available);
  });

  it("removing a group drops its budget; moving a category re-homes its sums", () => {
    // Oracle ynab4-modern/...:129-152 (vanished master / non-OUTFLOW removal).
    const data: BudgetData = {
      ...emptyData(),
      groups: [
        makeGroup({ id: 1, name: "Everyday", sort: 0 }),
        makeGroup({ id: 2, name: "Bills", sort: 1 }),
      ],
      categories: [
        makeCategory({ id: 1, groupId: 1, name: "Groceries", sort: 0 }),
        makeCategory({ id: 2, groupId: 2, name: "Rent", sort: 0 }),
      ],
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "50000" },
      ],
    };
    expect(computeBudget(data, "2026-01").groups.length).toBe(2);
    // Vanished master analogue: drop the Bills group and its category.
    data.groups = data.groups.filter((g) => g.id !== 2);
    data.categories = data.categories.filter((c) => c.id !== 2);
    data.assignments = data.assignments.filter((a) => a.categoryId !== 2);
    invalidateBudgetIndex(data);
    const dropped = computeBudget(data, "2026-01");
    expect(dropped.groups.length).toBe(1);
    expect(dropped.totalAssigned).toBe(10000);
    // Re-home Groceries into a new group: its sums travel with it.
    data.groups = [
      makeGroup({ id: 1, name: "Everyday", sort: 0 }),
      makeGroup({ id: 3, name: "Food", sort: 1 }),
    ];
    data.categories = [makeCategory({ id: 1, groupId: 3, name: "Groceries", sort: 0 })];
    invalidateBudgetIndex(data);
    const moved = computeBudget(data, "2026-01");
    expect(moved.groups[1]!.assigned).toBe(10000);
    expect(moved.groups[1]!.available).toBe(10000);
  });

  it("group rows resolve by id and miss to undefined", () => {
    // Oracle ynab4-modern/...:154-170 (find / findById / null on null).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    const result = computeBudget(data, "2026-01");
    expect(result.groups.find((g) => g.group.id === 1)).toBe(result.groups[0]);
    expect(result.groups.find((g) => g.group.id === 999)).toBeUndefined();
  });

  it("category rows resolve through their parent group", () => {
    // Oracle ynab4-modern/...:172-189 (findSubCategoryBudget via parent master).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "5000" },
      ],
    };
    const result = computeBudget(data, "2026-01");
    const master = result.groups.find((g) => g.group.id === 1)!;
    expect(master.rows.find((r) => r.category.id === 1)!.assigned).toBe(10000);
    expect(master.rows.find((r) => r.category.id === 2)!.assigned).toBe(5000);
    expect(master.rows.find((r) => r.category.id === 999)).toBeUndefined();
  });

  it("removing categories drains rows; removing all drains the group", () => {
    // Oracle ynab4-modern/...:191-215 (removeAndDispose / removeAndDisposeAll).
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 2, month: "2026-01", amount: "5000" },
      ],
    };
    data.categories = data.categories.filter((c) => c.id !== 1);
    data.assignments = data.assignments.filter((a) => a.categoryId !== 1);
    invalidateBudgetIndex(data);
    const one = computeBudget(data, "2026-01");
    expect(one.groups[0]!.rows.length).toBe(1);
    expect(one.groups[0]!.assigned).toBe(5000);
    data.categories = [];
    data.assignments = [];
    invalidateBudgetIndex(data);
    const drained = computeBudget(data, "2026-01");
    expect(drained.groups[0]!.rows).toEqual([]);
    expect(drained.groups[0]!.assigned).toBe(0);
    expect(drained.totalAssigned).toBe(0);
  });

  it("cache invalidation re-walks the full group list", () => {
    // Oracle ynab4-modern/...:217-234 (stop/startListening fan-out).
    // N/A: no listener fan-out here; applicable analogue: the shared index
    // cache serves every group until invalidateBudgetIndex forces a re-walk.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [{ id: 1, categoryId: 1, month: "2026-01", amount: "10000" }],
    };
    data.budgetIndex = buildBudgetIndex(data);
    const cached = computeBudget(data, "2026-01");
    expect(cached.groups[0]!.assigned).toBe(10000);
    invalidateBudgetIndex(data);
    data.assignments.push({ id: 2, categoryId: 2, month: "2026-01", amount: "7000" });
    const rewalked = computeBudget(data, "2026-01");
    expect(rewalked.groups[0]!.assigned).toBe(17000);
    expect(rewalked.groups[0]!.available).toBe(17000);
  });

  it("the month parameter selects the budget; months list from data", () => {
    // Oracle ynab4-modern/...:236-248 (monthlyBudget/date accessors).
    // N/A: no list entity with assignable month here; applicable analogue:
    // computeBudget(data, month) scopes to that month.
    const data: BudgetData = {
      ...twoCatData(),
      assignments: [
        { id: 1, categoryId: 1, month: "2026-01", amount: "10000" },
        { id: 2, categoryId: 1, month: "2026-02", amount: "20000" },
      ],
    };
    expect(getMonthsWithData(data)).toEqual(["2026-01", "2026-02"]);
    expect(computeBudget(data, "2026-01").groups[0]!.assigned).toBe(10000);
    const feb = computeBudget(data, "2026-02");
    expect(feb.groups[0]!.rows.find((r) => r.category.id === 1)!.assigned).toBe(20000);
    expect(feb.groups[0]!.rows.find((r) => r.category.id === 1)!.carryoverIn).toBe(10000);
  });
});
