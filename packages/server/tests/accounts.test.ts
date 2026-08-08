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
  });

  describe("updateAccount", () => {
    it("applies the patch and returns the row", async () => {
      mock.respondWith("update:accounts", [{ id: 1, name: "New Name" }]);

      const row = await updateAccount(mock.db, 1, { name: "New Name" });
      expect(row).toMatchObject({ id: 1, name: "New Name" });

      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall?.set).toMatchObject({ name: "New Name" });
    });

    it("does not set fields that are not in the patch", async () => {
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await updateAccount(mock.db, 1, { name: "Only" });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ name: "Only" });
    });
  });

  describe("deleteAccount", () => {
    it("issues a delete on the accounts table", async () => {
      await deleteAccount(mock.db, 5);
      const deleteCall = mock.calls.find((c) => c.op === "delete");
      expect(deleteCall?.table).toBe("accounts");
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
