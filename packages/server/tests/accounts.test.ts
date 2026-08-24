import { describe, expect, it, beforeEach } from "vitest";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "../src/queries/accounts.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("accounts queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("createAccount", () => {
    it("inserts with auto-incremented sort and returns the row", async () => {
      mock.respondWith("select:accounts", [{ max: 2 }]);
      mock.respondWith("insert:accounts", [{ id: 7, sort: 3 }]);

      const row = await createAccount(mock.db, { name: "Test", kind: "liquid" });
      expect(row).toMatchObject({ id: 7, sort: 3 });

      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        name: "Test",
        kind: "liquid",
        groupLabel: "Liquid",
        onBudget: true,
        sort: 3,
      });
    });

    it("defaults to sort 0 when no accounts exist", async () => {
      mock.respondWith("select:accounts", [{ max: null }]);
      mock.respondWith("insert:accounts", [{ id: 1, sort: 0 }]);

      const row = await createAccount(mock.db, { name: "First" });
      expect(row).toMatchObject({ id: 1, sort: 0 });
    });

    it("rounds float balance to nearest integer cent", async () => {
      mock.respondWith("select:accounts", [{ max: null }]);
      mock.respondWith("insert:accounts", [{ id: 1, sort: 0, balance: 10050 }]);

      await createAccount(mock.db, { name: "Savings", balance: 10049.6 });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        balance: 10050,
      });
    });

    it("supports creating an archived account", async () => {
      mock.respondWith("select:accounts", [{ max: 0 }]);
      mock.respondWith("insert:accounts", [{ id: 2, archived: true }]);

      const row = await createAccount(mock.db, { name: "Old", archived: true });
      expect(row).toMatchObject({ id: 2, archived: true });

      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        name: "Old",
        archived: true,
      });
    });
  });

  describe("updateAccount", () => {
    it("applies the patch and returns the row", async () => {
      mock.respondWith("update:accounts", [{ id: 1, name: "New Name" }]);

      const row = await updateAccount(mock.db, 1, { name: "New Name" });
      expect(row).toMatchObject({ id: 1, name: "New Name" });

      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall?.set).toMatchObject({ name: "New Name" });
    });

    it("applies archived true or false in the patch", async () => {
      mock.respondWith("update:accounts", [{ id: 1, archived: true }]);

      const row = await updateAccount(mock.db, 1, { archived: true });
      expect(row).toMatchObject({ id: 1, archived: true });

      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall?.set).toMatchObject({ archived: true });
    });

    it("does not set fields that are not in the patch", async () => {
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await updateAccount(mock.db, 1, { name: "Only" });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Only" });
    });

    it("does not permit updating account balance directly", async () => {
      mock.respondWith("update:accounts", [{ id: 1 }]);

      // Attempting to pass balance via any type assertion is ignored
      await updateAccount(mock.db, 1, { name: "Safe", ...({ balance: 99999 } as any) });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Safe" });
      expect(set.balance).toBeUndefined();
    });
  });

  describe("deleteAccount", () => {
    it("UNI-07 / F-04: cleans up transfer counterparties, recurring links, and linked categories atomically", async () => {
      mock.respondWithNth("select:accounts", 1, [{ id: 5, name: "Checking" }]);
      mock.respondWith("select:transactions", [
        { id: 101, accountId: 2, amount: -5000, parentId: null },
      ]);

      const result = await deleteAccount(mock.db, 5);
      expect(result).toMatchObject({ id: 5, name: "Checking" });

      const runCalls = mock.calls.filter((c) => c.op === "run");
      const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");

      // Balance of remaining counterparty account (accountId: 2) was updated
      const updateCalls = mock.calls.filter((c) => c.op === "update");
      expect(updateCalls.find((c) => c.table === "accounts")).toBeDefined();

      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls.map((c) => c.table)).toEqual([
        "transactions",
        "recurring",
        "recurring_sub_transactions",
        "categories",
        "accounts",
      ]);
    });

    it("returns null if the account does not exist", async () => {
      mock.respondWith("select:accounts", []);
      const result = await deleteAccount(mock.db, 999);
      expect(result).toBeNull();
    });
  });

  describe("getAccount", () => {
    it("returns the account row for a known id", async () => {
      mock.respondWith("select:accounts", [{ id: 3, name: "Savings" }]);
      const row = await getAccount(mock.db, 3);
      expect(row).toMatchObject({ id: 3, name: "Savings" });
      const selectCall = mock.calls.find((c) => c.op === "select");
      expect(selectCall?.table).toBe("accounts");
    });

    it("returns undefined when the id does not exist", async () => {
      mock.respondWith("select:accounts", []);
      const row = await getAccount(mock.db, 999);
      expect(row).toBeUndefined();
    });
  });

  describe("listAccounts", () => {
    it("returns all accounts ordered by sort", async () => {
      mock.respondWith("select:accounts", [
        { id: 1, name: "A", sort: 0 },
        { id: 2, name: "B", sort: 1 },
      ]);
      const rows = await listAccounts(mock.db);
      expect(rows).toHaveLength(2);
      const selectCall = mock.calls.find((c) => c.op === "select");
      expect(selectCall?.table).toBe("accounts");
    });
  });
});
