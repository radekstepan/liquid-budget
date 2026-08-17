import { describe, expect, it, beforeEach } from "vitest";
import {
  CategoryError,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  renameCategoryGroup,
  updateCategory,
  updateCategoryGroupSort,
} from "../src/queries/categories.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("categories queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("createCategoryGroup", () => {
    it("inserts with auto-incremented sort", async () => {
      mock.respondWith("select:category_groups", [{ max: 4 }]);
      mock.respondWith("insert:category_groups", [{ id: 1, sort: 5 }]);
      const row = await createCategoryGroup(mock.db, { name: "Bills" });
      expect(row).toMatchObject({ id: 1, sort: 5 });
    });

    it("wraps the read-then-write in BEGIN/COMMIT (race fix)", async () => {
      mock.respondWith("select:category_groups", [{ max: 4 }]);
      mock.respondWith("insert:category_groups", [{ id: 1, sort: 5 }]);
      await createCategoryGroup(mock.db, { name: "Bills" });
      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls).not.toContain("ROLLBACK");
    });
  });

  describe("createCategory", () => {
    it("inserts with auto-incremented sort within the group", async () => {
      mock.respondWith("select:categories", [{ max: 2 }]);
      mock.respondWith("insert:categories", [{ id: 1, sort: 3 }]);
      const row = await createCategory(mock.db, { groupId: 1, name: "Test" });
      expect(row).toMatchObject({ id: 1, sort: 3 });
    });

    it("UNI-05 / BUG-02: stores carryover amount on category creation", async () => {
      mock.respondWith("select:categories", [{ max: 0 }]);
      mock.respondWith("insert:categories", [{ id: 2, name: "Savings Goal", carryover: 50000 }]);
      const row = await createCategory(mock.db, {
        groupId: 1,
        name: "Savings Goal",
        carryover: 50000,
      });
      expect(row).toMatchObject({ id: 2, name: "Savings Goal", carryover: 50000 });
    });

    it("wraps the read-then-write in BEGIN/COMMIT (race fix)", async () => {
      mock.respondWith("select:categories", [{ max: 2 }]);
      mock.respondWith("insert:categories", [{ id: 1, sort: 3 }]);
      await createCategory(mock.db, { groupId: 1, name: "Test" });
      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls).not.toContain("ROLLBACK");
    });
  });

  describe("renameCategoryGroup", () => {
    it("renames and returns the row", async () => {
      mock.respondWith("update:category_groups", [{ id: 1, name: "New" }]);
      const row = await renameCategoryGroup(mock.db, 1, "New");
      expect(row).toMatchObject({ name: "New" });
    });
  });

  describe("updateCategory", () => {
    it("sets only fields that are provided", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, { sort: 5 });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ sort: 5 });
    });

    it("explicit null goalTarget clears the goal", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, { goalTarget: null });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ goalTarget: null });
    });
  });

  describe("updateCategoryGroupSort", () => {
    it("sets the sort field", async () => {
      mock.respondWith("update:category_groups", [{ id: 1, sort: 7 }]);
      const row = await updateCategoryGroupSort(mock.db, 1, 7);
      expect(row).toMatchObject({ sort: 7 });
    });
  });

  describe("deleteCategory / deleteCategoryGroup", () => {
    it("deleteCategory deletes unreferenced category and assignments", async () => {
      mock.respondWith("select:categories", [{ id: 1, name: "Dining" }]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_subtransactions", []);

      await deleteCategory(mock.db, 1);
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls.map((c) => c.table)).toEqual(["assignments", "categories"]);
    });

    it("UNI-03 / F-03: throws 422 CategoryError if category has transactions and no moveToCategoryId", async () => {
      mock.respondWith("select:categories", [{ id: 1, name: "Dining" }]);
      mock.respondWith("select:transactions", [{ id: 10 }]);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_subtransactions", []);

      await expect(deleteCategory(mock.db, 1)).rejects.toMatchObject({
        status: 422,
        name: "CategoryError",
        message: /Category has 1 transaction\(s\)/,
      });
    });

    it("UNI-03 / F-03: rejects reassigning to self", async () => {
      mock.respondWith("select:categories", [{ id: 1, name: "Dining" }]);
      mock.respondWith("select:transactions", [{ id: 10 }]);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_subtransactions", []);

      await expect(deleteCategory(mock.db, 1, { moveToCategoryId: 1 })).rejects.toMatchObject({
        status: 400,
        name: "CategoryError",
        message: /Cannot reassign transactions to the category being deleted/,
      });
    });

    it("UNI-03 / F-03: reassigns transactions and recurring splits to moveToCategoryId", async () => {
      mock.respondWithNth("select:categories", 1, [{ id: 1, name: "Dining" }]);
      mock.respondWith("select:transactions", [{ id: 10 }]);
      mock.respondWith("select:recurring", [{ id: 20 }]);
      mock.respondWith("select:recurring_sub_transactions", [{ id: 30 }]);
      mock.respondWithNth("select:categories", 2, [{ id: 2, name: "Groceries" }]);

      await deleteCategory(mock.db, 1, { moveToCategoryId: 2 });
      const updateCalls = mock.calls.filter((c) => c.op === "update");
      expect(updateCalls.map((c) => c.table)).toEqual([
        "transactions",
        "recurring",
        "recurring_sub_transactions",
      ]);
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls.map((c) => c.table)).toEqual(["assignments", "categories"]);
    });

    it("deleteCategoryGroup deletes all categories within the group", async () => {
      mock.respondWith("select:categories", []);
      mock.respondWith("delete:category_groups", [{}]);
      await deleteCategoryGroup(mock.db, 1);
      expect(mock.calls.find((c) => c.op === "delete" && c.table === "category_groups")).toBeDefined();
    });
  });

  describe("transaction rollback on failure", () => {
    it("createCategoryGroup issues ROLLBACK when the insert throws", async () => {
      mock.respondWith("select:category_groups", [{ max: 4 }]);
      // Force the next insert to throw by wrapping the mock.
      const wrapped = throwOnNextInsert(mock, "category_groups");
      await expect(
        createCategoryGroup(wrapped.db, { name: "Boom" })
      ).rejects.toBeDefined();
      const sqls = wrapped.calls
        .filter((c) => c.op === "run")
        .map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
    });

    it("createCategory issues ROLLBACK when the insert throws", async () => {
      mock.respondWith("select:categories", [{ max: 2 }]);
      const wrapped = throwOnNextInsert(mock, "categories");
      await expect(
        createCategory(wrapped.db, { groupId: 1, name: "Boom" })
      ).rejects.toBeDefined();
      const sqls = wrapped.calls
        .filter((c) => c.op === "run")
        .map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
    });
  });
});

/**
 * Patch a MockDb so the next `insert:<tableName>` call throws
 * (mimicking a real FK / unique / NOT NULL violation). The mock's
 * call recorder and the `run` / `execute` recorders pass through
 * unchanged.
 */
function throwOnNextInsert(mock: ReturnType<typeof createMockDb>, tableName: string): ReturnType<typeof createMockDb> {
  const realInsert = (mock.db.insert as unknown as (t: unknown) => unknown);
  const NAME = Symbol.for("drizzle:Name");
  (mock.db as unknown as { insert: (t: unknown) => unknown }).insert = (t: unknown) => {
    const name = (t as Record<symbol, unknown>)[NAME] as string | undefined;
    if (name === tableName) {
      throw new Error(`synthetic ${tableName} insert failure`);
    }
    return realInsert(t);
  };
  return mock;
}
