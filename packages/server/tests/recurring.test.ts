import { describe, expect, it, beforeEach } from "vitest";
import {
  createRecurring,
  deleteRecurring,
  RecurringError,
  updateRecurring,
} from "../src/queries/recurring.js";
import { createMockDb, type MockDb } from "./mock-db.js";

const existingRow = {
  id: 1,
  accountId: 1,
  categoryId: 2,
  payee: "Netflix",
  amount: -15.99,
  frequency: "monthly",
  nextDate: "2026-07-15",
  active: true,
  transferAccountId: null,
};

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
        transferAccountId: null,
      });
    });

    it("creates a recurring transfer", async () => {
      mock.respondWith("insert:recurring", [{ id: 1 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "AMEX Payment",
        amount: -1000,
        frequency: "monthly",
        nextDate: "2026-07-20",
        transferAccountId: 2,
      });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: null,
        transferAccountId: 2,
      });
      // No sub-transaction inserts for transfers.
      const insertCount = mock.calls.filter((c) => c.op === "insert").length;
      expect(insertCount).toBe(1);
    });

    it("rejects a transfer to the same account", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Self",
          amount: -100,
          frequency: "monthly",
          nextDate: "2026-07-20",
          transferAccountId: 1,
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("creates a recurring split with children", async () => {
      mock.respondWith("insert:recurring", [{ id: 7 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Costco",
        amount: -200,
        frequency: "monthly",
        nextDate: "2026-07-01",
        subTransactions: [
          { categoryId: 5, amount: -120, memo: "groceries" },
          { categoryId: 6, amount: -80, memo: "household" },
        ],
      });
      const inserts = mock.calls.filter((c) => c.op === "insert");
      const subValues = inserts
        .filter((c) => c.table === "recurring_sub_transactions")
        .map((c) => c.values);
      expect(subValues).toHaveLength(2);
      expect(subValues[0]).toMatchObject({
        recurringId: 7,
        categoryId: 5,
        amount: -120,
        memo: "groceries",
        sort: 0,
      });
      expect(subValues[1]).toMatchObject({
        recurringId: 7,
        categoryId: 6,
        amount: -80,
        memo: "household",
        sort: 1,
      });
    });

    it("rejects a split with fewer than two children", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Costco",
          amount: -200,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [{ categoryId: 5, amount: -200 }],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("rejects an unbalanced split", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Costco",
          amount: -200,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [
            { categoryId: 5, amount: -100 },
            { categoryId: 6, amount: -90 },
          ],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });
  });

  describe("updateRecurring", () => {
    it("only sets fields that are provided", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { payee: "New", nextDate: "2026-08-15" });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ payee: "New", nextDate: "2026-08-15" });
    });

    it("allows null categoryId to clear the link", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { categoryId: null });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ categoryId: null });
    });

    it("replaces sub-transactions when the key is present", async () => {
      const splitRow = { ...existingRow, amount: -200, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [splitRow]);
      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: 5, amount: -120 },
          { categoryId: 6, amount: -80 },
        ],
      });
      const calls = mock.calls.map((c) => `${c.op}:${c.table ?? "?"}`);
      // Should include a delete on the children, then two inserts.
      expect(calls).toContain("delete:recurring_sub_transactions");
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
    });

    it("removes all sub-transactions when the key is present with []", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { subTransactions: [] });
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(0);
    });

    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:recurring", []);
      const out = await updateRecurring(mock.db, 99, { payee: "X" });
      expect(out).toBeNull();
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
