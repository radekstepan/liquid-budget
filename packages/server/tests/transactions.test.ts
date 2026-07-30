import { describe, expect, it, beforeEach } from "vitest";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
} from "../src/queries/transactions.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("transactions queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("createTransaction", () => {
    it("inserts and applies balance", async () => {
      mock.respondWith("insert:transactions", [{ id: 1 }]);
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 2,
        date: "2026-07-01",
        payee: "Coffee",
        memo: "",
        amount: -5,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["insert", "update"]);
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.table).toBe("transactions");
      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall?.table).toBe("accounts");
    });
  });

  describe("updateTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const row = await updateTransaction(mock.db, 99, { payee: "X" });
      expect(row).toBeNull();
    });

    it("updates a row without affecting balance when amount/account is unchanged", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, amount: -10, payee: "Old", date: "2026-07-01" },
      ]);
      mock.respondWith("update:transactions", [{ id: 1, payee: "New" }]);

      const row = await updateTransaction(mock.db, 1, { payee: "New" });
      expect(row).toMatchObject({ payee: "New" });
      const ops = mock.calls.map((c) => c.op);
      // No balance update call (no update:accounts response registered)
      expect(ops).toEqual(["select", "update"]);
    });

    it("applies a balance correction when the amount changes", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, amount: -10, payee: "Old", date: "2026-07-01" },
      ]);
      mock.respondWith("update:transactions", [{ id: 1, amount: -20 }]);
      mock.respondWith("update:accounts", [{}]);

      await updateTransaction(mock.db, 1, { amount: -20 });
      const ops = mock.calls.map((c) => c.op);
      // select existing → update transaction → reverse old balance → apply new balance
      expect(ops).toEqual(["select", "update", "update", "update"]);
    });
  });

  describe("deleteTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const result = await deleteTransaction(mock.db, 99);
      expect(result).toBeNull();
    });

    it("deletes and reverses the balance", async () => {
      mock.respondWith("select:transactions", [{ id: 1, accountId: 1, amount: -50 }]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:accounts", [{}]);

      const result = await deleteTransaction(mock.db, 1);
      expect(result).toMatchObject({ id: 1 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "delete", "update"]);
    });
  });
});
