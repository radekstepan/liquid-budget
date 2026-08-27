import { describe, expect, it } from "vitest";
import * as server from "../src/index.js";

describe("server package public surface", () => {
  it("re-exports query functions", () => {
    expect(typeof server.getBudgetData).toBe("function");
    expect(typeof server.isSeeded).toBe("function");
    expect(typeof server.upsertAssignment).toBe("function");
    expect(typeof server.createAccount).toBe("function");
    expect(typeof server.createCategory).toBe("function");
    expect(typeof server.createCategoryGroup).toBe("function");
    expect(typeof server.createTransaction).toBe("function");
    expect(typeof server.createRecurring).toBe("function");
    expect(typeof server.deleteRecurring).toBe("function");
    expect(typeof server.deleteTransaction).toBe("function");
    expect(typeof server.deleteCategory).toBe("function");
    expect(typeof server.deleteCategoryGroup).toBe("function");
    expect(typeof server.verifyBalanceIntegrity).toBe("function");
    expect(typeof server.recomputeAccountBalances).toBe("function");
  });

  it("re-exports seedDatabase, resetDatabase, resetAndSeedDatabase and DEMO_MONTH", () => {
    expect(typeof server.seedDatabase).toBe("function");
    expect(typeof server.resetDatabase).toBe("function");
    expect(typeof server.resetAndSeedDatabase).toBe("function");
    expect(server.DEMO_MONTH).toBe("2026-06");
  });

  it("re-exports drizzle client helpers", () => {
    expect(typeof server.createDb).toBe("function");
    expect(typeof server.openDb).toBe("function");
    expect(typeof server.getDefaultDb).toBe("function");
  });

  it("re-exports schema tables", () => {
    expect(server.accounts).toBeDefined();
    expect(server.categories).toBeDefined();
    expect(server.categoryGroups).toBeDefined();
    expect(server.assignments).toBeDefined();
    expect(server.transactions).toBeDefined();
    expect(server.recurring).toBeDefined();
  });
});
