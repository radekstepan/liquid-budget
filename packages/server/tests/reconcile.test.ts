import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
      mock.respondWithNth("select:reconciliations", 1, []);
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
      mock.respondWithNth("select:reconciliations", 1, []);
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

      // Verify that t1 and splitChildTransfer were flipped to status 'r' in DB
      const [t1Db] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, t1.id));
      expect(t1Db?.status).toBe("r");
      expect(t1Db?.reconciliationId).toBeTruthy();

      const [splitChildDb] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, splitChildTransfer.id));
      expect(splitChildDb?.status).toBe("r");
      expect(splitChildDb?.reconciliationId).toBe(t1Db?.reconciliationId);

      // Verify uncleared transfer t2 remains 'u'
      const [t2Db] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, t2.id));
      expect(t2Db?.status).toBe("u");
      expect(t2Db?.reconciliationId).toBeNull();

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
      expect(t1DbRestored?.status).toBe("c");
      expect(t1DbRestored?.reconciliationId).toBeNull();

      const [splitChildDbRestored] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, splitChildTransfer.id));
      expect(splitChildDbRestored?.status).toBe("c");
      expect(splitChildDbRestored?.reconciliationId).toBeNull();

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

    it("BUG-14: fallback unreconcile flips all reconciled transactions with different dates on or before lastReconciledAt", async () => {
      const acct = await createAccount(db, { name: "Chequing", kind: "liquid" });

      // Directly insert multiple reconciled transactions with different dates and reconciledAt timestamps
      // simulating legacy or imported data without a reconciliations table row
      await db.insert(schema.transactions).values([
        {
          accountId: acct.id,
          date: "2026-04-01",
          payee: "April Tx 1",
          amount: 10000,
          status: "r",
          reconciledAt: "2026-04-01",
        },
        {
          accountId: acct.id,
          date: "2026-04-15",
          payee: "April Tx 2",
          amount: 20000,
          status: "r",
          reconciledAt: "2026-04-15",
        },
        {
          accountId: acct.id,
          date: "2026-05-01",
          payee: "May Tx 1",
          amount: 30000,
          status: "r",
          reconciledAt: "2026-05-01",
        },
      ]);

      // Set account lastReconciledAt to 2026-05-01
      await db
        .update(schema.accounts)
        .set({ lastReconciledAt: "2026-05-01", lastReconciledBalance: 60000 })
        .where(eq(schema.accounts.id, acct.id));

      // No row in schema.reconciliations, so unreconcileAccount uses fallback branch
      const unrecResult = await unreconcileAccount(db, acct.id);
      expect(unrecResult.flipped).toBe(3);

      const txs = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, acct.id));
      expect(txs.every((t) => t.status === "c" && t.reconciledAt === null)).toBe(true);

      const [updatedAcct] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, acct.id));
      expect(updatedAcct?.lastReconciledAt).toBeNull();
      expect(updatedAcct?.lastReconciledBalance).toBeNull();
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
  });
});
