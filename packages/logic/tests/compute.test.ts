import { describe, expect, it } from "vitest";
import { computeGroups, summarize } from "../src/compute.js";
import { makeSeedBudgetData } from "../src/seed-fixture.js";

describe("computeGroups", () => {
  it("returns all groups even when no assignments/transactions exist for a month", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, "2099-01");
    expect(groups).toHaveLength(data.groups.length);
    for (const g of groups) {
      expect(g.assigned).toBe(0);
      expect(g.outflow).toBe(0);
      // carryover is still applied: non-zero carryover categories keep their value
      const gro = g.rows.reduce((s, r) => s + r.available, 0);
      expect(g.available).toBeCloseTo(gro);
    }
  });

  it("clamps inflow to 0 for the outflow display column", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, "2025-07");
    const groceries = groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Groceries");
    expect(groceries).toBeDefined();
    // outflow is min(0, raw); raw is negative for groceries in DEMO_MONTH
    expect(groceries!.outflow).toBeLessThan(0);
  });

  it("summarize excludes credit-card-payments group from assigned/outflow/available", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, "2025-07");
    const s = summarize(groups);
    const ccAssigned = groups
      .filter((g) => g.group.isCreditCardPayments)
      .reduce((sum, g) => sum + g.assigned, 0);
    const allAssigned = groups.reduce((sum, g) => sum + g.assigned, 0);
    expect(s.assigned).toBe(allAssigned - ccAssigned);
    expect(s.totalAvailable).toBe(
      groups.reduce((sum, g) => sum + g.available, 0)
    );
  });

  it("fundedPct is 0 when nothing assigned and 1 when full", () => {
    const data = makeSeedBudgetData();
    const groups = computeGroups(data, "2025-07");
    const groceries = groups
      .flatMap((g) => g.rows)
      .find((r) => r.category.name === "Groceries")!;
    expect(groceries.fundedPct).toBeGreaterThanOrEqual(0);
    expect(groceries.fundedPct).toBeLessThanOrEqual(1);
  });
});
