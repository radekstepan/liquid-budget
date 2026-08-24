import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "../src/queries/accounts.js";
import {
  createCategory,
  createCategoryGroup,
} from "../src/queries/categories.js";
import {
  createSplitWithChildren,
  createTransaction,
} from "../src/queries/transactions.js";
import { verifyBalanceIntegrity } from "../src/queries/diagnostics.js";
import { createMockDb, type MockDb } from "./mock-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

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

    it("reverses balance effects for own outgoing transfers on other accounts", async () => {
      mock.respondWithNth("select:accounts", 1, [{ id: 1, name: "Checking" }]);
      mock.respondWithNth("select:transactions", 1, []); // no counterparties where transferAccountId = 1
      mock.respondWithNth("select:transactions", 2, [
        { id: 201, transferAccountId: 2, amount: -10000 },
      ]);

      const result = await deleteAccount(mock.db, 1);
      expect(result).toMatchObject({ id: 1, name: "Checking" });

      const updateCalls = mock.calls.filter((c) => c.op === "update");
      expect(updateCalls.some((c) => c.table === "accounts")).toBe(true);
    });
  });

  describe("deleteAccount (SQLite integration)", () => {
    let db: Db;
    beforeEach(() => {
      db = openMigratedDb();
    });

    it("reverses counterparty balance when account holding an outgoing transfer is deleted", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 50000,
      });

      await createTransaction(db, {
        accountId: acctB.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 10000,
      });

      // Create outgoing transfer from A to B: -10000
      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Transfer to B",
        memo: "Rent share",
        amount: -10000,
        transferAccountId: acctB.id,
      });

      // A is 40000, B is 20000
      let b = await getAccount(db, acctB.id);
      expect(b?.balance).toBe(20000);

      // Delete account A
      await deleteAccount(db, acctA.id);

      // Account A is deleted
      expect(await getAccount(db, acctA.id)).toBeUndefined();

      // Account B balance must have the +10000 reversed back to 10000
      b = await getAccount(db, acctB.id);
      expect(b?.balance).toBe(10000);

      // Balance integrity check should report 0 issues
      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("reverses counterparty balance when account holding an incoming transfer is deleted", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      await createTransaction(db, {
        accountId: acctB.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 50000,
      });

      // Create incoming transfer into A from B: +10000
      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Transfer from B",
        memo: "Repayment",
        amount: 10000,
        transferAccountId: acctB.id,
      });

      // A is 10000, B is 40000
      let b = await getAccount(db, acctB.id);
      expect(b?.balance).toBe(40000);

      // Delete account A
      await deleteAccount(db, acctA.id);

      // Account B balance must have the -10000 reversed back to 50000
      b = await getAccount(db, acctB.id);
      expect(b?.balance).toBe(50000);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("reverses transfer child balance but excludes split parent when deleting account", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 100000,
      });

      await createTransaction(db, {
        accountId: acctB.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 10000,
      });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      // Create split on A: parent -25000, child1 (category) -15000, child2 (transfer to B) -10000
      await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Split Tx",
          memo: "Split with transfer",
          amount: -25000,
        },
        [
          { categoryId: cat.id, amount: -15000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "transfer" },
        ]
      );

      // A is 75000, B is 20000
      let a = await getAccount(db, acctA.id);
      let b = await getAccount(db, acctB.id);
      expect(a?.balance).toBe(75000);
      expect(b?.balance).toBe(20000);

      // Delete account A
      await deleteAccount(db, acctA.id);

      // Account B balance must have -10000 reversed (+10000 undone), back to 10000
      b = await getAccount(db, acctB.id);
      expect(b?.balance).toBe(10000);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("handles multiple outgoing transfers across different accounts cleanly", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });
      const acctC = await createAccount(db, { name: "Account C" });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 100000,
      });

      await createTransaction(db, {
        accountId: acctB.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 10000,
      });

      await createTransaction(db, {
        accountId: acctC.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 20000,
      });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Transfer to B 1",
        memo: "",
        amount: -10000,
        transferAccountId: acctB.id,
      });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-02",
        payee: "Transfer to B 2",
        memo: "",
        amount: -5000,
        transferAccountId: acctB.id,
      });

      await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-03",
        payee: "Transfer to C",
        memo: "",
        amount: -15000,
        transferAccountId: acctC.id,
      });

      // B is 25000, C is 35000
      let b = await getAccount(db, acctB.id);
      let c = await getAccount(db, acctC.id);
      expect(b?.balance).toBe(25000);
      expect(c?.balance).toBe(35000);

      // Delete account A
      await deleteAccount(db, acctA.id);

      // B back to 10000, C back to 20000
      b = await getAccount(db, acctB.id);
      c = await getAccount(db, acctC.id);
      expect(b?.balance).toBe(10000);
      expect(c?.balance).toBe(20000);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
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
