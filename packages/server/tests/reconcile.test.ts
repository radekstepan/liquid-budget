import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  createAccount,
  createSplitWithChildren,
  createTransaction,
  createTransfer,
  getReconcileState,
  reconcileAccount,
  RECONCILE_ADJUSTMENT_MEMO,
  unreconcileAccount,
  updateTransaction,
  TransactionError,
} from "../src/index.js";
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

describe("reconcile queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("getReconcileState", () => {
    it("returns working balance and counts for an account", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 70000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWith("select:transactions", [
        {
          unclearedSum: 10000,
          unclearedCount: 2,
          clearedSum: 50000,
          clearedCount: 3,
          reconciledSum: 10000,
          reconciledCount: 1,
        },
      ]);

      const state = await getReconcileState(mock.db, 1);
      // workingBalance = clearedSum (50000) + reconciledSum (10000) = 60000
      expect(state).toMatchObject({
        accountId: 1,
        accountName: "Chequing",
        workingBalance: 60000,
        unclearedTotal: 10000,
        unclearedCount: 2,
        clearedCount: 3,
        reconciledCount: 1,
        lastReconciledAt: null,
      });
    });

    it("BUG-3.1: computes working balance strictly from date-bounded clearedSum + reconciledSum regardless of account.balance", async () => {
      // Account balance includes future transactions (+30000 after statement date)
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 90000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWith("select:transactions", [
        {
          unclearedSum: 5000,
          unclearedCount: 1,
          clearedSum: 50000,
          clearedCount: 3,
          reconciledSum: 10000,
          reconciledCount: 1,
        },
      ]);

      const state = await getReconcileState(mock.db, 1, "2026-06-30");
      // workingBalance must be clearedSum (50000) + reconciledSum (10000) = 60000,
      // NOT acct.balance - unclearedTotal (90000 - 5000 = 85000)
      expect(state.workingBalance).toBe(60000);
    });

    it("throws 404 when the account does not exist", async () => {
      mock.respondWith("select:accounts", []);
      await expect(getReconcileState(mock.db, 999)).rejects.toBeInstanceOf(
        TransactionError
      );
    });
  });

  describe("reconcileAccount", () => {
    it("flips cleared rows to reconciled and stamps the account when diff is zero", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 50000,
          clearedCount: 7,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);
      mock.respondWith("insert:reconciliations", [{ id: 10 }]);
      mock.respondWithNth("update:transactions", 1, [
        { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 },
      ]);
      mock.respondWith("update:accounts", [{}]);

      const result = await reconcileAccount(mock.db, {
        accountId: 1,
        statementBalance: 50000,
      });

      expect(result).toMatchObject({
        reconciledCount: 7,
        adjustmentTransactionId: null,
        finalDiff: 0,
      });

      const flipCall = mock.calls.find(
        (c) => c.op === "update" && c.table === "transactions"
      );
      expect(flipCall?.set).toMatchObject({ status: "r", reconciliationId: 10 });
    });

    it("BUG-12: acquires database transaction lock (BEGIN) before reading reconcile state aggregates", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 50000,
          clearedCount: 3,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);
      mock.respondWith("insert:reconciliations", [{ id: 10 }]);
      mock.respondWithNth("update:transactions", 1, [
        { id: 1 }, { id: 2 }, { id: 3 },
      ]);
      mock.respondWith("update:accounts", [{}]);

      await reconcileAccount(mock.db, {
        accountId: 1,
        statementBalance: 50000,
      });

      // The very first operation must be BEGIN to lock snapshot before reading aggregates
      expect(mock.calls[0]).toMatchObject({ op: "run", sql: "BEGIN" });
    });

    it("throws 422 when statement balance does not match and no adjustment category is provided", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 50000,
          clearedCount: 3,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);

      await expect(
        reconcileAccount(mock.db, { accountId: 1, statementBalance: 48765 })
      ).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
      });
    });

    it("BUG-17: throws informative error when expectedWorkingBalance differs from actual on unbalanced submission", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 60000,
          clearedCount: 4,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);

      await expect(
        reconcileAccount(mock.db, {
          accountId: 1,
          statementBalance: 50000,
          expectedWorkingBalance: 50000,
        })
      ).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: expect.stringContaining("Account balance changed since the reconcile modal was opened"),
      });
    });

    it("UNI-10 / BUG-32, BUG-33: posts adjustment with status 'r' and reconciliation_id when diff is non-zero", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 50000,
          clearedCount: 2,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);
      mock.respondWith("select:categories", [{ id: 42, name: "Adjustments" }]);
      mock.respondWith("insert:reconciliations", [{ id: 10 }]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 999 }]);
      mock.respondWithNth("update:accounts", 1, [{}]);
      mock.respondWith("update:reconciliations", [{}]);
      mock.respondWithNth("update:transactions", 1, [{ id: 1 }, { id: 2 }]);
      mock.respondWithNth("update:accounts", 2, [{}]);

      const result = await reconcileAccount(mock.db, {
        accountId: 1,
        statementBalance: 48765,
        adjustmentCategoryId: 42,
      });

      // diff = working(50000) − statement(48765) = 1235; adjustment amount = -1235
      expect(result).toMatchObject({
        reconciledCount: 3,
        adjustmentTransactionId: 999,
        finalDiff: 0,
      });

      const insertCall = mock.calls.find(
        (c) => c.op === "insert" && c.table === "transactions"
      );
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: 42,
        memo: RECONCILE_ADJUSTMENT_MEMO,
        payee: RECONCILE_ADJUSTMENT_MEMO,
        amount: -1235,
        status: "r",
        reconciliationId: 10,
        reconciledAt: expect.any(String),
      });
    });

    it("UNI-27 / BUG-31: throws 422 when adjustmentCategoryId does not exist", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 50000, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedSum: 50000,
          clearedCount: 2,
          reconciledSum: 0,
          reconciledCount: 0,
        },
      ]);
      mock.respondWith("select:categories", []); // Category not found

      await expect(
        reconcileAccount(mock.db, {
          accountId: 1,
          statementBalance: 48765,
          adjustmentCategoryId: 99999,
        })
      ).rejects.toMatchObject({
        status: 422,
        message: "Invalid adjustment category",
      });
    });
  });

  describe("unreconcileAccount", () => {
    it("UNI-10 / F-07: flips the precise reconciliation round back to C using reconciliation_id", async () => {
      mock.respondWithNth("select:accounts", 1, [
        {
          id: 1,
          name: "Chequing",
          balance: 50000,
          lastReconciledAt: "2026-04-10",
          lastReconciledBalance: 50000,
        },
      ]);
      mock.respondWithNth("select:reconciliations", 1, [
        { id: 15, accountId: 1, reconciledAt: "2026-04-10", statementBalance: 50000, adjustmentTransactionId: null },
      ]);
      mock.respondWithNth("update:transactions", 1, [
        { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
      ]);
      mock.respondWith("delete:reconciliations", [{}]);
      mock.respondWithNth("select:reconciliations", 2, []);
      mock.respondWithNth("update:accounts", 1, [{}]);

      const result = await unreconcileAccount(mock.db, 1);
      expect(result).toEqual({ flipped: 5, deletedAdjustmentId: null });

      const clearCall = mock.calls
        .filter((c) => c.op === "update" && c.table === "accounts")
        .pop();
      expect(clearCall?.set).toMatchObject({
        lastReconciledAt: null,
        lastReconciledBalance: null,
      });
    });

    it("deletes the synthetic adjustment row and reverses its balance", async () => {
      mock.respondWithNth("select:accounts", 1, [
        {
          id: 1,
          name: "Chequing",
          balance: 50000,
          lastReconciledAt: "2026-04-10",
          lastReconciledBalance: 48765,
        },
      ]);
      mock.respondWithNth("select:reconciliations", 1, [
        { id: 15, accountId: 1, reconciledAt: "2026-04-10", statementBalance: 48765, adjustmentTransactionId: 999 },
      ]);
      mock.respondWithNth("update:transactions", 1, [{ id: 1 }]);
      mock.respondWithNth("select:transactions", 1, [
        { id: 999, amount: 1235 },
      ]);
      mock.respondWithNth("update:accounts", 1, [{}]);
      mock.respondWith("delete:transactions", []);
      mock.respondWith("delete:reconciliations", [{}]);
      mock.respondWithNth("select:reconciliations", 2, []);
      mock.respondWithNth("update:accounts", 2, [{}]);

      const result = await unreconcileAccount(mock.db, 1);
      expect(result.deletedAdjustmentId).toBe(999);
    });

    it("throws 404 if the account has never been reconciled", async () => {
      mock.respondWithNth("select:accounts", 1, [
        {
          id: 1,
          name: "Chequing",
          balance: 50000,
          lastReconciledAt: null,
          lastReconciledBalance: null,
        },
      ]);
      await expect(unreconcileAccount(mock.db, 1)).rejects.toMatchObject({
        status: 404,
      });
    });

    it("throws 404 if the account does not exist", async () => {
      mock.respondWith("select:accounts", []);
      await expect(unreconcileAccount(mock.db, 999)).rejects.toBeInstanceOf(
        TransactionError
      );
    });
  });

  describe("reconcile queries (integration with SQLite)", () => {
    let db: Db;

    beforeEach(() => {
      db = openMigratedDb();
    });

    it("BUG-3.2: excludes split parent transactions from all status aggregates (no double-counting)", async () => {
      const acct = await createAccount(db, { name: "Chequing", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat1] = await db.insert(schema.categories).values({ groupId: group.id, name: "Groceries", sort: 0 }).returning();
      const [cat2] = await db.insert(schema.categories).values({ groupId: group.id, name: "Household", sort: 1 }).returning();

      // 1. Uncleared plain transaction: -1000
      await createTransaction(db, {
        accountId: acct.id,
        categoryId: cat1.id,
        date: "2026-06-01",
        payee: "Bakery",
        amount: -1000,
        status: "u",
      });

      // 2. Uncleared split transaction: parent -5000, children -3000 and -2000
      await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-06-02",
          payee: "Supermarket",
          memo: "Groceries + Household",
          amount: -5000,
          status: "u",
        },
        [
          { categoryId: cat1.id, amount: -3000, memo: "Groceries" },
          { categoryId: cat2.id, amount: -2000, memo: "Household" },
        ]
      );

      // 3. Cleared plain transaction: +10000
      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-06-03",
        payee: "Direct Deposit",
        amount: 10000,
        status: "c",
      });

      // 4. Cleared split transaction: parent -4000, children -2500 and -1500
      await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-06-04",
          payee: "Department Store",
          memo: "Clothing + Home",
          amount: -4000,
          status: "c",
        },
        [
          { categoryId: cat1.id, amount: -2500, memo: "Clothing" },
          { categoryId: cat2.id, amount: -1500, memo: "Home" },
        ]
      );

      // 5. Reconciled plain transaction: +5000
      // Manually insert with status 'r' for test setup since createTransaction forbids direct 'r'
      await db.insert(schema.transactions).values({
        accountId: acct.id,
        categoryId: null,
        date: "2026-05-01",
        payee: "Old Deposit",
        amount: 5000,
        status: "r",
      });

      // 6. Reconciled split transaction: parent -2000, children -1000 and -1000
      const [recParent] = await db
        .insert(schema.transactions)
        .values({
          accountId: acct.id,
          categoryId: null,
          date: "2026-05-02",
          payee: "Old Split Store",
          amount: -2000,
          status: "r",
        })
        .returning();
      await db.insert(schema.transactions).values([
        {
          accountId: acct.id,
          categoryId: cat1.id,
          date: "2026-05-02",
          payee: "Old Split Store",
          amount: -1000,
          status: "r",
          parentId: recParent!.id,
        },
        {
          accountId: acct.id,
          categoryId: cat2.id,
          date: "2026-05-02",
          payee: "Old Split Store",
          amount: -1000,
          status: "r",
          parentId: recParent!.id,
        },
      ]);

      const state = await getReconcileState(db, acct.id, "2026-06-30");

      // Expected aggregates:
      // uncleared: -1000 (plain) + -3000 (child1) + -2000 (child2) = -6000 (count = 3)
      // cleared: 10000 (plain) + -2500 (child1) + -1500 (child2) = 6000 (count = 3)
      // reconciled: 5000 (plain) + -1000 (child1) + -1000 (child2) = 3000 (count = 3)
      // workingBalance: cleared (6000) + reconciled (3000) = 9000
      expect(state).toMatchObject({
        accountId: acct.id,
        accountName: "Chequing",
        workingBalance: 9000,
        unclearedTotal: -6000,
        unclearedCount: 3,
        clearedCount: 3,
        reconciledCount: 3,
      });

      // Reconciling with statement balance matching workingBalance (9000) should succeed with diff = 0 and no adjustment
      const recResult = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: 9000,
        statementDate: "2026-06-30",
      });
      expect(recResult.adjustmentTransactionId).toBeNull();
      expect(recResult.finalDiff).toBe(0);
    });

    it("BUG-3.3: includes inbound transfers and inbound split children in destination account reconcile aggregates, flip, and unreconcile", async () => {
      const srcAcct = await createAccount(db, { name: "Chequing", kind: "liquid" });
      const destAcct = await createAccount(db, { name: "Savings", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat] = await db.insert(schema.categories).values({ groupId: group.id, name: "Income / Other", sort: 0 }).returning();

      // 1. Cleared standalone transfer from src to dest: -10000 on src => +10000 on dest
      const t1 = await createTransfer(
        db,
        {
          accountId: srcAcct.id,
          date: "2026-06-01",
          payee: "Transfer to Savings",
          memo: "Savings transfer",
          amount: -10000,
          status: "c",
        },
        destAcct.id
      );

      // 2. Uncleared standalone transfer from src to dest: -2500 on src => +2500 on dest
      const t2 = await createTransfer(
        db,
        {
          accountId: srcAcct.id,
          date: "2026-06-02",
          payee: "Transfer to Savings",
          memo: "Pending savings",
          amount: -2500,
          status: "u",
          transferStatus: "u",
        },
        destAcct.id
      );

      // 3. Cleared split transaction on src with a transfer child to dest:
      // Parent: -50000, Child 1: -47000 (cat), Child 2: -3000 (transfer to dest => +3000 on dest)
      const splitResult = await createSplitWithChildren(
        db,
        {
          accountId: srcAcct.id,
          date: "2026-06-03",
          payee: "Split Payee",
          memo: "Split with savings leg",
          amount: -50000,
          status: "c",
        },
        [
          { categoryId: cat.id, amount: -47000, memo: "Spending portion" },
          { transferAccountId: destAcct.id, amount: -3000, memo: "Savings portion" },
        ]
      );
      const splitChildTransfer = splitResult.children.find(
        (c) => c.transferAccountId === destAcct.id
      )!;

      // Check destination account reconcile state before reconcile:
      // clearedSum: +10000 (t1) + +3000 (splitChild) = 13000 (count: 2)
      // unclearedTotal: +2500 (t2) (count: 1)
      // reconciledSum: 0 (count: 0)
      // workingBalance: cleared (13000) + reconciled (0) = 13000
      const destStateBefore = await getReconcileState(db, destAcct.id, "2026-06-30");
      expect(destStateBefore).toMatchObject({
        accountId: destAcct.id,
        accountName: "Savings",
        workingBalance: 13000,
        unclearedTotal: 2500,
        unclearedCount: 1,
        clearedCount: 2,
        reconciledCount: 0,
      });

      // Reconcile destination account with statement balance matching workingBalance (13000)
      const reconcileResult = await reconcileAccount(db, {
        accountId: destAcct.id,
        statementBalance: 13000,
        statementDate: "2026-06-30",
      });

      expect(reconcileResult).toMatchObject({
        reconciledCount: 2,
        adjustmentTransactionId: null,
        finalDiff: 0,
      });

      // Verify that t1 and splitChildTransfer had transferStatus flipped to 'r' in DB
      const [t1Db] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, t1.id));
      expect(t1Db?.status).toBe("c"); // Source side untouched
      expect(t1Db?.transferStatus).toBe("r"); // Destination side flipped
      expect(t1Db?.transferReconciliationId).toBeTruthy();

      const [splitChildDb] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, splitChildTransfer.id));
      expect(splitChildDb?.status).toBe("c");
      expect(splitChildDb?.transferStatus).toBe("r");
      expect(splitChildDb?.transferReconciliationId).toBe(t1Db?.transferReconciliationId);

      // Verify uncleared transfer t2 remains 'u'
      const [t2Db] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, t2.id));
      expect(t2Db?.status).toBe("u");
      expect(t2Db?.transferStatus).toBe("u");
      expect(t2Db?.transferReconciliationId).toBeNull();

      // State after reconcile:
      // clearedSum: 0 (count: 0)
      // reconciledSum: 13000 (count: 2)
      // workingBalance: 13000
      const destStateAfter = await getReconcileState(db, destAcct.id, "2026-06-30");
      expect(destStateAfter).toMatchObject({
        accountId: destAcct.id,
        workingBalance: 13000,
        clearedCount: 0,
        reconciledCount: 2,
        unclearedTotal: 2500,
        unclearedCount: 1,
      });

      // Unreconcile destination account: should flip the 2 inbound rows back to 'c'
      const unrecResult = await unreconcileAccount(db, destAcct.id);
      expect(unrecResult).toEqual({ flipped: 2, deletedAdjustmentId: null });

      const [t1DbRestored] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, t1.id));
      expect(t1DbRestored?.transferStatus).toBe("c");
      expect(t1DbRestored?.transferReconciliationId).toBeNull();

      const [splitChildDbRestored] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, splitChildTransfer.id));
      expect(splitChildDbRestored?.transferStatus).toBe("c");
      expect(splitChildDbRestored?.transferReconciliationId).toBeNull();

      const destStateUnrec = await getReconcileState(db, destAcct.id, "2026-06-30");
      expect(destStateUnrec).toMatchObject({
        accountId: destAcct.id,
        workingBalance: 13000,
        clearedCount: 2,
        reconciledCount: 0,
        unclearedTotal: 2500,
        unclearedCount: 1,
      });
    });

    it("BUG-04: maintains single-row transfer model with independent status per account side", async () => {
      const acctA = await createAccount(db, { name: "Checking", kind: "liquid" });
      const acctB = await createAccount(db, { name: "Savings", kind: "liquid" });

      // Create transfer from Account A to Account B:
      // Source (Account A) is cleared ('c')
      // Destination (Account B) is uncleared ('u')
      const transfer = await createTransfer(
        db,
        {
          accountId: acctA.id,
          date: "2026-06-01",
          amount: -50000, // -$500 on A, +$500 on B
          status: "c",
          transferStatus: "u",
        },
        acctB.id
      );

      // Verify initial state for Account A:
      // Account A sees transfer as cleared ('c')
      const stateA1 = await getReconcileState(db, acctA.id, "2026-06-30");
      expect(stateA1.clearedCount).toBe(1);
      expect(stateA1.unclearedCount).toBe(0);
      expect(stateA1.workingBalance).toBe(-50000);

      // Verify initial state for Account B:
      // Account B sees transfer in unclearedTotal with status 'u'
      const stateB1 = await getReconcileState(db, acctB.id, "2026-06-30");
      expect(stateB1.unclearedCount).toBe(1);
      expect(stateB1.unclearedTotal).toBe(50000);
      expect(stateB1.clearedCount).toBe(0);
      expect(stateB1.reconciledCount).toBe(0);
      expect(stateB1.workingBalance).toBe(0);

      // Reconcile Account A
      const recA = await reconcileAccount(db, {
        accountId: acctA.id,
        statementBalance: -50000,
        statementDate: "2026-06-30",
      });
      expect(recA.reconciledCount).toBe(1);

      // Assert Account A's view sees transfer as 'r'
      const stateA2 = await getReconcileState(db, acctA.id, "2026-06-30");
      expect(stateA2.reconciledCount).toBe(1);
      expect(stateA2.clearedCount).toBe(0);

      // Assert Account B's reconcile state returns transfer in unclearedTotal with status 'u'
      const stateB2 = await getReconcileState(db, acctB.id, "2026-06-30");
      expect(stateB2.unclearedTotal).toBe(50000);
      expect(stateB2.unclearedCount).toBe(1);
      expect(stateB2.clearedCount).toBe(0);
      expect(stateB2.reconciledCount).toBe(0);

      // Verify DB row has status 'r' for source and transferStatus 'u' for destination
      const [txDb1] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, transfer.id));
      expect(txDb1?.status).toBe("r");
      expect(txDb1?.reconciliationId).toBeTruthy();
      expect(txDb1?.transferStatus).toBe("u");
      expect(txDb1?.transferReconciliationId).toBeNull();

      // Now clear transfer on Account B and reconcile Account B
      await updateTransaction(db, transfer.id, { transferStatus: "c" });

      const stateB3 = await getReconcileState(db, acctB.id, "2026-06-30");
      expect(stateB3.clearedCount).toBe(1);
      expect(stateB3.unclearedCount).toBe(0);
      expect(stateB3.workingBalance).toBe(50000);

      const recB = await reconcileAccount(db, {
        accountId: acctB.id,
        statementBalance: 50000,
        statementDate: "2026-06-30",
      });
      expect(recB.reconciledCount).toBe(1);

      // Both sides are now reconciled
      const [txDb2] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, transfer.id));
      expect(txDb2?.status).toBe("r");
      expect(txDb2?.transferStatus).toBe("r");
      expect(txDb2?.reconciliationId).not.toBe(txDb2?.transferReconciliationId);

      // Unreconcile Account A only
      const unrecA = await unreconcileAccount(db, acctA.id);
      expect(unrecA.flipped).toBe(1);

      // Account A is restored to 'c', but Account B remains 'r'
      const [txDb3] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, transfer.id));
      expect(txDb3?.status).toBe("c");
      expect(txDb3?.reconciliationId).toBeNull();
      expect(txDb3?.transferStatus).toBe("r");
      expect(txDb3?.transferReconciliationId).toBeTruthy();

      const stateA4 = await getReconcileState(db, acctA.id, "2026-06-30");
      expect(stateA4.clearedCount).toBe(1);
      expect(stateA4.reconciledCount).toBe(0);

      const stateB4 = await getReconcileState(db, acctB.id, "2026-06-30");
      expect(stateB4.reconciledCount).toBe(1);
      expect(stateB4.clearedCount).toBe(0);
    });

    it("BUG-13: excludes split parents from status flips and reconciles split children with consistent counts", async () => {
      const acct = await createAccount(db, { name: "Chequing", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat1] = await db.insert(schema.categories).values({ groupId: group.id, name: "Groceries", sort: 0 }).returning();
      const [cat2] = await db.insert(schema.categories).values({ groupId: group.id, name: "Household", sort: 1 }).returning();

      // Create a split transaction where the parent has status 'c'
      const split = await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-06-05",
          payee: "Target",
          memo: "Groceries and Household",
          amount: -5000,
          status: "c",
        },
        [
          { categoryId: cat1!.id, amount: -3000, memo: "Groceries" },
          { categoryId: cat2!.id, amount: -2000, memo: "Household" },
        ]
      );

      // Explicitly set one child to uncleared 'u' to test asymmetric split state
      const [child1, child2] = split.children;
      await db
        .update(schema.transactions)
        .set({ status: "u" })
        .where(eq(schema.transactions.id, child2!.id));

      // Check reconcile state: only child1 (-3000) is cleared. Parent (-5000) and child2 (-2000) are not counted in clearedCount.
      const stateBefore = await getReconcileState(db, acct.id, "2026-06-30");
      expect(stateBefore.clearedCount).toBe(1);
      expect(stateBefore.workingBalance).toBe(-3000);
      expect(stateBefore.unclearedCount).toBe(1);
      expect(stateBefore.unclearedTotal).toBe(-2000);

      // Reconcile against statement balance matching workingBalance (-3000)
      const recResult = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: -3000,
        statementDate: "2026-06-30",
      });

      // Reconciled count must be 1 (matching clearedCount), NOT 2 (which would happen if parent were flipped)
      expect(recResult.reconciledCount).toBe(1);
      expect(recResult.finalDiff).toBe(0);

      // Verify child1 was flipped to 'r'
      const [child1Db] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child1!.id));
      expect(child1Db?.status).toBe("r");
      expect(child1Db?.reconciliationId).toBeTruthy();

      // Verify child2 remains 'u'
      const [child2Db] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child2!.id));
      expect(child2Db?.status).toBe("u");
      expect(child2Db?.reconciliationId).toBeNull();

      // Verify split parent was NOT flipped to 'r' (remains 'c')
      const [parentDb] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.parent.id));
      expect(parentDb?.status).toBe("c");
      expect(parentDb?.reconciliationId).toBeNull();

      // State after reconcile
      const stateAfter = await getReconcileState(db, acct.id, "2026-06-30");
      expect(stateAfter.clearedCount).toBe(0);
      expect(stateAfter.reconciledCount).toBe(1);
      expect(stateAfter.workingBalance).toBe(-3000);

      // Unreconcile account: should flip exactly 1 child back to 'c'
      const unrecResult = await unreconcileAccount(db, acct.id);
      expect(unrecResult.flipped).toBe(1);

      const [child1Restored] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child1!.id));
      expect(child1Restored?.status).toBe("c");
      expect(child1Restored?.reconciliationId).toBeNull();
    });

    it("BUG-26: reconciling an account with a fully cleared split flips both parent and children to 'r', and unreconciling restores them to 'c'", async () => {
      const acct = await createAccount(db, { name: "Chequing", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "Everyday Expenses", sort: 1 }).returning();
      const [cat1] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Groceries", sort: 1 }).returning();
      const [cat2] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Household", sort: 2 }).returning();

      const split = await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-06-05",
          payee: "Target",
          memo: "Groceries and Household",
          amount: -5000,
          status: "c",
        },
        [
          { categoryId: cat1!.id, amount: -3000, memo: "Groceries" },
          { categoryId: cat2!.id, amount: -2000, memo: "Household" },
        ]
      );

      // Reconcile with matching workingBalance (-5000)
      const recResult = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: -5000,
        statementDate: "2026-06-30",
      });

      expect(recResult.reconciledCount).toBe(2); // 2 children counted

      // Verify all split rows (parent and children) are now 'r'
      const rowsAfterRec = await db
        .select()
        .from(schema.transactions)
        .where(
          or(
            eq(schema.transactions.id, split.parent.id),
            eq(schema.transactions.parentId, split.parent.id)
          )
        );

      expect(rowsAfterRec).toHaveLength(3);
      for (const row of rowsAfterRec) {
        expect(row.status).toBe("r");
        expect(row.reconciliationId).toBeTruthy();
      }

      // Unreconcile
      const unrecResult = await unreconcileAccount(db, acct.id);
      expect(unrecResult.flipped).toBe(2);

      // Verify all split rows (parent and children) are restored to 'c'
      const rowsAfterUnrec = await db
        .select()
        .from(schema.transactions)
        .where(
          or(
            eq(schema.transactions.id, split.parent.id),
            eq(schema.transactions.parentId, split.parent.id)
          )
        );

      expect(rowsAfterUnrec).toHaveLength(3);
      for (const row of rowsAfterUnrec) {
        expect(row.status).toBe("c");
        expect(row.reconciliationId).toBeNull();
      }
    });

    it("BUG-05: migration 0017 backfills legacy multi-round reconciliations and unreconciles round-by-round", async () => {
      const acct = await createAccount(db, { name: "Chequing", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Reconcile Adjustments" }).returning();

      // Insert pre-migration Round 1 (April 2026): 1 regular tx + 1 adjustment tx
      const [tx1] = await db.insert(schema.transactions).values({
        accountId: acct.id,
        date: "2026-04-01",
        payee: "April Tx",
        amount: 10000,
        status: "r",
        reconciledAt: "2026-04-01",
        reconciliationId: null,
      }).returning();

      const [adj1] = await db.insert(schema.transactions).values({
        accountId: acct.id,
        categoryId: cat!.id,
        date: "2026-04-01",
        payee: RECONCILE_ADJUSTMENT_MEMO,
        memo: RECONCILE_ADJUSTMENT_MEMO,
        amount: 500,
        status: "r",
        reconciledAt: "2026-04-01",
        reconciliationId: null,
      }).returning();

      // Insert pre-migration Round 2 (May 2026): 1 regular tx + 1 adjustment tx
      const [tx2] = await db.insert(schema.transactions).values({
        accountId: acct.id,
        date: "2026-05-01",
        payee: "May Tx",
        amount: 20000,
        status: "r",
        reconciledAt: "2026-05-01",
        reconciliationId: null,
      }).returning();

      const [adj2] = await db.insert(schema.transactions).values({
        accountId: acct.id,
        categoryId: cat!.id,
        date: "2026-05-01",
        payee: RECONCILE_ADJUSTMENT_MEMO,
        memo: RECONCILE_ADJUSTMENT_MEMO,
        amount: -200,
        status: "r",
        reconciledAt: "2026-05-01",
        reconciliationId: null,
      }).returning();

      // Set account lastReconciledAt to 2026-05-01 (latest round) and adjust balance
      await db
        .update(schema.accounts)
        .set({
          balance: 30300,
          lastReconciledAt: "2026-05-01",
          lastReconciledBalance: 30300,
        })
        .where(eq(schema.accounts.id, acct.id));

      // Execute migration 0017 statements to backfill reconciliations and reconciliation_ids
      const mig17Sql = fs.readFileSync(path.resolve(MIGRATIONS_FOLDER, "0017_backfill_reconciliations.sql"), "utf8");
      for (const stmt of mig17Sql.split("--> statement-breakpoint")) {
        if (stmt.trim()) {
          db.run(sql.raw(stmt));
        }
      }

      // Verify reconciliations table has 2 distinct rounds backfilled
      const recRows = await db
        .select()
        .from(schema.reconciliations)
        .where(eq(schema.reconciliations.accountId, acct.id))
        .orderBy(schema.reconciliations.id);

      expect(recRows).toHaveLength(2);
      expect(recRows[0]?.reconciledAt).toBe("2026-04-01");
      expect(recRows[0]?.adjustmentTransactionId).toBe(adj1!.id);
      expect(recRows[1]?.reconciledAt).toBe("2026-05-01");
      expect(recRows[1]?.adjustmentTransactionId).toBe(adj2!.id);

      // Verify transactions have their respective reconciliation_id stamped
      const [tx1After] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx1!.id));
      const [tx2After] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx2!.id));
      expect(tx1After?.reconciliationId).toBe(recRows[0]!.id);
      expect(tx2After?.reconciliationId).toBe(recRows[1]!.id);

      // 1st Unreconcile: should only reverse Round 2 (May 2026)
      const unrec1 = await unreconcileAccount(db, acct.id);
      expect(unrec1.flipped).toBe(2); // tx2 + adj2 flipped before adj2 is deleted
      expect(unrec1.deletedAdjustmentId).toBe(adj2!.id); // adj2 deleted

      // tx2 is now 'c', tx1 is still 'r'
      const [tx2Unrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx2!.id));
      expect(tx2Unrec?.status).toBe("c");
      expect(tx2Unrec?.reconciliationId).toBeNull();

      const [tx1StillRec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx1!.id));
      expect(tx1StillRec?.status).toBe("r");
      expect(tx1StillRec?.reconciliationId).toBe(recRows[0]!.id);

      // adj1 still exists
      const [adj1StillExists] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, adj1!.id));
      expect(adj1StillExists).toBeDefined();

      // Account lastReconciledAt is restored to Round 1 ("2026-04-01")
      const [acctAfterUnrec1] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
      expect(acctAfterUnrec1?.lastReconciledAt).toBe("2026-04-01");

      // 2nd Unreconcile: reverses Round 1 (April 2026)
      const unrec2 = await unreconcileAccount(db, acct.id);
      expect(unrec2.flipped).toBe(2); // tx1 + adj1 flipped before adj1 is deleted
      expect(unrec2.deletedAdjustmentId).toBe(adj1!.id); // adj1 deleted

      const [tx1Unrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx1!.id));
      expect(tx1Unrec?.status).toBe("c");
      expect(tx1Unrec?.reconciliationId).toBeNull();

      // Account lastReconciledAt is now null
      const [acctAfterUnrec2] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
      expect(acctAfterUnrec2?.lastReconciledAt).toBeNull();
      expect(acctAfterUnrec2?.lastReconciledBalance).toBeNull();
    });

    it("BUG-05: unreconcileAccount gracefully resets inconsistent lastReconciledAt when reconciliations row is missing", async () => {
      const acct = await createAccount(db, { name: "Savings", kind: "liquid" });
      await db
        .update(schema.accounts)
        .set({ lastReconciledAt: "2026-05-01", lastReconciledBalance: 50000 })
        .where(eq(schema.accounts.id, acct.id));

      const unrec = await unreconcileAccount(db, acct.id);
      expect(unrec).toEqual({ flipped: 0, deletedAdjustmentId: null });

      const [acctCleaned] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
      expect(acctCleaned?.lastReconciledAt).toBeNull();
      expect(acctCleaned?.lastReconciledBalance).toBeNull();
    });

    it("BUG-38: foreign key cascades onDelete: 'set null' for reconciliationId and adjustmentTransactionId", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat] = await db
        .insert(schema.categories)
        .values({ groupId: group!.id, name: "Reconcile Adjustments" })
        .returning();

      // Create a transaction and reconcile with adjustment
      await createTransaction(db, {
        accountId: acct.id,
        date: "2026-04-01",
        payee: "Test Tx",
        amount: 10000,
        status: "c",
      });

      const recResult = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: 15000,
        statementDate: "2026-04-10",
        adjustmentCategoryId: cat!.id,
      });

      expect(recResult.adjustmentTransactionId).toBeTruthy();

      const [recRow] = await db
        .select()
        .from(schema.reconciliations)
        .where(eq(schema.reconciliations.accountId, acct.id));
      expect(recRow?.adjustmentTransactionId).toBe(recResult.adjustmentTransactionId);

      // Verify that deleting an adjustment transaction nulls adjustmentTransactionId on reconciliation
      await db.delete(schema.transactions).where(eq(schema.transactions.id, recResult.adjustmentTransactionId!));
      const [recAfterTxDelete] = await db
        .select()
        .from(schema.reconciliations)
        .where(eq(schema.reconciliations.id, recRow!.id));
      expect(recAfterTxDelete?.adjustmentTransactionId).toBeNull();

      // Verify that deleting a reconciliation nulls reconciliationId on associated transactions
      const [txBefore] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, acct.id));
      expect(txBefore?.reconciliationId).toBe(recRow!.id);

      await db.delete(schema.reconciliations).where(eq(schema.reconciliations.id, recRow!.id));
      const [txAfter] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, acct.id));
      expect(txAfter?.reconciliationId).toBeNull();
    });

    it("BUG-38: unreconcileAccount fails loudly when referenced adjustment transaction is missing", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });
      const today = "2026-04-10";

      // 1. Direct insert with foreign keys enabled rejects invalid adjustmentTransactionId
      expect(() => {
        db.insert(schema.reconciliations).values({
          accountId: acct.id,
          reconciledAt: today,
          statementDate: today,
          statementBalance: 50000,
          adjustmentTransactionId: 999999,
        }).run();
      }).toThrow(/FOREIGN KEY constraint failed/);

      // 2. Simulate legacy/corrupted database where foreign keys were bypassed
      db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.insert(schema.reconciliations).values({
        accountId: acct.id,
        reconciledAt: today,
        statementDate: today,
        statementBalance: 50000,
        adjustmentTransactionId: 999999,
      });
      db.run(sql`PRAGMA foreign_keys = ON`);

      await db
        .update(schema.accounts)
        .set({ lastReconciledAt: today, lastReconciledBalance: 50000 })
        .where(eq(schema.accounts.id, acct.id));

      await expect(unreconcileAccount(db, acct.id)).rejects.toThrow(
        /Adjustment transaction 999999 referenced by reconciliation/
      );
    });

    it("BUG-10: multi-round reconciliation and unreconciliation covering split transactions preserves consistent split-parent status across rounds without downgrade", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat1] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Groceries" }).returning();
      const [cat2] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Household" }).returning();

      // Round 1: Split transaction dated 2026-04-01
      const split1 = await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-04-01",
          payee: "Target",
          amount: -10000,
        },
        [
          { categoryId: cat1!.id, amount: -6000 },
          { categoryId: cat2!.id, amount: -4000 },
        ]
      );

      // Reconcile round 1
      const rec1 = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: -10000,
        statementDate: "2026-04-05",
      });
      expect(rec1.reconciledCount).toBe(2); // 2 children

      const [parentAfterRec1] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split1.parent.id));
      expect(parentAfterRec1?.status).toBe("r");

      // Round 2: New regular transaction dated 2026-05-01
      const tx2 = await createTransaction(db, {
        accountId: acct.id,
        date: "2026-05-01",
        payee: "Coffee",
        amount: -500,
        status: "c",
      });

      // Reconcile round 2
      const rec2 = await reconcileAccount(db, {
        accountId: acct.id,
        statementBalance: -10500,
        statementDate: "2026-05-05",
      });
      expect(rec2.reconciledCount).toBe(1);

      // Unreconcile round 2: should only un-reconcile tx2, NOT round 1's split parent or children
      const unrec = await unreconcileAccount(db, acct.id);
      expect(unrec.flipped).toBe(1);

      const [tx2AfterUnrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tx2!.id));
      expect(tx2AfterUnrec?.status).toBe("c");
      expect(tx2AfterUnrec?.reconciliationId).toBeNull();

      // Split 1 parent and children must remain 'r' belonging to round 1
      const [parentAfterUnrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split1.parent.id));
      const [child1AfterUnrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split1.children[0]!.id));
      const [child2AfterUnrec] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split1.children[1]!.id));

      expect(parentAfterUnrec?.status).toBe("r");
      expect(child1AfterUnrec?.status).toBe("r");
      expect(child2AfterUnrec?.status).toBe("r");

      const [acctRestored] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
      expect(acctRestored?.lastReconciledBalance).toBe(-10000);
      expect(acctRestored?.lastReconciledAt).toBe(rec1.lastReconciledAt);
    });
  });
});
