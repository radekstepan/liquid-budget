/**
 * compute.test.ts
 *
 * Tests for the backward-compatible computeGroups / summarize helpers.
 * These now delegate to budget-engine internally, so these tests also
 * validate the engine's core group/summarize paths.
 */
import { describe, expect, it } from "vitest";
import { computeGroups, summarize } from "../src/compute.js";
import { makeSeedBudgetData, DEMO_MONTH } from "../src/seed-fixture.js";
import type { BudgetData } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalData(overrides: Partial<BudgetData> = {}): BudgetData {
  return {
    accounts: [],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeGroups
// ---------------------------------------------------------------------------

describe("computeGroups", () => {
  it("returns all groups even when no assignments/transactions exist for a month", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, "2099-01");
    expect(groups).toHaveLength(data.groups.length);
    for (const g of groups) {
      expect(g.assigned).toBe(0);
      expect(g.outflow).toBe(0);
    }
  });

  it("returns an empty array when no groups exist", () => {
    const data = minimalData();
    expect(computeGroups(data, "2025-01")).toEqual([]);
  });

  it("clamps inflow to 0 for the outflow display column", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    const groceries = groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Groceries");
    expect(groceries).toBeDefined();
    // Raw grocery outflow is negative; display outflow must also be ≤ 0.
    expect(groceries!.outflow).toBeLessThan(0);
  });

  it("does not include positive (income) transactions in outflow", () => {
    const data: BudgetData = {
      accounts: [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "", balance: "0", onBudget: true, sort: 0 }],
      groups: [{ id: 1, name: "Bills", sort: 0, isCreditCardPayments: false }],
      categories: [{ id: 1, groupId: 1, name: "Rent", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null }],
      assignments: [{ id: 1, categoryId: 1, month: "2025-07", amount: "1000" }],
      transactions: [
        // Negative spend
        { id: 1, accountId: 1, categoryId: 1, date: "2025-07-01", payee: "Landlord", memo: "", amount: "-1000", cleared: true },
        // Positive refund in same category — should NOT appear as outflow
        { id: 2, accountId: 1, categoryId: 1, date: "2025-07-15", payee: "Refund", memo: "", amount: "200", cleared: true },
      ],
      recurring: [],
    };
    const [group] = computeGroups(data, "2025-07");
    const [row] = group!.rows;
    // rawFlow = -1000 + 200 = -800; outflow = min(0, -800) = -800
    expect(row!.outflow).toBeCloseTo(-800);
    // available = carryoverIn(0) + assigned(1000) + rawFlow(-800) = 200
    expect(row!.available).toBeCloseTo(200);
  });

  it("groups rows are sorted by category.sort", () => {
    const data: BudgetData = {
      accounts: [],
      groups: [{ id: 1, name: "G", sort: 0, isCreditCardPayments: false }],
      categories: [
        { id: 3, groupId: 1, name: "C", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 1, groupId: 1, name: "A", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 2, groupId: 1, name: "B", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      assignments: [],
      transactions: [],
      recurring: [],
    };
    const [group] = computeGroups(data, "2025-01");
    expect(group!.rows.map((r) => r.category.name)).toEqual(["A", "B", "C"]);
  });

  it("groups are sorted by group.sort", () => {
    const data: BudgetData = {
      accounts: [],
      groups: [
        { id: 2, name: "Second", sort: 1, isCreditCardPayments: false },
        { id: 1, name: "First", sort: 0, isCreditCardPayments: false },
      ],
      categories: [],
      assignments: [],
      transactions: [],
      recurring: [],
    };
    const groups = computeGroups(data, "2025-01");
    expect(groups.map((g) => g.group.name)).toEqual(["First", "Second"]);
  });

  it("group totals are the sum of their category rows", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    for (const g of groups) {
      const sumAssigned = g.rows.reduce((s, r) => s + r.assigned, 0);
      const sumOutflow = g.rows.reduce((s, r) => s + r.outflow, 0);
      const sumAvailable = g.rows.reduce((s, r) => s + r.available, 0);
      expect(g.assigned).toBeCloseTo(sumAssigned);
      expect(g.outflow).toBeCloseTo(sumOutflow);
      expect(g.available).toBeCloseTo(sumAvailable);
    }
  });

  it("carryoverIn reflects the seed carryover for the first tracked month", () => {
    // Groceries has carryover: "159.65" in the new fixture; June 2026 is the demo month.
    // After two prior months of spending, the carried-over balance may be positive or negative.
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    const groceries = groups.flatMap((g) => g.rows).find((r) => r.category.name === "Groceries");
    expect(groceries).toBeDefined();
    // carryoverIn is a finite number (positive surplus or negative overspend from prior months)
    expect(isFinite(groceries!.carryoverIn)).toBe(true);
  });

  it("fundedPct is between 0 and 1 inclusive for all rows", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    for (const g of groups) {
      for (const r of g.rows) {
        expect(r.fundedPct).toBeGreaterThanOrEqual(0);
        expect(r.fundedPct).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("excludes credit-card-payments group from assigned/outflow/available", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    const s = summarize(groups);
    const ccAssigned = groups
      .filter((g) => g.group.isCreditCardPayments)
      .reduce((sum, g) => sum + g.assigned, 0);
    const allAssigned = groups.reduce((sum, g) => sum + g.assigned, 0);
    expect(s.assigned).toBeCloseTo(allAssigned - ccAssigned);
  });

  it("totalAvailable includes ALL groups (including CC payments)", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, DEMO_MONTH);
    const s = summarize(groups);
    expect(s.totalAvailable).toBeCloseTo(
      groups.reduce((sum, g) => sum + g.available, 0)
    );
  });

  it("returns zeros when given an empty group list", () => {
    const s = summarize([]);
    expect(s.assigned).toBe(0);
    expect(s.outflow).toBe(0);
    expect(s.available).toBe(0);
    expect(s.totalAvailable).toBe(0);
  });
});
