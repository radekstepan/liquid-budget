import { describe, expect, it, beforeEach } from "vitest";
import {
  createRecurring,
  deleteRecurring,
  updateRecurring,
} from "../src/queries/recurring.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("recurring queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("createRecurring", () => {
    it("inserts with defaults", async () => {
      mock.respondWith("insert:recurring", [{ id: 1 }]);
      const row = await createRecurring(mock.db, {
        accountId: 1,
        categoryId: 2,
        payee: "Netflix",
        amount: -15.99,
        frequency: "monthly",
        nextDate: "2026-07-15",
      });
      expect(row).toMatchObject({ id: 1 });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: 2,
        payee: "Netflix",
        amount: -15.99,
        frequency: "monthly",
        nextDate: "2026-07-15",
        active: true,
      });
    });
  });

  describe("updateRecurring", () => {
    it("only sets fields that are provided", async () => {
      mock.respondWith("update:recurring", [{ id: 1 }]);
      await updateRecurring(mock.db, 1, { payee: "New", nextDate: "2026-08-15" });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ payee: "New", nextDate: "2026-08-15" });
    });

    it("allows null categoryId to clear the link", async () => {
      mock.respondWith("update:recurring", [{ id: 1 }]);
      await updateRecurring(mock.db, 1, { categoryId: null });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ categoryId: null });
    });
  });

  describe("deleteRecurring", () => {
    it("issues a delete on the recurring table", async () => {
      await deleteRecurring(mock.db, 5);
      const deleteCall = mock.calls.find((c) => c.op === "delete");
      expect(deleteCall?.table).toBe("recurring");
    });
  });
});
