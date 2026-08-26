import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  AccountError,
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

      const insertCall = mock.calls.find((c) => c.op === "insert" && c.table === "accounts");
      expect(insertCall?.values).toMatchObject({
        name: "Old",
        archived: true,
      });
    });

    it("inserts a Starting Balance transaction when balance is non-zero (BUG 6.1)", async () => {
      mock.respondWith("select:accounts", [{ max: null }]);
      mock.respondWith("insert:accounts", [{ id: 42, sort: 0, balance: 50000 }]);

      await createAccount(mock.db, { name: "Checking", kind: "liquid", balance: 50000, onBudget: true });

      const txInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(txInsert).toBeDefined();
      expect(txInsert?.values).toMatchObject({
        accountId: 42,
        categoryId: null,
        payee: "Starting Balance",
        amount: 50000,
        status: "c",
        isIncome: true,
      });
    });

    it("sets isIncome to false for credit accounts with negative starting balance (BUG 6.1)", async () => {
      mock.respondWith("select:accounts", [{ max: null }]);
      mock.respondWith("insert:accounts", [{ id: 43, sort: 0, balance: -15000 }]);

      await createAccount(mock.db, { name: "Visa", kind: "credit", balance: -15000, onBudget: true });

      const txInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(txInsert).toBeDefined();
      expect(txInsert?.values).toMatchObject({
        accountId: 43,
        categoryId: null,
        payee: "Starting Balance",
        amount: -15000,
        status: "c",
        isIncome: false,
      });
    });

    it("does not insert a Starting Balance transaction when balance is 0 or omitted", async () => {
      mock.respondWith("select:accounts", [{ max: null }]);
      mock.respondWith("insert:accounts", [{ id: 44, sort: 0, balance: 0 }]);

      await createAccount(mock.db, { name: "Empty", kind: "liquid" });

      const txInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(txInsert).toBeUndefined();
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

    it("BUG-04: returns existing row if patch is empty", async () => {
      mock.respondWith("select:accounts", [{ id: 1, name: "Checking", sort: 1 }]);
      const row = await updateAccount(mock.db, 1, {});
      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall).toBeUndefined();
      expect(row).toMatchObject({ id: 1, name: "Checking", sort: 1 });
    });
  });

  describe("deleteAccount", () => {
    it("UNI-07 / F-04: cleans up transfer counterparties, recurring links, and linked categories atomically", async () => {
      mock.respondWithNth("select:accounts", 1, [{ id: 5, name: "Checking" }]);
      mock.respondWithNth("select:transactions", 1, []);
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
      mock.respondWithNth("select:transactions", 1, []); // no reconciled transactions on account 1
      mock.respondWithNth("select:transactions", 2, []); // no counterparties where transferAccountId = 1
      mock.respondWithNth("select:transactions", 3, [
        { id: 201, transferAccountId: 2, amount: -10000 },
      ]);

      const result = await deleteAccount(mock.db, 1);
      expect(result).toMatchObject({ id: 1, name: "Checking" });

      const updateCalls = mock.calls.filter((c) => c.op === "update");
      expect(updateCalls.some((c) => c.table === "accounts")).toBe(true);
    });

    it("BUG-08: refuses to delete account when own transactions are reconciled", async () => {
      mock.respondWithNth("select:accounts", 1, [{ id: 1, name: "Checking" }]);
      mock.respondWithNth("select:transactions", 1, [{ id: 42, status: "r" }]);

      await expect(deleteAccount(mock.db, 1)).rejects.toMatchObject({
        name: "AccountError",
        status: 422,
        message: "Account contains reconciled transactions. Unreconcile before deleting.",
      });
    });
  });

  describe("createAccount (SQLite integration)", () => {
    let db: Db;
    beforeEach(() => {
      db = openMigratedDb();
    });

    it("creates an account and an explicit Starting Balance transaction in SQLite", async () => {
      const acct = await createAccount(db, {
        name: "TD Checking",
        kind: "liquid",
        balance: 1087555,
        onBudget: true,
      });

      expect(acct.id).toBeDefined();
      expect(acct.balance).toBe(1087555);

      const txs = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, acct.id));

      expect(txs).toHaveLength(1);
      expect(txs[0]!.payee).toBe("Starting Balance");
      expect(txs[0]!.amount).toBe(1087555);
      expect(txs[0]!.status).toBe("c");
      expect(txs[0]!.isIncome).toBe(true);
      expect(txs[0]!.categoryId).toBeNull();

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
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

    it("re-totals split parent when a transfer child in a >=3 child split is deleted via account deletion", async () => {
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
        amount: 50000,
      });

      await createTransaction(db, {
        accountId: acctC.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 20000,
      });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      // Create a 3-child split on Account A:
      // Parent: -60000
      // Child 1: Category (-20000)
      // Child 2: Transfer to B (-10000)
      // Child 3: Transfer to C (-30000)
      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Multi-split",
          memo: "Split across accounts",
          amount: -60000,
        },
        [
          { categoryId: cat.id, amount: -20000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "to B" },
          { transferAccountId: acctC.id, amount: -30000, memo: "to C" },
        ]
      );

      // Verify intermediate balances
      // A: 100000 - 60000 = 40000
      // B: 50000 + 10000 = 60000
      // C: 20000 + 30000 = 50000
      expect((await getAccount(db, acctA.id))?.balance).toBe(40000);
      expect((await getAccount(db, acctB.id))?.balance).toBe(60000);
      expect((await getAccount(db, acctC.id))?.balance).toBe(50000);

      // Delete Account B
      await deleteAccount(db, acctB.id);

      // Account B is gone
      expect(await getAccount(db, acctB.id)).toBeUndefined();

      // Account A balance reversed Child 2's -10000 -> balance becomes 50000
      expect((await getAccount(db, acctA.id))?.balance).toBe(50000);

      // Account C balance remains 50000
      expect((await getAccount(db, acctC.id))?.balance).toBe(50000);

      // Split parent on A is re-totaled to (-20000 + -30000) = -50000
      const [parentRow] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, split.parent.id));
      expect(parentRow?.amount).toBe(-50000);

      // Remaining children should be 2 (Child 1 and Child 3)
      const remainingChildren = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.parentId, split.parent.id));
      expect(remainingChildren).toHaveLength(2);
      expect(remainingChildren.map((c) => c.amount)).toEqual(
        expect.arrayContaining([-20000, -30000])
      );

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("collapses split to 0 children (deletes parent and remaining child) when 2-child split has 1 transfer child deleted via account deletion", async () => {
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
        amount: 50000,
      });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      // Create a 2-child split on Account A:
      // Parent: -30000
      // Child 1: Category (-20000)
      // Child 2: Transfer to B (-10000)
      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "2-split",
          memo: "Split with transfer",
          amount: -30000,
        },
        [
          { categoryId: cat.id, amount: -20000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "to B" },
        ]
      );

      expect((await getAccount(db, acctA.id))?.balance).toBe(70000);
      expect((await getAccount(db, acctB.id))?.balance).toBe(60000);

      // Delete Account B
      await deleteAccount(db, acctB.id);

      // Account B is gone
      expect(await getAccount(db, acctB.id)).toBeUndefined();

      // Account A balance is restored to 100000 (both child 2 and collapsed child 1 balances reversed)
      expect((await getAccount(db, acctA.id))?.balance).toBe(100000);

      // Split parent and all children should be deleted
      const parentRow = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, split.parent.id));
      expect(parentRow).toHaveLength(0);

      const children = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.parentId, split.parent.id));
      expect(children).toHaveLength(0);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("handles 2-child split where both children transfer to the deleted account cleanly", async () => {
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
        amount: 50000,
      });

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Dual transfer split",
          memo: "",
          amount: -30000,
        },
        [
          { transferAccountId: acctB.id, amount: -10000, memo: "part 1" },
          { transferAccountId: acctB.id, amount: -20000, memo: "part 2" },
        ]
      );

      expect((await getAccount(db, acctA.id))?.balance).toBe(70000);
      expect((await getAccount(db, acctB.id))?.balance).toBe(80000);

      await deleteAccount(db, acctB.id);

      expect(await getAccount(db, acctB.id)).toBeUndefined();
      expect((await getAccount(db, acctA.id))?.balance).toBe(100000);

      const parentRow = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, split.parent.id));
      expect(parentRow).toHaveLength(0);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("refuses to delete account when counterparty standalone transfer is reconciled", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      const tx = await createTransaction(db, {
        accountId: acctA.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Transfer to B",
        memo: "",
        amount: -10000,
        transferAccountId: acctB.id,
      });

      // Mark transfer transaction reconciled
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, tx.id));

      await expect(deleteAccount(db, acctB.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acctB.id)).rejects.toMatchObject({ status: 422 });

      // Account B still exists
      expect(await getAccount(db, acctB.id)).toBeDefined();
    });

    it("refuses to delete account when counterparty split child is reconciled", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Split",
          memo: "",
          amount: -30000,
        },
        [
          { categoryId: cat.id, amount: -20000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "to B" },
        ]
      );

      const transferChild = split.children.find((c) => c.transferAccountId === acctB.id)!;
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, transferChild.id));

      await expect(deleteAccount(db, acctB.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acctB.id)).rejects.toMatchObject({ status: 422 });

      expect(await getAccount(db, acctB.id)).toBeDefined();
    });

    it("refuses to delete account when counterparty split parent is reconciled", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Split",
          memo: "",
          amount: -30000,
        },
        [
          { categoryId: cat.id, amount: -20000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "to B" },
        ]
      );

      // Reconcile parent
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, split.parent.id));

      await expect(deleteAccount(db, acctB.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acctB.id)).rejects.toMatchObject({ status: 422 });

      expect(await getAccount(db, acctB.id)).toBeDefined();
    });

    it("refuses to delete account when remaining sibling in 1-child collapse is reconciled", async () => {
      const acctA = await createAccount(db, { name: "Account A" });
      const acctB = await createAccount(db, { name: "Account B" });

      const group = await createCategoryGroup(db, "General");
      const cat = await createCategory(db, { name: "Groceries", groupId: group.id });

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acctA.id,
          date: "2026-08-01",
          payee: "Split",
          memo: "",
          amount: -30000,
        },
        [
          { categoryId: cat.id, amount: -20000, memo: "groceries" },
          { transferAccountId: acctB.id, amount: -10000, memo: "to B" },
        ]
      );

      const categoryChild = split.children.find((c) => c.categoryId === cat.id)!;
      // Reconcile category sibling
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, categoryChild.id));

      await expect(deleteAccount(db, acctB.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acctB.id)).rejects.toMatchObject({ status: 422 });

      expect(await getAccount(db, acctB.id)).toBeDefined();
    });

    it("BUG-08: refuses to delete account when own standalone transaction is reconciled", async () => {
      const acct = await createAccount(db, { name: "Checking" });
      const tx = await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Test Payee",
        memo: "",
        amount: -5000,
      });

      // Mark transaction reconciled
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, tx.id));

      await expect(deleteAccount(db, acct.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acct.id)).rejects.toMatchObject({
        status: 422,
        message: "Account contains reconciled transactions. Unreconcile before deleting.",
      });

      // Account still exists
      expect(await getAccount(db, acct.id)).toBeDefined();
    });

    it("BUG-08: refuses to delete account when own split child is reconciled", async () => {
      const acct = await createAccount(db, { name: "Checking" });
      const group = await createCategoryGroup(db, "General");
      const cat1 = await createCategory(db, { name: "Groceries", groupId: group.id });
      const cat2 = await createCategory(db, { name: "Household", groupId: group.id });

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-08-01",
          payee: "Grocery Store",
          memo: "",
          amount: -5000,
        },
        [
          { categoryId: cat1.id, amount: -3000, memo: "food" },
          { categoryId: cat2.id, amount: -2000, memo: "supplies" },
        ]
      );

      // Reconcile child
      await db
        .update(schema.transactions)
        .set({ status: "r" })
        .where(eq(schema.transactions.id, split.children[0]!.id));

      await expect(deleteAccount(db, acct.id)).rejects.toThrow(AccountError);
      await expect(deleteAccount(db, acct.id)).rejects.toMatchObject({
        status: 422,
        message: "Account contains reconciled transactions. Unreconcile before deleting.",
      });

      expect(await getAccount(db, acct.id)).toBeDefined();
    });

    it("BUG-08: allows deleting account when transactions exist but none are reconciled", async () => {
      const acct = await createAccount(db, { name: "Checking" });
      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Cleared Transaction",
        memo: "",
        amount: -5000,
        status: "c",
      });
      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-08-02",
        payee: "Uncleared Transaction",
        memo: "",
        amount: -2500,
        status: "u",
      });

      await deleteAccount(db, acct.id);
      expect(await getAccount(db, acct.id)).toBeUndefined();
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

  describe("BUG-15: kind and onBudget invariants and mutation guards (integration)", () => {
    let db: Db;
    beforeEach(() => {
      db = openMigratedDb();
    });

    it("rejects creating an account with contradictory kind and onBudget", async () => {
      await expect(
        createAccount(db, { name: "Bad Offbudget", kind: "offbudget", onBudget: true })
      ).rejects.toMatchObject({
        name: "AccountError",
        status: 400,
      });

      await expect(
        createAccount(db, { name: "Bad Liquid", kind: "liquid", onBudget: false })
      ).rejects.toMatchObject({
        name: "AccountError",
        status: 400,
      });
    });

    it("defaults onBudget to false for offbudget accounts when omitted", async () => {
      const row = await createAccount(db, { name: "Investments", kind: "offbudget" });
      expect(row.onBudget).toBe(false);
      expect(row.kind).toBe("offbudget");
    });

    it("disallows changing kind or onBudget when transactions exist on the account", async () => {
      const acct = await createAccount(db, {
        name: "Liquid Checking",
        kind: "liquid",
        balance: 10000,
      });

      // The starting balance created 1 transaction
      await expect(
        updateAccount(db, acct.id, { kind: "offbudget" })
      ).rejects.toMatchObject({
        name: "AccountError",
        status: 422,
        message: "Cannot change account type or budget participation when transactions exist",
      });

      await expect(
        updateAccount(db, acct.id, { onBudget: false })
      ).rejects.toMatchObject({
        name: "AccountError",
        status: 422,
      });
    });

    it("disallows changing kind or onBudget when transfer counterparty transactions exist", async () => {
      const src = await createAccount(db, { name: "Source", kind: "liquid", balance: 50000 });
      const dest = await createAccount(db, { name: "Dest", kind: "liquid", balance: 0 });

      // Create a transfer from src to dest
      await createTransaction(db, {
        accountId: src.id,
        transferAccountId: dest.id,
        amount: -10000,
        date: "2026-06-01",
      });

      // dest has no direct transactions where accountId === dest.id, but has a transfer pointing to it
      await expect(
        updateAccount(db, dest.id, { kind: "offbudget" })
      ).rejects.toMatchObject({
        name: "AccountError",
        status: 422,
      });
    });

    it("allows updating name, archived, groupLabel, or unchanged kind when transactions exist", async () => {
      const acct = await createAccount(db, {
        name: "Liquid Checking",
        kind: "liquid",
        balance: 10000,
      });

      const updated = await updateAccount(db, acct.id, {
        name: "Renamed Checking",
        kind: "liquid",
        archived: true,
      });
      expect(updated).toMatchObject({
        id: acct.id,
        name: "Renamed Checking",
        kind: "liquid",
        archived: true,
      });
    });

    it("allows changing kind on an empty account and synchronizes onBudget", async () => {
      const acct = await createAccount(db, { name: "Empty", kind: "liquid", balance: 0 });

      const updated = await updateAccount(db, acct.id, { kind: "offbudget" });
      expect(updated).toMatchObject({
        id: acct.id,
        kind: "offbudget",
        onBudget: false,
      });

      const updatedBack = await updateAccount(db, acct.id, { kind: "credit" });
      expect(updatedBack).toMatchObject({
        id: acct.id,
        kind: "credit",
        onBudget: true,
      });
    });
  });
});
