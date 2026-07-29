import { describe, expect, it } from "vitest";
import { makeSeedBudgetData, DEMO_MONTH } from "../src/seed-fixture.js";

describe("seed fixture", () => {
  it("returns a fully-populated BudgetData", () => {
    const d = makeSeedBudgetData();
    expect(d.accounts.length).toBeGreaterThan(0);
    expect(d.groups.length).toBeGreaterThan(0);
    expect(d.categories.length).toBeGreaterThan(0);
    expect(d.assignments.length).toBeGreaterThan(0);
    expect(d.transactions.length).toBeGreaterThan(0);
    expect(d.recurring.length).toBeGreaterThan(0);
  });

  it("is internally consistent: every categoryId in assignments exists in categories", () => {
    const d = makeSeedBudgetData();
    const catIds = new Set(d.categories.map((c) => c.id));
    for (const a of d.assignments) {
      expect(catIds.has(a.categoryId)).toBe(true);
    }
  });

  it("credit-card categories link to credit accounts", () => {
    const d = makeSeedBudgetData();
    const ccGroup = d.groups.find((g) => g.isCreditCardPayments)!;
    const ccCats = d.categories.filter((c) => c.groupId === ccGroup.id);
    const ccAccountIds = new Set(
      d.accounts.filter((a) => a.kind === "credit").map((a) => a.id)
    );
    for (const c of ccCats) {
      expect(c.linkedAccountId).not.toBeNull();
      expect(ccAccountIds.has(c.linkedAccountId!)).toBe(true);
    }
  });

  it("DEMO_MONTH matches all seeded transactions and assignments", () => {
    const d = makeSeedBudgetData();
    expect(
      d.assignments.every((a) => a.month === DEMO_MONTH)
    ).toBe(true);
    expect(
      d.transactions.every((t) => t.date.startsWith(DEMO_MONTH))
    ).toBe(true);
  });
});
