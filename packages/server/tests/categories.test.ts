import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import {
  CategoryError,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  renameCategoryGroup,
  updateCategory,
  updateCategoryGroup,
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

  describe("updateCategoryGroup", () => {
    it("updates name only", async () => {
      mock.respondWith("update:category_groups", [{ id: 1, name: "Renamed" }]);
      const row = await updateCategoryGroup(mock.db, 1, { name: "Renamed" });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Renamed" });
      expect(row).toMatchObject({ name: "Renamed" });
    });

    it("updates sort only", async () => {
      mock.respondWith("update:category_groups", [{ id: 1, sort: 3 }]);
      const row = await updateCategoryGroup(mock.db, 1, { sort: 3 });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ sort: 3 });
      expect(row).toMatchObject({ sort: 3 });
    });

    it("updates both name and sort together", async () => {
      mock.respondWith("update:category_groups", [{ id: 1, name: "Renamed", sort: 3 }]);
      const row = await updateCategoryGroup(mock.db, 1, { name: "Renamed", sort: 3 });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Renamed", sort: 3 });
      expect(row).toMatchObject({ name: "Renamed", sort: 3 });
    });

    it("returns existing row if patch is empty", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Existing", sort: 2 }]);
      const row = await updateCategoryGroup(mock.db, 1, {});
      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall).toBeUndefined();
      expect(row).toMatchObject({ id: 1, name: "Existing", sort: 2 });
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

    it("UNI-20 / F-16: supports updating overspendCarriesOver flag", async () => {
      mock.respondWith("update:categories", [{ id: 1, overspendCarriesOver: true }]);
      await updateCategory(mock.db, 1, { overspendCarriesOver: true });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ overspendCarriesOver: true });
    });

    it("updates carryover to an amount", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, { carryover: 5000 });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ carryover: 5000 });
    });

    it("BUG-05: explicit 0 carryover resets carryover to 0", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, { carryover: 0 });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ carryover: 0 });
    });

    it("BUG-05: explicit null carryover clears carryover to 0", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, { carryover: null });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ carryover: 0 });
    });

    it("BUG-04: returns existing row if patch is empty", async () => {
      mock.respondWith("select:categories", [{ id: 1, name: "Groceries", sort: 2 }]);
      const row = await updateCategory(mock.db, 1, {});
      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall).toBeUndefined();
      expect(row).toMatchObject({ id: 1, name: "Groceries", sort: 2 });
    });

    it("BUG-19: does not overwrite goalTarget, carryover, or overspendCarriesOver when keys have undefined values", async () => {
      mock.respondWith("update:categories", [{ id: 1 }]);
      await updateCategory(mock.db, 1, {
        name: "Renamed",
        goalTarget: undefined,
        carryover: undefined,
        sort: undefined,
        overspendCarriesOver: undefined,
      });
      const set = mock.calls.find((c) => c.op === "update")?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Renamed" });
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

    it("deleteCategoryGroup returns early if group does not exist", async () => {
      mock.respondWith("select:category_groups", []);
      await deleteCategoryGroup(mock.db, 999);
      expect(mock.calls.find((c) => c.op === "run")).toBeUndefined();
      expect(mock.calls.find((c) => c.op === "delete")).toBeUndefined();
    });

    it("deleteCategoryGroup deletes empty group wrapped in BEGIN/COMMIT", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWith("select:categories", []);
      mock.respondWith("delete:category_groups", [{}]);
      await deleteCategoryGroup(mock.db, 1);
      expect(mock.calls.find((c) => c.op === "delete" && c.table === "category_groups")).toBeDefined();
      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls).not.toContain("ROLLBACK");
    });

    it("deleteCategoryGroup deletes group with empty categories and assignments within BEGIN/COMMIT", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWith("select:categories", [{ id: 10, groupId: 1 }, { id: 11, groupId: 1 }]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("delete:assignments", [{}]);
      mock.respondWith("delete:categories", [{}]);
      mock.respondWith("delete:category_groups", [{}]);

      await deleteCategoryGroup(mock.db, 1);
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls.map((c) => c.table)).toEqual([
        "assignments",
        "categories",
        "category_groups",
      ]);
      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls).not.toContain("ROLLBACK");
    });

    it("deleteCategoryGroup throws 422 CategoryError if any category has transactions and no moveToCategoryId", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWith("select:categories", [{ id: 10, groupId: 1 }, { id: 11, groupId: 1 }]);
      mock.respondWith("select:transactions", [{ id: 100 }]);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_sub_transactions", []);

      await expect(deleteCategoryGroup(mock.db, 1)).rejects.toMatchObject({
        status: 422,
        name: "CategoryError",
        message: /Category group has 1 transaction\(s\)/,
      });
      expect(mock.calls.find((c) => c.op === "delete")).toBeUndefined();
      expect(mock.calls.find((c) => c.op === "run")).toBeUndefined();
    });

    it("deleteCategoryGroup rejects moveToCategoryId if it belongs to the group being deleted", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWith("select:categories", [{ id: 10, groupId: 1 }, { id: 11, groupId: 1 }]);

      await expect(deleteCategoryGroup(mock.db, 1, { moveToCategoryId: 10 })).rejects.toMatchObject({
        status: 400,
        name: "CategoryError",
        message: /Cannot reassign transactions to a category in the group being deleted/,
      });
      expect(mock.calls.find((c) => c.op === "delete")).toBeUndefined();
      expect(mock.calls.find((c) => c.op === "run")).toBeUndefined();
    });

    it("deleteCategoryGroup rejects moveToCategoryId if target category does not exist", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWithNth("select:categories", 1, [{ id: 10, groupId: 1 }]);
      mock.respondWithNth("select:categories", 2, []);

      await expect(deleteCategoryGroup(mock.db, 1, { moveToCategoryId: 99 })).rejects.toMatchObject({
        status: 404,
        name: "CategoryError",
        message: /Replacement category not found/,
      });
      expect(mock.calls.find((c) => c.op === "delete")).toBeUndefined();
      expect(mock.calls.find((c) => c.op === "run")).toBeUndefined();
    });

    it("deleteCategoryGroup reassigns transactions and recurring splits to moveToCategoryId", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWithNth("select:categories", 1, [{ id: 10, groupId: 1 }, { id: 11, groupId: 1 }]);
      mock.respondWithNth("select:categories", 2, [{ id: 20, name: "Groceries" }]);

      await deleteCategoryGroup(mock.db, 1, { moveToCategoryId: 20 });
      const updateCalls = mock.calls.filter((c) => c.op === "update");
      expect(updateCalls.map((c) => c.table)).toEqual([
        "transactions",
        "recurring",
        "recurring_sub_transactions",
      ]);
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls.map((c) => c.table)).toEqual([
        "assignments",
        "categories",
        "category_groups",
      ]);
      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls).not.toContain("ROLLBACK");
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

    it("deleteCategory issues ROLLBACK when the delete throws", async () => {
      mock.respondWith("select:categories", [{ id: 1, name: "Dining" }]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_sub_transactions", []);
      const wrapped = throwOnNextDelete(mock, "categories");
      await expect(deleteCategory(wrapped.db, 1)).rejects.toBeDefined();
      const sqls = wrapped.calls
        .filter((c) => c.op === "run")
        .map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
    });

    it("deleteCategoryGroup issues ROLLBACK when the delete throws", async () => {
      mock.respondWith("select:category_groups", [{ id: 1, name: "Bills" }]);
      mock.respondWith("select:categories", [{ id: 10, groupId: 1 }]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("select:recurring", []);
      mock.respondWith("select:recurring_sub_transactions", []);
      const wrapped = throwOnNextDelete(mock, "categories");
      await expect(deleteCategoryGroup(wrapped.db, 1)).rejects.toBeDefined();
      const sqls = wrapped.calls
        .filter((c) => c.op === "run")
        .map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
    });
  });

  describe("BUG-08: unique linkedAccountId constraint", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

    function openMigratedDb() {
      const raw = new Database(":memory:");
      raw.pragma("foreign_keys = ON");
      const db = drizzle(raw, { schema });
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      return db;
    }

    it("enforces unique linkedAccountId across categories in SQLite", async () => {
      const db = openMigratedDb();
      const [acc] = await db
        .insert(schema.accounts)
        .values({ name: "Visa", kind: "credit", groupLabel: "Credit Cards", sort: 0 })
        .returning();

      const [group] = await db
        .insert(schema.categoryGroups)
        .values({ name: "Credit Card Payments", isCreditCardPayments: true, sort: 0 })
        .returning();

      await db
        .insert(schema.categories)
        .values({ name: "Visa Payment 1", groupId: group!.id, linkedAccountId: acc!.id, sort: 0 });

      // Attempting to insert a second category linked to the same account should fail unique constraint
      await expect(
        db
          .insert(schema.categories)
          .values({ name: "Visa Payment 2", groupId: group!.id, linkedAccountId: acc!.id, sort: 1 })
      ).rejects.toThrow(/UNIQUE constraint failed/);
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

/**
 * Patch a MockDb so the next `delete:<tableName>` call throws.
 */
function throwOnNextDelete(mock: ReturnType<typeof createMockDb>, tableName: string): ReturnType<typeof createMockDb> {
  const realDelete = (mock.db.delete as unknown as (t: unknown) => unknown);
  const NAME = Symbol.for("drizzle:Name");
  (mock.db as unknown as { delete: (t: unknown) => unknown }).delete = (t: unknown) => {
    const name = (t as Record<symbol, unknown>)[NAME] as string | undefined;
    if (name === tableName) {
      throw new Error(`synthetic ${tableName} delete failure`);
    }
    return realDelete(t);
  };
  return mock;
}

