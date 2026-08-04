import { describe, expect, it, beforeEach } from "vitest";
import {
  assertSplitsBalanced,
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
        amount: -5,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["insert", "update"]);
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
        amount: -100,
        skipBalance: true,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["insert"]);
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
        amount: -60,
        parentId: 1,
        skipBalance: true,
      });

      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["insert", "update"]);
    });
  });

  describe("createTransfer", () => {
    it("inserts a single row, updates both account balances, derives payee", async () => {
      // first call: select name for destination account
      mock.respondWith("select:accounts", [{ name: "EQ Bank" }]);
      mock.respondWith("insert:transactions", [{ id: 42 }]);
      // two balance updates: source, destination
      mock.respondWith("update:accounts", [{}, {}]);

      const row = await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "",
          memo: "",
          amount: -500,
        },
        2
      );

      expect(row).toMatchObject({ id: 42 });
      // Check insert was given the derived payee.
      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        payee: "Transfer : EQ Bank",
        transferAccountId: 2,
        categoryId: null,
        amount: -500,
      });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "insert", "update", "update"]);
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
            amount: -100,
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
        amount: -100,
        transferAccountId: 2,
      });

      expect(row).toMatchObject({ id: 99 });
      // 1 select (name) + 1 insert + 2 balance updates
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "insert", "update", "update"]);
    });

    it("rejects a row that is both a transfer and a split child", async () => {
      await expect(
        createTransaction(mock.db, {
          accountId: 1,
          categoryId: 10,
          date: "2026-07-01",
          payee: "X",
          memo: "",
          amount: -10,
          transferAccountId: 2,
          parentId: 5,
        })
      ).rejects.toBeInstanceOf(TransactionError);
    });
  });

  describe("assertSplitsBalanced", () => {
    it("accepts a balanced split", () => {
      expect(() =>
        assertSplitsBalanced(-100, [
          { categoryId: 1, amount: -60 },
          { categoryId: 2, amount: -40 },
        ])
      ).not.toThrow();
    });

    it("rejects a single sub-transaction", () => {
      expect(() =>
        assertSplitsBalanced(-50, [{ categoryId: 1, amount: -50 }])
      ).toThrow(TransactionError);
    });

    it("rejects a missing category", () => {
      expect(() =>
        assertSplitsBalanced(-50, [
          { categoryId: 1, amount: -30 },
          { categoryId: 0, amount: -20 },
        ])
      ).toThrow(/must have a category/);
    });

    it("rejects an off-by-cent mismatch", () => {
      expect(() =>
        assertSplitsBalanced(-50, [
          { categoryId: 1, amount: -30.01 },
          { categoryId: 2, amount: -20 },
        ])
      ).toThrow(/do not sum to parent/);
    });

    it("accepts a positive parent with mixed-sign children (Paycheck with taxes)", () => {
      // The bug fix: previously rejected because
      // |+5000| + |-1000| = 6000 ≠ |+4000|. The validation now uses
      // signed sums, so a gross pay + tax deduction is allowed.
      expect(() =>
        assertSplitsBalanced(4000, [
          { categoryId: 1, amount: 5000 },
          { categoryId: 2, amount: -1000 },
        ])
      ).not.toThrow();
    });

    it("rejects a mixed-sign split whose signed sum is off by a cent", () => {
      expect(() =>
        assertSplitsBalanced(4000, [
          { categoryId: 1, amount: 5000 },
          { categoryId: 2, amount: -1001 },
        ])
      ).toThrow(/do not sum to parent/);
    });

    it("rejects when sign conventions conflict (negative parent with positive children)", () => {
      // Negative parent + all-positive children: the signed sum is +100
      // which does not equal the parent's -100. Magnitude-only validation
      // would (incorrectly) accept this; the new signed validation rejects.
      expect(() =>
        assertSplitsBalanced(-100, [
          { categoryId: 1, amount: 60 },
          { categoryId: 2, amount: 40 },
        ])
      ).toThrow(/do not sum to parent/);
    });
  });

  describe("createSplitWithChildren", () => {
    it("inserts parent + N children, applies balance per child, skips parent", async () => {
      mock.respondWithNth("insert:transactions", 1, [
        { id: 1, accountId: 7, categoryId: null, date: "2026-07-01", payee: "Costco", memo: "", amount: -100, cleared: true, parentId: null, transferAccountId: null },
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
          amount: -100,
        },
        [
          { categoryId: 11, amount: -60 },
          { categoryId: 12, amount: -40 },
        ]
      );

      expect(result.parent).toMatchObject({ id: 1, categoryId: null, amount: -100 });
      expect(result.children).toHaveLength(2);

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: null, categoryId: null });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, categoryId: 11 });
      expect(inserts[2]?.values).toMatchObject({ parentId: 1, categoryId: 12 });

      // 3 inserts (parent, child 1, child 2) + 2 balance updates (one per
      // child, NOT the parent). Balance updates are interleaved with
      // inserts as each child is inserted and its balance applied.
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual([
        "insert", "insert", "update", "insert", "update",
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
            amount: -100,
          },
          [
            { categoryId: 1, amount: -60 },
            { categoryId: 2, amount: -39.99 },
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
      // 1st select: existing row
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -10, payee: "Old", date: "2026-07-01" },
      ]);
      // default for subsequent selects (child count check): empty
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, payee: "New" }]);

      const row = await updateTransaction(mock.db, 1, { payee: "New" });
      expect(row).toMatchObject({ payee: "New" });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "select", "update"]);
    });

    it("applies a balance correction when the amount changes", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -10, payee: "Old", date: "2026-07-01" },
      ]);
      // default: child count empty → not a split parent
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -20 }]);
      // 2 balance updates: reverse old, apply delta
      mock.respondWith("update:accounts", [{}, {}]);

      await updateTransaction(mock.db, 1, { amount: -20 });
      const ops = mock.calls.map((c) => c.op);
      // 2 selects, 1 transaction update, 2 balance updates
      expect(ops).toEqual(["select", "select", "update", "update", "update"]);
    });

    it("updates a transfer: reverses both balances then applies both", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -100, payee: "X" },
      ]);
      // default: child count empty
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -200 }]);
      // 4 balance updates: -src, +dst, +src, -dst
      mock.respondWith("update:accounts", [{}, {}, {}, {}]);

      await updateTransaction(mock.db, 1, { amount: -200 });
      const ops = mock.calls.map((c) => c.op);
      // 2 selects + 4 balance updates + 1 transaction update
      expect(ops).toEqual([
        "select", "select",
        "update", "update", "update", "update",
        "update",
      ]);
    });

    it("rejects amount changes on a split parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -100, payee: "X" },
      ]);
      // default: child count non-empty → split parent
      mock.respondWith("select:transactions", [{ id: 2 }]);

      await expect(updateTransaction(mock.db, 1, { amount: -200 })).rejects.toThrow(
        /split parent/
      );
    });
  });

  describe("updateSplit", () => {
    it("reverses old children balance, deletes them, inserts new, applies new balance", async () => {
      // 1st select: parent
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -100, payee: "Old", date: "2026-07-01", cleared: true },
      ]);
      // 2nd select: child count (non-empty)
      mock.respondWithNth("select:transactions", 2, [{ id: 2 }, { id: 3 }]);
      // 3rd select: getChildren (the actual rows for balance reversal + delete)
      mock.respondWithNth("select:transactions", 3, [
        { id: 2, accountId: 5, amount: -60 },
        { id: 3, accountId: 5, amount: -40 },
      ]);
      // 2 balance reversals
      mock.respondWith("update:accounts", [{}, {}]);
      // 1 delete of old children
      mock.respondWith("delete:transactions", [{}]);
      // parent update
      mock.respondWith("update:transactions", [{}]);
      // 2 new child inserts
      mock.respondWithNth("insert:transactions", 1, [{ id: 10 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 11 }]);
      // 2 balance applies for new children
      mock.respondWith("update:accounts", [{}, {}]);

      await updateSplit(
        mock.db,
        1,
        { memo: "new memo" },
        [
          { categoryId: 1, amount: -70 },
          { categoryId: 2, amount: -30 },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -70, memo: "new memo" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -30, memo: "new memo" });
    });

    it("rejects a target row that has no children", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -50, payee: "X" },
      ]);
      // child count: empty
      mock.respondWith("select:transactions", []);

      await expect(
        updateSplit(
          mock.db,
          1,
          {},
          [
            { categoryId: 1, amount: -25 },
            { categoryId: 2, amount: -25 },
          ]
        )
      ).rejects.toThrow(/no children/);
    });
  });

  describe("deleteTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const result = await deleteTransaction(mock.db, 99);
      expect(result).toBeNull();
    });

    it("deletes and reverses the balance (regular row)", async () => {
      // 1st select: existing row
      mock.respondWithNth("select:transactions", 1, [{ id: 1, accountId: 1, amount: -50 }]);
      // 2nd select: children of id 1 (returns empty → regular row, not a parent)
      mock.respondWith("select:transactions", []);
      // 1 balance update
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 1);
      expect(result).toMatchObject({ id: 1 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "select", "update", "delete"]);
    });

    it("deleting a split parent reverses each child's balance before cascade", async () => {
      // 1st select: existing parent
      mock.respondWithNth("select:transactions", 1, [{ id: 1, accountId: 1, amount: -100 }]);
      // 2nd select: children of id 1 (non-empty → parent)
      mock.respondWith("select:transactions", [
        { id: 2, accountId: 1, amount: -60 },
        { id: 3, accountId: 1, amount: -40 },
      ]);
      // 2 balance reversals
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "select", "update", "update", "delete"]);
    });

    it("deleting a transfer reverses both source and destination balances", async () => {
      // 1st select: existing transfer (no childCount — transfer is detected first)
      mock.respondWith("select:transactions", [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -100 },
      ]);
      // 2 balance reversals
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "update", "update", "delete"]);
    });
  });
});
