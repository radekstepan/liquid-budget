import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  assertSplitsBalanced,
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createSplitWithChildren,
  createTransaction,
  createTransfer,
  deleteTransaction,
  TransactionError,
  updateSplit,
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
        amount: -500,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["run", "select", "insert", "update", "run"]);
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.table).toBe("transactions");
      const updateCall = mock.calls.find((c) => c.op === "update");
      expect(updateCall?.table).toBe("accounts");
    });

    it("does not apply balance when skipBalance is true (split parent)", async () => {
      mock.respondWith("insert:transactions", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: null,
        date: "2026-07-01",
        payee: "Costco",
        memo: "",
        amount: -10000,
        skipBalance: true,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["run", "select", "insert", "run"]);
    });

    it("persists a flagColor on insert", async () => {
      mock.respondWith("insert:transactions", [{ id: 1 }]);
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 2,
        date: "2026-07-01",
        payee: "Coffee",
        memo: "",
        amount: -500,
        flagColor: "red",
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({ flagColor: "red" });
    });

    it("sanitizes an invalid flagColor to null on insert", async () => {
      mock.respondWith("insert:transactions", [{ id: 1 }]);
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 2,
        date: "2026-07-01",
        payee: "Coffee",
        memo: "",
        amount: -500,
        flagColor: "neon-pink" as never,
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({ flagColor: null });
    });

    it("rejects the internal duplicate marker on insert (it is not user-writable)", async () => {
      mock.respondWith("insert:transactions", [{ id: 1 }]);
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 2,
        date: "2026-07-01",
        payee: "Coffee",
        memo: "",
        amount: -500,
        flagColor: "duplicate" as never,
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({ flagColor: null });
    });

    it("applies balance for split children (parentId set) regardless of skipBalance", async () => {
      mock.respondWith("insert:transactions", [{ id: 5 }]);
      mock.respondWith("update:accounts", [{}]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 10,
        date: "2026-07-01",
        payee: "Costco",
        memo: "",
        amount: -6000,
        parentId: 1,
        skipBalance: true,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["run", "select", "insert", "update", "run"]);
    });

    it("forces categoryId to null and isIncome to false for off-budget accounts", async () => {
      mock.respondWith("select:accounts", [{ id: 2, onBudget: false }]);
      mock.respondWith("insert:transactions", [{ id: 6 }]);
      mock.respondWith("update:accounts", [{}]);

      await createTransaction(mock.db, {
        accountId: 2,
        categoryId: 10,
        date: "2026-07-01",
        payee: "Brokerage",
        memo: "",
        amount: 50000,
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        accountId: 2,
        categoryId: null,
        isIncome: false,
        incomeMonth: null,
      });
    });
  });

  describe("createTransfer", () => {
    it("inserts a single row, updates both account balances, derives payee", async () => {
      mock.respondWith("select:accounts", [{ name: "EQ Bank" }]);
      mock.respondWith("insert:transactions", [{ id: 42 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      const row = await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "",
          memo: "",
          amount: -50000,
        },
        2
      );

      expect(row).toMatchObject({ id: 42 });
      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        payee: "Transfer : EQ Bank",
        transferAccountId: 2,
        categoryId: null,
        amount: -50000,
      });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "insert", "update", "update", "run"]);
    });

    it("inserts a transfer row with categoryId when specified", async () => {
      mock.respondWith("select:accounts", [{ name: "RRSP" }]);
      mock.respondWith("insert:transactions", [{ id: 43 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: 10,
          date: "2026-07-01",
          payee: "",
          memo: "RRSP contribution",
          amount: -50000,
        },
        2
      );

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        payee: "Transfer : RRSP",
        transferAccountId: 2,
        categoryId: 10,
        amount: -50000,
      });
    });

    it("rejects transfers to the same account", async () => {
      await expect(
        createTransfer(
          mock.db,
          {
            accountId: 1,
            categoryId: null,
            date: "2026-07-01",
            payee: "X",
            memo: "",
            amount: -10000,
          },
          1
        )
      ).rejects.toBeInstanceOf(TransactionError);
    });

    it("createTransaction routes a transferAccountId to createTransfer", async () => {
      mock.respondWith("select:accounts", [{ name: "EQ Bank" }]);
      mock.respondWith("insert:transactions", [{ id: 99 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      const row = await createTransaction(mock.db, {
        accountId: 1,
        categoryId: null,
        date: "2026-07-01",
        payee: "",
        memo: "",
        amount: -10000,
        transferAccountId: 2,
      });

      expect(row).toMatchObject({ id: 99 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "insert", "update", "update", "run"]);
    });

    it("allows a row that is both a transfer and a split child", async () => {
      mock.respondWith("insert:transactions", [
        { id: 88, accountId: 1, transferAccountId: 2, parentId: 5, amount: -1000 },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      const row = await createTransaction(mock.db, {
        accountId: 1,
        categoryId: null,
        date: "2026-07-01",
        payee: "Transfer : Savings",
        memo: "",
        amount: -1000,
        transferAccountId: 2,
        parentId: 5,
      });
      expect(row).toMatchObject({
        accountId: 1,
        transferAccountId: 2,
        parentId: 5,
        amount: -1000,
      });
    });

    it("UNI-02 / F-01: saves income transaction with incomeMonth", async () => {
      mock.respondWith("insert:transactions", [
        { id: 99, accountId: 1, categoryId: null, date: "2026-06-25", amount: 500000, isIncome: true, incomeMonth: "2026-07" },
      ]);
      mock.respondWith("update:accounts", [{}]);
      const row = await createTransaction(mock.db, {
        accountId: 1,
        categoryId: null,
        date: "2026-06-25",
        payee: "Employer",
        memo: "Deferred income",
        amount: 500000,
        incomeMonth: "2026-07",
      });
      expect(row).toMatchObject({
        isIncome: true,
        incomeMonth: "2026-07",
      });
    });

    it("rejects direct creation of a reconciled transaction", async () => {
      await expect(
        createTransaction(mock.db, {
          accountId: 1,
          categoryId: 2,
          date: "2026-07-01",
          payee: "Locked",
          memo: "",
          amount: -500,
          status: "r",
        })
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: /reconcile flow/,
      });
    });

    it("rejects amounts exceeding safe integer bounds", async () => {
      await expect(
        createTransaction(mock.db, {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "Overflow",
          memo: "",
          amount: 1e18,
        })
      ).rejects.toMatchObject({
        status: 400,
        name: "TransactionError",
      });
    });
  });

  describe("assertSplitsBalanced", () => {
    it("accepts a balanced split with categories", () => {
      expect(() =>
        assertSplitsBalanced(-10000, [
          { categoryId: 1, amount: -6000 },
          { categoryId: 2, amount: -4000 },
        ])
      ).not.toThrow();
    });

    it("accepts a balanced split with transfer subtransactions", () => {
      expect(() =>
        assertSplitsBalanced(-10000, [
          { categoryId: 1, amount: -6000 },
          { transferAccountId: 2, amount: -4000 },
        ])
      ).not.toThrow();
    });

    it("rejects a single sub-transaction", () => {
      expect(() =>
        assertSplitsBalanced(-5000, [{ categoryId: 1, amount: -5000 }])
      ).toThrow(TransactionError);
    });

    it("rejects a missing category or transfer account", () => {
      expect(() =>
        assertSplitsBalanced(-5000, [
          { categoryId: 1, amount: -3000 },
          { categoryId: 0, amount: -2000 },
        ])
      ).toThrow(/must have a category or transfer account/);
    });

    it("allows a sub-transaction with both category and transfer account (e.g. transfer to off-budget)", () => {
      expect(() =>
        assertSplitsBalanced(-5000, [
          { categoryId: 1, amount: -3000 },
          { categoryId: 2, transferAccountId: 3, amount: -2000 },
        ])
      ).not.toThrow();
    });

    it("rejects an off-by-cent mismatch", () => {
      expect(() =>
        assertSplitsBalanced(-5000, [
          { categoryId: 1, amount: -3001 },
          { categoryId: 2, amount: -2000 },
        ])
      ).toThrow(/do not sum to parent/);
    });

    it("accepts a positive parent with mixed-sign children (Paycheck with taxes)", () => {
      expect(() =>
        assertSplitsBalanced(400000, [
          { categoryId: 1, amount: 500000 },
          { categoryId: 2, amount: -100000 },
        ])
      ).not.toThrow();
    });

    it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
      expect(() =>
        assertSplitsBalanced(400000, [
          { categoryId: 1, amount: 500000 },
          { categoryId: 2, amount: -100001 },
        ])
      ).toThrow(/do not sum to parent/);
    });

    it("rejects when sign conventions conflict (negative parent with positive children)", () => {
      expect(() =>
        assertSplitsBalanced(-10000, [
          { categoryId: 1, amount: 6000 },
          { categoryId: 2, amount: 4000 },
        ])
      ).toThrow(/do not sum to parent/);
    });
  });

  describe("createSplitWithChildren", () => {
    it("inserts parent + N children, applies balance per child, skips parent", async () => {
      mock.respondWithNth("insert:transactions", 1, [
        { id: 1, accountId: 7, categoryId: null, date: "2026-07-01", payee: "Costco", memo: "", amount: -10000, status: "c", parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 2 }]);
      mock.respondWithNth("insert:transactions", 3, [{ id: 3 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      const result = await createSplitWithChildren(
        mock.db,
        {
          accountId: 7,
          date: "2026-07-01",
          payee: "Costco",
          memo: "",
          amount: -10000,
        },
        [
          { categoryId: 11, amount: -6000 },
          { categoryId: 12, amount: -4000 },
        ]
      );

      expect(result.parent).toMatchObject({ id: 1, categoryId: null, amount: -10000 });
      expect(result.children).toHaveLength(2);

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: null, categoryId: null });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, categoryId: 11 });
      expect(inserts[2]?.values).toMatchObject({ parentId: 1, categoryId: 12 });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual([
        "run", "insert", "select", "insert", "update", "insert", "update", "run",
      ]);
    });

    it("rejects an unbalanced split", async () => {
      await expect(
        createSplitWithChildren(
          mock.db,
          {
            accountId: 1,
            date: "2026-07-01",
            payee: "X",
            memo: "",
            amount: -10000,
          },
          [
            { categoryId: 1, amount: -6000 },
            { categoryId: 2, amount: -3999 },
          ]
        )
      ).rejects.toBeInstanceOf(TransactionError);
    });
  });

  describe("updateTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const row = await updateTransaction(mock.db, 99, { payee: "X" });
      expect(row).toBeNull();
    });

    it("updates a row without affecting balance when amount/account is unchanged", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, payee: "New" }]);
      mock.respondWith("insert:rename_rules", [
        { id: 5, sourcePattern: "Old", targetPayee: "New", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const row = await updateTransaction(mock.db, 1, { payee: "New" });
      expect(row).toMatchObject({ payee: "New" });
      const ops = mock.calls.map((c) => c.op);
      // The rename is also learned as an automatic rename rule after the
      // commit (select rename_rules -> BEGIN -> insert rule -> COMMIT ->
      // select again).
      expect(ops).toEqual([
        "select", "select", "run", "select", "update", "run",
        "select", "run", "insert", "run", "select",
      ]);
    });

    it("applies a balance correction when the amount changes", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -2000 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await updateTransaction(mock.db, 1, { amount: -2000 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "select", "run", "update", "update", "select", "update", "run"]);
    });

    it("updates a transfer: reverses both balances then applies both", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -10000, payee: "X", categoryId: null, date: "2026-07-01", parentId: null },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -20000 }]);
      mock.respondWith("update:accounts", [{}, {}, {}, {}]);

      await updateTransaction(mock.db, 1, { amount: -20000 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual([
        "select", "select",
        "run",
        "update", "update", "update", "update",
        "select",
        "update",
        "run",
      ]);
    });

    it("rejects amount changes on a split parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -10000, payee: "X", categoryId: null, date: "2026-07-01", transferAccountId: null, parentId: null },
      ]);
      mock.respondWith("select:transactions", [{ id: 2 }]);

      await expect(updateTransaction(mock.db, 1, { amount: -20000 })).rejects.toThrow(
        /split parent/
      );
    });

    it("persists a flagColor on update", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: "blue" }]);

      const row = await updateTransaction(mock.db, 1, { flagColor: "blue" });
      expect(row).toMatchObject({ flagColor: "blue" });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: "blue" });
    });

    it("clears a flagColor with an explicit null", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: null }]);

      await updateTransaction(mock.db, 1, { flagColor: null });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: null });
    });

    it("sanitizes the internal duplicate marker to null on update (not user-writable)", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: null }]);

      await updateTransaction(mock.db, 1, { flagColor: "duplicate" as never });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: null });
    });

    it("rejects changing the flag of a duplicate-flagged transaction", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c", flagColor: "duplicate" },
      ]);

      await expect(
        updateTransaction(mock.db, 1, { flagColor: "red" })
      ).rejects.toMatchObject({ status: 422, name: "TransactionError", message: /duplicate/ });

      await expect(
        updateTransaction(mock.db, 1, { flagColor: null })
      ).rejects.toMatchObject({ status: 422, name: "TransactionError", message: /duplicate/ });
    });

    it("UNI-08 / F-08: rejects modifying a reconciled transaction with 422 error", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, amount: -5000, status: "r", payee: "Locked Payee", date: "2026-07-01" },
      ]);

      await expect(updateTransaction(mock.db, 1, { amount: -6000 })).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: /reconciled and locked/i,
      });
    });

    it("forces categoryId to null and isIncome to false when updating transaction on off-budget account", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 2, amount: 5000, payee: "Brokerage", date: "2026-07-01", categoryId: null, transferAccountId: null, parentId: null, status: "c" },
      ]);
      mock.respondWithNth("select:transactions", 2, []); // childCount = 0
      mock.respondWith("select:accounts", [{ id: 2, onBudget: false }]);
      mock.respondWith("update:transactions", [{ id: 1, categoryId: null, isIncome: false }]);

      await updateTransaction(mock.db, 1, { categoryId: 10 });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: null, isIncome: false, incomeMonth: null });
    });
  });

  describe("updateSplit", () => {
    it("reverses old children balance, deletes them, inserts new, applies new balance", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Old", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [{ id: 2 }, { id: 3 }]);
      mock.respondWithNth("select:transactions", 3, [
        { id: 2, accountId: 5, amount: -6000 },
        { id: 3, accountId: 5, amount: -4000 },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 10 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 11 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await updateSplit(
        mock.db,
        1,
        { memo: "new memo" },
        [
          { categoryId: 1, amount: -7000 },
          { categoryId: 2, amount: -3000 },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -7000, memo: "new memo" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -3000, memo: "new memo" });
    });

    it("rejects a target row that has no children", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -5000, payee: "X", categoryId: null, parentId: null, transferAccountId: null, date: "2026-07-01" },
      ]);
      mock.respondWith("select:transactions", []);

      await expect(
        updateSplit(
          mock.db,
          1,
          {},
          [
            { categoryId: 1, amount: -2500 },
            { categoryId: 2, amount: -2500 },
          ]
        )
      ).rejects.toThrow(/no children/);
    });

    it("rejects changing the flag of a duplicate-flagged split parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -5000, payee: "X", categoryId: null, parentId: null, transferAccountId: null, status: "c", flagColor: "duplicate" },
      ]);

      await expect(
        updateSplit(
          mock.db,
          1,
          { flagColor: "red" },
          [
            { categoryId: 1, amount: -2500 },
            { categoryId: 2, amount: -2500 },
          ]
        )
      ).rejects.toMatchObject({ status: 422, name: "TransactionError", message: /duplicate/ });
    });

    it("UNI-08 / F-08: rejects modifying a reconciled split parent with 422 error", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 5, amount: -5000, payee: "X", categoryId: null, parentId: null, status: "r" },
      ]);

      await expect(
        updateSplit(
          mock.db,
          1,
          {},
          [
            { categoryId: 1, amount: -2500 },
            { categoryId: 2, amount: -2500 },
          ]
        )
      ).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: /Reconciled split transaction cannot be modified/,
      });
    });
  });

  describe("deleteTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const result = await deleteTransaction(mock.db, 99);
      expect(result).toBeNull();
    });

    it("UNI-08 / F-08: rejects deleting a reconciled transaction with 422 error", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, amount: -5000, status: "r" },
      ]);

      await expect(deleteTransaction(mock.db, 1)).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: /reconciled and locked/,
      });
    });

    it("deletes and reverses the balance (regular row)", async () => {
      mock.respondWithNth("select:transactions", 1, [{ id: 1, accountId: 1, amount: -5000, categoryId: 2, transferAccountId: null, parentId: null }]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 1);
      expect(result).toMatchObject({ id: 1 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "update", "delete", "run"]);
    });

    it("deleting a split parent reverses each child's balance before cascade", async () => {
      mock.respondWithNth("select:transactions", 1, [{ id: 1, accountId: 1, amount: -10000, categoryId: null, transferAccountId: null, parentId: null }]);
      mock.respondWith("select:transactions", [
        { id: 2, accountId: 1, amount: -6000, transferAccountId: null },
        { id: 3, accountId: 1, amount: -4000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "update", "update", "delete", "run"]);
    });

    it("deleting a transfer reverses both source and destination balances", async () => {
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -10000, parentId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "update", "update", "delete", "run"]);
    });

    it("deleting a split parent with transfer sub-transactions reverses source balance and destination transfer balance", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -10000, categoryId: null, transferAccountId: null, parentId: null },
      ]);
      mock.respondWith("select:transactions", [
        { id: 2, accountId: 1, amount: -6000, transferAccountId: null },
        { id: 3, accountId: 1, amount: -4000, transferAccountId: 2 },
      ]);
      mock.respondWith("update:accounts", [{}, {}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "update", "update", "update", "delete", "run"]);
      const updates = mock.calls.filter((c) => c.op === "update" && c.table === "accounts");
      expect(updates).toHaveLength(3);
    });

    it("deleting a split child directly when > 2 children exist reverses child balance without deleting parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null, categoryId: 10 },
      ]);
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 2);
      expect(result).toMatchObject({ id: 2 });
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(1);
    });

    it("deleting a split child transfer when > 2 children exist reverses both source and destination balances", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: 2, categoryId: null },
      ]);
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 2);
      const updates = mock.calls.filter((c) => c.op === "update" && c.table === "accounts");
      expect(updates).toHaveLength(2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(1);
    });

    it("deleting a split child when only 1 child remains cleans up remaining child and parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -6000, transferAccountId: null, categoryId: 10 },
      ]);
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: 2, categoryId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}, {}]);
      mock.respondWith("delete:transactions", [{}, {}, {}]);

      await deleteTransaction(mock.db, 2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(3);
    });

    it("rolls back transaction and rethrows when an error occurs during deletion", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -5000, categoryId: 2, transferAccountId: null, parentId: null },
      ]);
      mock.respondWith("select:transactions", []);
      mock.db.update = vi.fn().mockImplementation(() => {
        throw new Error("DB write failed");
      }) as unknown as typeof mock.db.update;

      await expect(deleteTransaction(mock.db, 1)).rejects.toThrow("DB write failed");
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toContain("run");
    });
  });

  describe("bulkDeleteTransactions", () => {
    it("deletes multiple transactions atomically", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, categoryId: 2, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, []); // children of 1
      mock.respondWithNth("select:transactions", 3, [
        { id: 2, accountId: 1, amount: -2000, categoryId: 2, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 4, []); // children of 2
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}, {}]);

      const res = await bulkDeleteTransactions(mock.db, [1, 2]);
      expect(res).toHaveLength(2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(2);
    });

    it("rejects bulk delete if any transaction is reconciled", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, status: "r" },
      ]);

      await expect(bulkDeleteTransactions(mock.db, [1])).rejects.toThrow(TransactionError);
    });
  });

  describe("bulkUpdateTransactions", () => {
    it("updates status and category on multiple transactions atomically", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, status: "u", categoryId: 1, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 2, status: "u", categoryId: 1, transferAccountId: null },
      ]);
      mock.respondWith("update:transactions", [{ id: 1, status: "c" }, { id: 2, status: "c" }]);

      const res = await bulkUpdateTransactions(mock.db, [1, 2], { status: "c" });
      expect(res).toHaveLength(2);
    });

    it("updates payee, memo, date and category on multiple transactions", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old Payee", status: "u", categoryId: 1, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:accounts", 1, [{ id: 1, onBudget: true }]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 2, accountId: 1, amount: -2000, payee: "Old Payee", status: "u", categoryId: 1, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:accounts", 2, [{ id: 1, onBudget: true }]);
      mock.respondWith("update:transactions", [
        { id: 1, payee: "New Payee", memo: "New Memo", date: "2026-09-01", categoryId: 3 },
        { id: 2, payee: "New Payee", memo: "New Memo", date: "2026-09-01", categoryId: 3 },
      ]);
      mock.respondWith("select:rename_rules", []);
      mock.respondWith("insert:rename_rules", [
        { id: 1, sourcePattern: "Old Payee", targetPayee: "New Payee", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const res = await bulkUpdateTransactions(mock.db, [1, 2], {
        payee: "New Payee",
        memo: "New Memo",
        date: "2026-09-01",
        categoryId: 3,
      });
      expect(res).toHaveLength(2);
    });

    it("rejects changing the flag of a duplicate-flagged transaction", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, status: "c", categoryId: 1, transferAccountId: null, flagColor: "duplicate" },
      ]);

      await expect(
        bulkUpdateTransactions(mock.db, [1], { flagColor: "red" })
      ).rejects.toMatchObject({ status: 422, name: "TransactionError", message: /duplicate/ });
    });

    it("forces categoryId to null and isIncome to false when bulk updating transactions on off-budget accounts", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 2, amount: 10000, payee: "Brokerage", status: "c", categoryId: null, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:accounts", 1, [{ id: 2, onBudget: false }]);
      mock.respondWith("update:transactions", [
        { id: 1, categoryId: null, isIncome: false },
      ]);

      const res = await bulkUpdateTransactions(mock.db, [1], { categoryId: 5 });
      expect(res).toHaveLength(1);
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: null, isIncome: false, incomeMonth: null });
    });
  });
});
