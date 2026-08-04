import { describe, expect, it, beforeEach } from "vitest";
import {
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
  });

  describe("createCategory", () => {
    it("inserts with auto-incremented sort within the group", async () => {
      mock.respondWith("select:categories", [{ max: 2 }]);
      mock.respondWith("insert:categories", [{ id: 1, sort: 3 }]);
      const row = await createCategory(mock.db, { groupId: 1, name: "Test" });
      expect(row).toMatchObject({ id: 1, sort: 3 });
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
    it("deleteCategory targets the categories table", async () => {
      await deleteCategory(mock.db, 1);
      expect(mock.calls.find((c) => c.op === "delete")?.table).toBe("categories");
    });

    it("deleteCategoryGroup targets the category_groups table", async () => {
      await deleteCategoryGroup(mock.db, 1);
      expect(mock.calls.find((c) => c.op === "delete")?.table).toBe("category_groups");
    });

    it("deleteCategory does not pre-check children (FK handles cascade at the DB layer)", async () => {
      // Schema fix: `recurring_sub_transactions.categoryId` is nullable
      // with ON DELETE SET NULL (matching `transactions.categoryId`), so
      // deleting a category that is referenced by a recurring split no
      // longer crashes with a FK constraint violation. The recurring
      // sub-rows simply become uncategorised. The query helper just
      // emits a single DELETE — no extra lookup is needed.
      await deleteCategory(mock.db, 42);
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]?.table).toBe("categories");
      const setCalls = mock.calls.filter((c) => c.op === "update");
      expect(setCalls).toHaveLength(0);
    });
  });
});
