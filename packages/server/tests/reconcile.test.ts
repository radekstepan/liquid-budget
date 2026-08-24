import { describe, expect, it, beforeEach } from "vitest";
import {
  getReconcileState,
  reconcileAccount,
  RECONCILE_ADJUSTMENT_MEMO,
  unreconcileAccount,
  TransactionError,
} from "../src/index.js";
import { createMockDb, type MockDb } from "./mock-db.js";

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
});
