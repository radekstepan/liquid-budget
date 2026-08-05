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
      // Account with balance 1000, has 3 cleared (-100 each), 2 uncleared (+50 each), 1 reconciled (-200).
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 700, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWith("select:transactions", [
        {
          unclearedSum: 100,
          unclearedCount: 2,
          clearedCount: 3,
          reconciledCount: 1,
        },
      ]);

      const state = await getReconcileState(mock.db, 1);
      // workingBalance = current balance (700) − sum(uncleared) (100) = 600
      expect(state).toMatchObject({
        accountId: 1,
        accountName: "Chequing",
        workingBalance: 600,
        unclearedTotal: 100,
        unclearedCount: 2,
        clearedCount: 3,
        reconciledCount: 1,
        lastReconciledAt: null,
      });
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
      // getReconcileState: account + aggregate
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 500, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedCount: 7,
          reconciledCount: 0,
        },
      ]);
      // UPDATE transactions SET status='r' WHERE ... — returns the 7 flipped ids
      mock.respondWithNth("update:transactions", 1, [
        { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 },
      ]);
      // UPDATE accounts SET last_reconciled_at, last_reconciled_balance
      mock.respondWith("update:accounts", [{}]);

      const result = await reconcileAccount(mock.db, {
        accountId: 1,
        statementBalance: 500,
      });

      expect(result).toMatchObject({
        reconciledCount: 7,
        adjustmentTransactionId: null,
        finalDiff: 0,
      });

      // Verify the UPDATE was the c→r flip with the right WHERE.
      const flipCall = mock.calls.find(
        (c) => c.op === "update" && c.table === "transactions"
      );
      expect(flipCall?.set).toMatchObject({ status: "r" });
    });

    it("throws 422 when statement balance does not match and no adjustment category is provided", async () => {
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 500, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedCount: 3,
          reconciledCount: 0,
        },
      ]);

      await expect(
        reconcileAccount(mock.db, { accountId: 1, statementBalance: 487.65 })
      ).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
      });
    });

    it("posts an adjustment transaction and flips C → R when the diff is non-zero", async () => {
      // getReconcileState
      mock.respondWithNth("select:accounts", 1, [
        { id: 1, name: "Chequing", balance: 500, lastReconciledAt: null, lastReconciledBalance: null },
      ]);
      mock.respondWithNth("select:transactions", 1, [
        {
          unclearedSum: 0,
          unclearedCount: 0,
          clearedCount: 2,
          reconciledCount: 0,
        },
      ]);
      // postAdjustment: insert the synthetic row
      mock.respondWithNth("insert:transactions", 1, [{ id: 999 }]);
      // postAdjustment: bump account balance
      mock.respondWithNth("update:accounts", 1, [{}]);
      // reconcileAccount: flip C → R
      mock.respondWithNth("update:transactions", 1, [{ id: 1 }, { id: 2 }]);
      // reconcileAccount: stamp lastReconciledAt
      mock.respondWithNth("update:accounts", 2, [{}]);

      const result = await reconcileAccount(mock.db, {
        accountId: 1,
        statementBalance: 487.65,
        adjustmentCategoryId: 42,
      });

      // diff = working(500) − statement(487.65) = 12.35; adjustment amount = -12.35
      expect(result).toMatchObject({
        reconciledCount: 2,
        adjustmentTransactionId: 999,
        finalDiff: 0,
      });

      // Verify the adjustment insert used the sentinel memo and category.
      const insertCall = mock.calls.find(
        (c) => c.op === "insert" && c.table === "transactions"
      );
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: 42,
        memo: RECONCILE_ADJUSTMENT_MEMO,
        payee: RECONCILE_ADJUSTMENT_MEMO,
        amount: -12.35,
        status: "c",
      });
    });
  });

  describe("unreconcileAccount", () => {
    it("flips the most recent batch of R back to C and clears lastReconciledAt", async () => {
      mock.respondWithNth("select:accounts", 1, [
        {
          id: 1,
          name: "Chequing",
          balance: 500,
          lastReconciledAt: "2026-04-10",
          lastReconciledBalance: 500,
        },
      ]);
      // The flip: UPDATE transactions SET status='c' WHERE accountId=1 AND status='r' AND date <= '2026-04-10'
      mock.respondWithNth("update:transactions", 1, [
        { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
      ]);
      // The synthetic-adjustment lookup: SELECT id, amount FROM transactions WHERE ...
      mock.respondWithNth("select:transactions", 1, []);
      // Finally: UPDATE accounts SET last_reconciled_at=NULL, last_reconciled_balance=NULL
      mock.respondWithNth("update:accounts", 1, [{}]);

      const result = await unreconcileAccount(mock.db, 1);
      expect(result).toEqual({ flipped: 5, deletedAdjustmentId: null });

      // Verify the account was cleared of reconcile metadata.
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
          balance: 500,
          lastReconciledAt: "2026-04-10",
          lastReconciledBalance: 487.65,
        },
      ]);
      mock.respondWithNth("update:transactions", 1, [{ id: 1 }]);
      // The synthetic adjustment lookup
      mock.respondWithNth("select:transactions", 1, [
        { id: 999, amount: 12.35 },
      ]);
      // Balance reverse: UPDATE accounts SET balance = balance - 12.35
      mock.respondWithNth("update:accounts", 1, [{}]);
      // Adjustment delete
      mock.respondWith("delete:transactions", []);
      // Finally: clear lastReconciledAt
      mock.respondWithNth("update:accounts", 2, [{}]);

      const result = await unreconcileAccount(mock.db, 1);
      expect(result.deletedAdjustmentId).toBe(999);
    });

    it("throws 404 if the account has never been reconciled", async () => {
      mock.respondWithNth("select:accounts", 1, [
        {
          id: 1,
          name: "Chequing",
          balance: 500,
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
