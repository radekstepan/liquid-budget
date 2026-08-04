import { describe, expect, it, beforeEach } from "vitest";
import { getBudgetData, isSeeded } from "../src/queries/budget.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("budget queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("getBudgetData issues 7 select queries in parallel", async () => {
    mock.respondWith("select:*", []);
    const callsBefore = mock.calls.length;
    await getBudgetData(mock.db);
    const newCalls = mock.calls.slice(callsBefore);
    const selects = newCalls.filter((c) => c.op === "select");
    expect(selects).toHaveLength(7);
    const tables = selects.map((c) => c.table).sort();
    expect(tables).toEqual(
      [
        "accounts",
        "assignments",
        "category_groups",
        "categories",
        "recurring",
        "recurring_sub_transactions",
        "transactions",
      ].sort()
    );
  });

  it("getBudgetData returns the selected rows in the BudgetData shape", async () => {
    mock.respondWith("select:accounts", [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "100.00", onBudget: true, sort: 0 }]);
    mock.respondWith("select:category_groups", [{ id: 1, name: "G", sort: 0, isCreditCardPayments: false }]);
    mock.respondWith("select:categories", []);
    mock.respondWith("select:assignments", []);
    mock.respondWith("select:transactions", []);
    mock.respondWith("select:recurring", []);
    mock.respondWith("select:recurring_sub_transactions", []);

    const data = await getBudgetData(mock.db);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]!.name).toBe("Checking");
    expect(data.groups).toHaveLength(1);
  });

  it("isSeeded issues a select count query", async () => {
    const result = await isSeeded(mock.db);
    expect(result).toBe(false);
    const selectCalls = mock.calls.filter((c) => c.op === "select");
    expect(selectCalls.length).toBeGreaterThanOrEqual(1);
  });
});
