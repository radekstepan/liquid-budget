import { describe, expect, it, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, or } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import {
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
import { assertSplitsBalanced } from "@ynab/logic";
import * as schema from "../src/schema.js";
import { reconcileAccount, unreconcileAccount } from "../src/queries/reconcile.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("transactions queries", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

  function openMigratedDb() {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  async function seedTestData(db: ReturnType<typeof openMigratedDb>) {
    const [account] = await db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 0,
        onBudget: true,
        sort: 0,
      })
      .returning();

    const [group] = await db
      .insert(schema.categoryGroups)
      .values({
        name: "Living",
        sort: 0,
      })
      .returning();

    const [cat1] = await db
      .insert(schema.categories)
      .values({
        groupId: group!.id,
        name: "Groceries",
        sort: 0,
      })
      .returning();

    const [cat2] = await db
      .insert(schema.categories)
      .values({
        groupId: group!.id,
        name: "Rent",
        sort: 1,
      })
      .returning();

    return {
      accountId: account!.id,
      groupId: group!.id,
      cat1Id: cat1!.id,
      cat2Id: cat2!.id,
    };
  }

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

    it("BUG 1.5: forces isIncome to false and incomeMonth to null when categoryId is provided on on-budget accounts even if isIncome is true", async () => {
      mock.respondWith("select:accounts", [{ id: 1, onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 7 }]);
      mock.respondWith("update:accounts", [{}]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 7,
        date: "2026-07-01",
        payee: "Store Refund",
        memo: "Refund",
        amount: 5000,
        isIncome: true,
        incomeMonth: "2026-08",
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        accountId: 1,
        categoryId: 7,
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
      expect(ops).toEqual(["select", "run", "select", "select", "insert", "update", "update", "run"]);
    });

    it("inserts a transfer row with categoryId when specified", async () => {
      // RRSP is off-budget, so boundary crossing transfer preserves categoryId
      mock.respondWithNth("select:accounts", 1, [{ name: "RRSP" }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: false }]);
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

    it("treats boundary-crossing transfer from off-budget to on-budget as income", async () => {
      // account 1: onBudget: true (Checking), account 2: onBudget: false (Brokerage)
      mock.respondWithNth("select:accounts", 1, [{ name: "Brokerage" }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: false }]);
      mock.respondWith("insert:transactions", [{ id: 44 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "",
          memo: "Transfer from brokerage",
          amount: 1000000, // +$10,000 to Checking
        },
        2
      );

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        payee: "Transfer : Brokerage",
        transferAccountId: 2,
        categoryId: null,
        amount: 1000000,
        isIncome: true,
      });
    });

    it("forces isIncome: true on uncategorized boundary-crossing transfer from off-budget to on-budget even if isIncome is false", async () => {
      mock.respondWithNth("select:accounts", 1, [{ name: "Brokerage" }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: false }]);
      mock.respondWith("insert:transactions", [{ id: 45 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "",
          memo: "Transfer from brokerage",
          amount: 1000000,
          isIncome: false,
        },
        2
      );

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({
        payee: "Transfer : Brokerage",
        transferAccountId: 2,
        categoryId: null,
        amount: 1000000,
        isIncome: true,
      });
    });

    it("rejects boundary-crossing transfer from on-budget to off-budget without a category", async () => {
      mock.respondWithNth("select:accounts", 1, [{ name: "Brokerage" }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: false }]);

      await expect(
        createTransfer(
          mock.db,
          {
            accountId: 1,
            categoryId: null,
            date: "2026-07-01",
            payee: "",
            memo: "Fund brokerage",
            amount: -50000,
          },
          2
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: "Boundary transfer outflow requires a category",
      });
    });

    it("rejects boundary-crossing transfer outflow recorded from off-budget account without a category", async () => {
      mock.respondWithNth("select:accounts", 1, [{ name: "Checking" }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: true }]);

      await expect(
        createTransfer(
          mock.db,
          {
            accountId: 2,
            categoryId: null,
            date: "2026-07-01",
            payee: "",
            memo: "Fund brokerage",
            amount: 50000,
          },
          1
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: "Boundary transfer outflow requires a category",
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

    it("rounds float amounts to nearest integer cent", async () => {
      mock.respondWith("select:accounts", [{ name: "EQ Bank" }]);
      mock.respondWith("insert:transactions", [{ id: 43 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createTransfer(
        mock.db,
        {
          accountId: 1,
          categoryId: null,
          date: "2026-07-01",
          payee: "",
          memo: "",
          amount: -50000.4,
        },
        2
      );

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({ amount: -50000 });
    });

    it("rejects direct creation of a reconciled transfer", async () => {
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
            status: "r",
          },
          2
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: /reconcile flow/,
      });
    });

    it("createTransaction routes a transferAccountId to createTransfer", async () => {
      mock.respondWith("select:accounts", [{ name: "EQ Bank", onBudget: true }]);
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
      expect(ops).toEqual(["select", "run", "select", "select", "insert", "update", "update", "run"]);
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

    it("rounds float amounts to nearest integer cent", async () => {
      mock.respondWith("insert:transactions", [{ id: 8 }]);
      mock.respondWith("update:accounts", [{ id: 1 }]);

      await createTransaction(mock.db, {
        accountId: 1,
        categoryId: 2,
        date: "2026-07-01",
        payee: "Coffee",
        memo: "",
        amount: -500.4,
      });

      const insert = mock.calls.find((c) => c.op === "insert");
      expect(insert?.values).toMatchObject({ amount: -500 });
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
    it("rounds float amounts and accepts matching rounded split", () => {
      expect(() =>
        assertSplitsBalanced(-10000.4, [
          { categoryId: 1, amount: -6000.2 },
          { categoryId: 2, amount: -4000.2 },
        ])
      ).not.toThrow();
    });

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
      ).toThrow(/at least two/);
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

    it("accepts a mixed-sign paycheck split with an income leg (null category)", () => {
      expect(() =>
        assertSplitsBalanced(400000, [
          { categoryId: null, amount: 500000 },
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

    it("BUG-20: creates split with custom per-child payee when specified", async () => {
      mock.respondWithNth("insert:transactions", 1, [
        { id: 1, accountId: 7, categoryId: null, date: "2026-07-01", payee: "Costco", memo: "", amount: -10000, status: "c", parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 2 }]);
      mock.respondWithNth("insert:transactions", 3, [{ id: 3 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createSplitWithChildren(
        mock.db,
        {
          accountId: 7,
          date: "2026-07-01",
          payee: "Costco",
          memo: "",
          amount: -10000,
        },
        [
          { categoryId: 11, amount: -6000, payee: "Costco Pharmacy" },
          { categoryId: 12, amount: -4000 },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: null, payee: "Costco" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, categoryId: 11, payee: "Costco Pharmacy" });
      expect(inserts[2]?.values).toMatchObject({ parentId: 1, categoryId: 12, payee: "Costco" });
    });

    it("rounds parent and child float amounts on insert", async () => {
      mock.respondWithNth("insert:transactions", 1, [
        { id: 1, accountId: 7, categoryId: null, date: "2026-07-01", payee: "Costco", memo: "", amount: -10000, status: "c", parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 2 }]);
      mock.respondWithNth("insert:transactions", 3, [{ id: 3 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await createSplitWithChildren(
        mock.db,
        {
          accountId: 7,
          date: "2026-07-01",
          payee: "Costco",
          memo: "",
          amount: -10000.4,
        },
        [
          { categoryId: 11, amount: -6000.2 },
          { categoryId: 12, amount: -4000.2 },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ amount: -10000 });
      expect(inserts[1]?.values).toMatchObject({ amount: -6000 });
      expect(inserts[2]?.values).toMatchObject({ amount: -4000 });
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

    it("rejects a child whose transferAccountId matches parent accountId", async () => {
      await expect(
        createSplitWithChildren(
          mock.db,
          {
            accountId: 7,
            date: "2026-07-01",
            payee: "Self Transfer",
            memo: "",
            amount: -10000,
          },
          [
            { categoryId: 1, amount: -6000 },
            { transferAccountId: 7, amount: -4000 },
          ]
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: "transfer account must differ from source account",
      });
    });
  });

  describe("updateTransaction", () => {
    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:transactions", []);
      const row = await updateTransaction(mock.db, 99, { payee: "X" });
      expect(row).toBeNull();
    });

    it("updates a row without affecting balance when amount/account is unchanged", async () => {
      const rowData = { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
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
        "select", "run", "select", "select", "select", "update", "run",
        "select", "run", "insert", "run", "select",
      ]);
    });

    it("applies a balance correction when the amount changes", async () => {
      const rowData = { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -2000 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      await updateTransaction(mock.db, 1, { amount: -2000 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "select", "update", "update", "select", "update", "run"]);
    });

    it("updates a transfer: reverses both balances then applies both", async () => {
      const rowData = { id: 1, accountId: 1, transferAccountId: 2, amount: -10000, payee: "X", categoryId: null, date: "2026-07-01", parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, amount: -20000 }]);
      mock.respondWith("update:accounts", [{}, {}, {}, {}]);

      await updateTransaction(mock.db, 1, { amount: -20000 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual([
        "select", "run", "select", "select",
        "update", "update", "update", "update",
        "select", "select",
        "update",
        "run",
      ]);
    });

    it("rejects amount changes on a split parent", async () => {
      const rowData = { id: 1, accountId: 1, amount: -10000, payee: "X", categoryId: null, date: "2026-07-01", transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", [{ id: 2 }]);

      await expect(updateTransaction(mock.db, 1, { amount: -20000 })).rejects.toThrow(
        /split parent/
      );
    });

    it("rejects account changes on a split child", async () => {
      const rowData = { id: 2, parentId: 1, accountId: 1, amount: -3000, payee: "X", categoryId: 10, date: "2026-07-01", transferAccountId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // parent query
      mock.respondWithNth("select:transactions", 3, [rowData]); // re-read
      mock.respondWith("select:transactions", []);

      await expect(updateTransaction(mock.db, 2, { accountId: 2 })).rejects.toThrow(
        /split child/
      );
    });

    it("persists a flagColor on update", async () => {
      const rowData = { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: "blue" }]);

      const row = await updateTransaction(mock.db, 1, { flagColor: "blue" });
      expect(row).toMatchObject({ flagColor: "blue" });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: "blue" });
    });

    it("clears a flagColor with an explicit null", async () => {
      const rowData = { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: null }]);

      await updateTransaction(mock.db, 1, { flagColor: null });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: null });
    });

    it("sanitizes the internal duplicate marker to null on update (not user-writable)", async () => {
      const rowData = { id: 1, accountId: 1, amount: -1000, payee: "Old", date: "2026-07-01", categoryId: 2, transferAccountId: null, parentId: null, status: "c" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: null }]);

      await updateTransaction(mock.db, 1, { flagColor: "duplicate" as never });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ flagColor: null });
    });

    it("allows changing the flag of a duplicate-flagged transaction (BUG-10)", async () => {
      const rowData = {
        id: 1,
        accountId: 1,
        amount: -1000,
        payee: "Old",
        date: "2026-07-01",
        categoryId: 2,
        transferAccountId: null,
        parentId: null,
        status: "c",
        flagColor: "duplicate",
      };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: "red" }]);

      const updated = await updateTransaction(mock.db, 1, { flagColor: "red" });
      expect(updated).toMatchObject({ flagColor: "red" });
    });

    it("allows clearing the flag of a duplicate-flagged transaction (BUG-10)", async () => {
      const rowData = {
        id: 1,
        accountId: 1,
        amount: -1000,
        payee: "Old",
        date: "2026-07-01",
        categoryId: 2,
        transferAccountId: null,
        parentId: null,
        status: "c",
        flagColor: "duplicate",
      };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:transactions", [{ id: 1, flagColor: null }]);

      const cleared = await updateTransaction(mock.db, 1, { flagColor: null });
      expect(cleared).toMatchObject({ flagColor: null });
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
      const rowData = { id: 1, accountId: 2, amount: 5000, payee: "Brokerage", date: "2026-07-01", categoryId: null, transferAccountId: null, parentId: null, status: "c" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 3, []); // childCount = 0
      mock.respondWith("select:accounts", [{ id: 2, onBudget: false }]);
      mock.respondWith("update:transactions", [{ id: 1, categoryId: null, isIncome: false }]);

      await updateTransaction(mock.db, 1, { categoryId: 10 });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: null, isIncome: false, incomeMonth: null });
    });

    it("BUG 1.5: forces isIncome to false and incomeMonth to null when updating transaction with categoryId on on-budget account", async () => {
      const rowData = { id: 1, accountId: 1, amount: 5000, payee: "Store", date: "2026-07-01", categoryId: null, transferAccountId: null, parentId: null, status: "c", isIncome: true, incomeMonth: "2026-08" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 3, []); // childCount = 0
      mock.respondWith("select:accounts", [{ id: 1, onBudget: true }]);
      mock.respondWith("update:transactions", [{ id: 1, categoryId: 7, isIncome: false }]);

      await updateTransaction(mock.db, 1, { categoryId: 7, isIncome: true });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: 7, isIncome: false, incomeMonth: null });
    });

    it("BUG-19: preserves categoryId on expense when updating single field (e.g. status) with undefined fields", async () => {
      const rowData = { id: 1, accountId: 1, amount: -5000, payee: "Groceries", date: "2026-07-01", categoryId: 4, transferAccountId: null, parentId: null, status: "u", isIncome: false, incomeMonth: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 3, []); // childCount = 0
      mock.respondWith("select:accounts", [{ id: 1, onBudget: true }]);
      mock.respondWith("update:transactions", [{ id: 1, status: "c", categoryId: 4 }]);

      await updateTransaction(mock.db, 1, {
        accountId: undefined,
        categoryId: undefined,
        date: undefined,
        payee: undefined,
        memo: undefined,
        amount: undefined,
        status: "c",
        flagColor: undefined,
        incomeMonth: undefined,
      });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ status: "c", isIncome: false });
      expect(update?.set).not.toHaveProperty("categoryId");
    });

    it("BUG-19: preserves incomeMonth on income transaction when updating single field (e.g. status) with undefined fields", async () => {
      const rowData = { id: 1, accountId: 1, amount: 5000, payee: "Employer", date: "2026-07-01", categoryId: null, transferAccountId: null, parentId: null, status: "u", isIncome: true, incomeMonth: "2026-08" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 3, []); // childCount = 0
      mock.respondWith("select:accounts", [{ id: 1, onBudget: true }]);
      mock.respondWith("update:transactions", [{ id: 1, status: "c", incomeMonth: "2026-08" }]);

      await updateTransaction(mock.db, 1, {
        accountId: undefined,
        categoryId: undefined,
        date: undefined,
        payee: undefined,
        memo: undefined,
        amount: undefined,
        status: "c",
        flagColor: undefined,
        incomeMonth: undefined,
      });

      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ status: "c", isIncome: true });
      expect(update?.set).not.toHaveProperty("incomeMonth");
      expect(update?.set).not.toHaveProperty("categoryId");
    });

    it("rejects setting status to 'r' via updateTransaction", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -5000, status: "c", payee: "Store", date: "2026-07-01" },
      ]);

      await expect(
        updateTransaction(mock.db, 1, { status: "r" })
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: /reconcile flow/,
      });
    });

    it("rejects updating a reconciled transaction even with status 'c' via updateTransaction", async () => {
      mock.respondWithNth("select:transactions", 1, [
        {
          id: 1,
          accountId: 1,
          amount: -5000,
          status: "r",
          payee: "Store",
          date: "2026-07-01",
          reconciledAt: "2026-07-01",
          reconciliationId: 10,
          transferAccountId: null,
          parentId: null,
        },
      ]);

      await expect(updateTransaction(mock.db, 1, { status: "c" })).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: /reconciled and locked/i,
      });
    });
  });

  describe("updateSplit", () => {
    it("reverses old children balance, deletes them, inserts new, applies new balance", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Old", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
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

    it("BUG-20: preserves custom child payee and updates non-custom payee when parent payee changes", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Amazon", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 2, accountId: 5, amount: -6000, payee: "Amazon Seller A", memo: "Item A", status: "c", transferAccountId: null, categoryId: 1 },
        { id: 3, accountId: 5, amount: -4000, payee: "Amazon", memo: "Item B", status: "c", transferAccountId: null, categoryId: 2 },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 10 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 11 }]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("select:rename_rules", []);
      mock.respondWith("insert:rename_rules", [{ id: 1, rule: "Amazon", replacement: "Amazon.com" }]);

      await updateSplit(
        mock.db,
        1,
        { payee: "Amazon.com" },
        [
          { id: 2, categoryId: 1, amount: -6000, memo: "Item A" },
          { id: 3, categoryId: 2, amount: -4000, memo: "Item B" },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      // Child 1 preserves its custom payee "Amazon Seller A"
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -6000, payee: "Amazon Seller A" });
      // Child 2 had parent's old payee "Amazon", so it gets updated to "Amazon.com"
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -4000, payee: "Amazon.com" });
    });

    it("BUG-20: updates child payee when explicitly specified in updateSplit subTransactions", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Amazon", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 2, accountId: 5, amount: -6000, payee: "Amazon Seller A", memo: "Item A", status: "c", transferAccountId: null, categoryId: 1 },
        { id: 3, accountId: 5, amount: -4000, payee: "Amazon", memo: "Item B", status: "c", transferAccountId: null, categoryId: 2 },
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
        {},
        [
          { categoryId: 1, amount: -6000, memo: "Item A", payee: "New Seller A" },
          { categoryId: 2, amount: -4000, memo: "Item B" },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -6000, payee: "New Seller A" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -4000, payee: "Amazon" });
    });

    it("BUG-34: preserves custom child payee by client-supplied ID across reordering and duplicate amounts", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Amazon", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 101, accountId: 5, amount: -5000, payee: "Seller A", memo: "Same Memo", status: "c", transferAccountId: null, categoryId: 1 },
        { id: 102, accountId: 5, amount: -5000, payee: "Seller B", memo: "Same Memo", status: "c", transferAccountId: null, categoryId: 2 },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 201 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 202 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      // Reverse order: child 102 comes first, child 101 comes second
      await updateSplit(
        mock.db,
        1,
        {},
        [
          { id: 102, categoryId: 2, amount: -5000, memo: "Same Memo" },
          { id: 101, categoryId: 1, amount: -5000, memo: "Same Memo" },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -5000, payee: "Seller B" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -5000, payee: "Seller A" });
    });

    it("BUG-34: new child without id inherits parent payee and does not steal old child's custom payee by position", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Amazon", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 101, accountId: 5, amount: -5000, payee: "Seller A", memo: "Memo 1", status: "c", transferAccountId: null, categoryId: 1 },
        { id: 102, accountId: 5, amount: -5000, payee: "Seller B", memo: "Memo 2", status: "c", transferAccountId: null, categoryId: 2 },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 201 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 202 }]);
      mock.respondWith("update:accounts", [{}, {}]);

      // No id passed for position 0: should inherit parent's payee "Amazon", not steal "Seller A"
      await updateSplit(
        mock.db,
        1,
        {},
        [
          { categoryId: 1, amount: -5000, memo: "Brand New Sub Item" },
          { id: 102, categoryId: 2, amount: -5000, memo: "Memo 2" },
        ]
      );

      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ parentId: 1, amount: -5000, payee: "Amazon" });
      expect(inserts[1]?.values).toMatchObject({ parentId: 1, amount: -5000, payee: "Seller B" });
    });

    it("converts a single transaction that has no children into a split (BUG-02)", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -5000, payee: "X", categoryId: 10, parentId: null, transferAccountId: null, date: "2026-07-01", status: "c" },
      ]);
      mock.respondWith("select:transactions", []);
      mock.respondWith("update:accounts", [{}, {}, {}]);
      mock.respondWith("update:transactions", [{ id: 1 }]);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWithNth("insert:transactions", 1, [{ id: 2, parentId: 1, amount: -2500 }]);
      mock.respondWithNth("insert:transactions", 2, [{ id: 3, parentId: 1, amount: -2500 }]);

      const result = await updateSplit(
        mock.db,
        1,
        {},
        [
          { categoryId: 1, amount: -2500 },
          { categoryId: 2, amount: -2500 },
        ]
      );
      expect(result.parent.id).toBe(1);
      expect(result.children).toHaveLength(2);
    });

    it("allows changing or clearing the flag of a duplicate-flagged split parent (BUG-10)", async () => {
      const parentRow = {
        id: 1,
        accountId: 5,
        amount: -5000,
        payee: "X",
        categoryId: null,
        parentId: null,
        transferAccountId: null,
        status: "c",
        flagColor: "duplicate",
      };
      mock.respondWithNth("select:transactions", 1, [parentRow]);
      mock.respondWithNth("select:transactions", 2, []); // old children
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: true }]);
      mock.respondWith("update:transactions", [{ ...parentRow, flagColor: "red" }]);
      mock.respondWith("delete:transactions", []);
      mock.respondWith("insert:transactions", [
        { id: 2, parentId: 1, amount: -2500, categoryId: 1 },
        { id: 3, parentId: 1, amount: -2500, categoryId: 2 },
      ]);
      mock.respondWithNth("select:transactions", 3, [{ ...parentRow, flagColor: "red" }]);
      mock.respondWithNth("select:transactions", 4, [
        { id: 2, parentId: 1, amount: -2500, categoryId: 1 },
        { id: 3, parentId: 1, amount: -2500, categoryId: 2 },
      ]);

      const result = await updateSplit(
        mock.db,
        1,
        { flagColor: "red" },
        [
          { categoryId: 1, amount: -2500 },
          { categoryId: 2, amount: -2500 },
        ]
      );
      expect(result.parent.flagColor).toBe("red");
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

    it("rejects setting status to 'r' via updateSplit", async () => {
      await expect(
        updateSplit(
          mock.db,
          1,
          { status: "r" },
          [
            { categoryId: 1, amount: -2500 },
            { categoryId: 2, amount: -2500 },
          ]
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: /reconcile flow/,
      });
    });

    it("nulls reconciledAt and reconciliationId on parent when updating split status to 'u'", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Old", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
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
        { status: "u" },
        [
          { categoryId: 1, amount: -6000 },
          { categoryId: 2, amount: -4000 },
        ]
      );

      const parentUpdate = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(parentUpdate?.set).toMatchObject({
        status: "u",
        reconciledAt: null,
        reconciliationId: null,
      });
    });

    it("rejects a child whose transferAccountId matches parent accountId", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 5, amount: -10000, payee: "Old", date: "2026-07-01", status: "c", categoryId: null, parentId: null, transferAccountId: null },
      ]);

      await expect(
        updateSplit(
          mock.db,
          1,
          {},
          [
            { categoryId: 1, amount: -6000 },
            { transferAccountId: 5, amount: -4000 },
          ]
        )
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: "transfer account must differ from source account",
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
      const rowData = { id: 1, accountId: 1, amount: -5000, categoryId: 2, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWith("select:transactions", []); // getChildren
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 1);
      expect(result).toMatchObject({ id: 1 });
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "select", "update", "delete", "run"]);
    });

    it("deleting a split parent reverses each child's balance before cascade", async () => {
      const rowData = { id: 1, accountId: 1, amount: -10000, categoryId: null, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWith("select:transactions", [
        { id: 2, accountId: 1, amount: -6000, transferAccountId: null },
        { id: 3, accountId: 1, amount: -4000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "select", "update", "update", "delete", "run"]);
    });

    it("deleting a transfer reverses both source and destination balances", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -10000, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, [
        { id: 1, accountId: 1, transferAccountId: 2, amount: -10000, parentId: null },
      ]); // re-read
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "update", "update", "delete", "run"]);
    });

    it("deleting a split parent with transfer sub-transactions reverses source balance and destination transfer balance", async () => {
      const rowData = { id: 1, accountId: 1, amount: -10000, categoryId: null, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWith("select:transactions", [
        { id: 2, accountId: 1, amount: -6000, transferAccountId: null },
        { id: 3, accountId: 1, amount: -4000, transferAccountId: 2 },
      ]);
      mock.respondWith("update:accounts", [{}, {}, {}]);
      mock.respondWith("delete:transactions", [{}]);

      await deleteTransaction(mock.db, 1);
      const ops = mock.calls.map((c) => c.op);
      expect(ops).toEqual(["select", "run", "select", "select", "update", "update", "update", "delete", "run"]);
      const updates = mock.calls.filter((c) => c.op === "update" && c.table === "accounts");
      expect(updates).toHaveLength(3);
    });

    it("deleting a split child directly when > 2 children exist reverses child balance and re-totals parent amount", async () => {
      const rowData = { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null, categoryId: 10 };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1 }]); // parent query
      mock.respondWithNth("select:transactions", 3, [rowData]); // re-read
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 2);
      expect(result).toMatchObject({ id: 2 });
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(1);
      const parentUpdate = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(parentUpdate?.set).toMatchObject({ amount: -7000 });
    });

    it("deleting a split child transfer when > 2 children exist reverses both source and destination balances and re-totals parent", async () => {
      const rowData = { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: 2, categoryId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1 }]); // parent query
      mock.respondWithNth("select:transactions", 3, [rowData]); // re-read
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);

      await deleteTransaction(mock.db, 2);
      const updates = mock.calls.filter((c) => c.op === "update" && c.table === "accounts");
      expect(updates).toHaveLength(2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(1);
      const parentUpdate = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(parentUpdate?.set).toMatchObject({ amount: -7000 });
    });

    it("deleting a split child when only 1 child remains flattens remaining child and deletes parent", async () => {
      const rowData = { id: 2, parentId: 1, accountId: 1, amount: -6000, transferAccountId: null, categoryId: 10 };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1, payee: "Supermarket" }]); // parent query
      mock.respondWithNth("select:transactions", 3, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 4, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: 2, categoryId: null, payee: "" },
      ]);
      mock.respondWithNth("select:transactions", 5, [{ id: 1, payee: "Supermarket" }]); // parent select for flatten
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}, {}]);
      mock.respondWith("update:transactions", [{}]);

      await deleteTransaction(mock.db, 2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(2); // deleted child 2, deleted parent 1
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ parentId: null });
    });

    it("deleting an unreconciled split child flattens a reconciled remaining sibling without error", async () => {
      const rowData = { id: 2, parentId: 1, accountId: 1, amount: -6000, transferAccountId: null, categoryId: 10, status: "c" };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1, payee: "Target" }]); // parent query
      mock.respondWithNth("select:transactions", 3, [rowData]); // re-read
      mock.respondWithNth("select:transactions", 4, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null, categoryId: 11, status: "r", payee: "" },
      ]);
      mock.respondWithNth("select:transactions", 5, [{ id: 1, payee: "Target" }]); // parent select
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}, {}]);
      mock.respondWith("update:transactions", [{}]);

      const result = await deleteTransaction(mock.db, 2);
      expect(result).toMatchObject({ id: 2 });
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ parentId: null });
    });

    it("rolls back transaction and rethrows when an error occurs during deletion", async () => {
      const rowData = { id: 1, accountId: 1, amount: -5000, categoryId: 2, transferAccountId: null, parentId: null };
      mock.respondWithNth("select:transactions", 1, [rowData]);
      mock.respondWithNth("select:transactions", 2, [rowData]); // re-read
      mock.respondWith("select:transactions", []); // getChildren
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

    it("deleting a split child when > 2 children exist reverses child balance and re-totals parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null, categoryId: 10 },
      ]);
      mock.respondWith("select:transactions", [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}]);
      mock.respondWith("update:transactions", [{}]);

      const res = await bulkDeleteTransactions(mock.db, [2]);
      expect(res).toHaveLength(1);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(1);
      const parentUpdate = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(parentUpdate?.set).toMatchObject({ amount: -7000 });
    });

    it("bulk deleting a split child when only 1 child remains flattens remaining child and deletes parent", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -6000, transferAccountId: null, categoryId: 10 },
      ]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1, payee: "Supermarket" }]);
      mock.respondWithNth("select:transactions", 3, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: 2, categoryId: null, payee: "" },
      ]);
      mock.respondWithNth("select:transactions", 4, [{ id: 1, payee: "Supermarket" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}, {}]);
      mock.respondWith("update:transactions", [{}]);

      const res = await bulkDeleteTransactions(mock.db, [2]);
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({ id: 2 });
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      expect(deletes).toHaveLength(2); // child 2, parent 1
    });

    it("bulk deleting an unreconciled split child flattens a reconciled remaining sibling without error", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -6000, transferAccountId: null, categoryId: 10, status: "c" },
      ]);
      mock.respondWithNth("select:transactions", 2, [{ id: 1, payee: "Target" }]);
      mock.respondWithNth("select:transactions", 3, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null, categoryId: 11, status: "r", payee: "" },
      ]);
      mock.respondWithNth("select:transactions", 4, [{ id: 1, payee: "Target" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("delete:transactions", [{}, {}]);
      mock.respondWith("update:transactions", [{}]);

      const res = await bulkDeleteTransactions(mock.db, [2]);
      expect(res).toHaveLength(1);
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ parentId: null });
    });

    it("bulk deleting 2 children of a 3-child split re-totals then flattens remaining child", async () => {
      // First id: 2
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null, categoryId: 10 },
      ]);
      // Parent check for id 2
      mock.respondWithNth("select:transactions", 2, [
        { id: 1, status: "c", amount: -10000, payee: "Store" },
      ]);
      // remaining children after deleting 2: [3, 4]
      mock.respondWithNth("select:transactions", 3, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null },
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null },
      ]);
      // Second id: 3
      mock.respondWithNth("select:transactions", 4, [
        { id: 3, parentId: 1, accountId: 1, amount: -4000, transferAccountId: null, categoryId: 10 },
      ]);
      // Parent check for id 3
      mock.respondWithNth("select:transactions", 5, [
        { id: 1, status: "c", amount: -7000, payee: "Store" },
      ]);
      // remaining children after deleting 3: [4]
      mock.respondWithNth("select:transactions", 6, [
        { id: 4, parentId: 1, accountId: 1, amount: -3000, transferAccountId: null, payee: "" },
      ]);
      // Parent check for flatten of 4
      mock.respondWithNth("select:transactions", 7, [
        { id: 1, status: "c", amount: -7000, payee: "Store" },
      ]);
      mock.respondWith("update:accounts", [{}, {}]);
      mock.respondWith("delete:transactions", [{}, {}, {}]);
      mock.respondWith("update:transactions", [{}, {}]);

      const res = await bulkDeleteTransactions(mock.db, [2, 3]);
      expect(res).toHaveLength(2);
      const deletes = mock.calls.filter((c) => c.op === "delete" && c.table === "transactions");
      // id 2 deleted, id 3 deleted, parent 1 deleted = 3 deletes
      expect(deletes).toHaveLength(3);
    });

    it("BUG-24: bulkDeleteTransactions on 1 child of a 2-child split returns deleted child and flattens sibling", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Grocery Store",
          memo: "Split purchase",
          amount: -5000,
        },
        [
          { categoryId: cat1Id, amount: -3000, memo: "Apples" },
          { categoryId: cat2Id, amount: -2000, memo: "Bread" },
        ]
      );

      const child1 = split.children[0]!;
      const deleted = await bulkDeleteTransactions(db, [child1.id]);

      // Returns the deleted record
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.id).toBe(child1.id);

      const remainingTx = await db.select().from(schema.transactions);
      expect(remainingTx).toHaveLength(1);
      expect(remainingTx[0]?.id).toBe(split.children[1]!.id);
      expect(remainingTx[0]?.parentId).toBeNull();
      expect(remainingTx[0]?.amount).toBe(-2000);
      expect(remainingTx[0]?.categoryId).toBe(cat2Id);
    });
  });

  describe("bulkUpdateTransactions", () => {
    it("updates status and category on multiple transactions atomically", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, status: "u", categoryId: 1, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, []);
      mock.respondWithNth("select:transactions", 3, [
        { id: 2, status: "u", categoryId: 1, transferAccountId: null },
      ]);
      mock.respondWithNth("select:transactions", 4, []);
      mock.respondWith("update:transactions", [{ id: 1, status: "c" }, { id: 2, status: "c" }]);

      const res = await bulkUpdateTransactions(mock.db, [1, 2], { status: "c" });
      expect(res).toHaveLength(2);
    });

    it("updates payee, memo, date and category on multiple transactions", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: -1000, payee: "Old Payee", status: "u", categoryId: 1, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, []);
      mock.respondWithNth("select:accounts", 1, [{ id: 1, onBudget: true }]);
      mock.respondWithNth("select:transactions", 3, [
        { id: 2, accountId: 1, amount: -2000, payee: "Old Payee", status: "u", categoryId: 1, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 4, []);
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

    it("allows changing or clearing the flag of a duplicate-flagged transaction (BUG-10)", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, status: "c", categoryId: 1, transferAccountId: null, flagColor: "duplicate" },
      ]);
      mock.respondWithNth("select:transactions", 2, []); // child count
      mock.respondWith("update:transactions", [
        { id: 1, flagColor: "red" },
      ]);

      const res = await bulkUpdateTransactions(mock.db, [1], { flagColor: "red" });
      expect(res).toHaveLength(1);
      expect(res[0]!.flagColor).toBe("red");
    });

    it("forces categoryId to null and isIncome to false when bulk updating transactions on off-budget accounts", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 2, amount: 10000, payee: "Brokerage", status: "c", categoryId: null, transferAccountId: null, parentId: null },
      ]);
      mock.respondWithNth("select:transactions", 2, []);
      mock.respondWithNth("select:accounts", 1, [{ id: 2, onBudget: false }]);
      mock.respondWith("update:transactions", [
        { id: 1, categoryId: null, isIncome: false },
      ]);

      const res = await bulkUpdateTransactions(mock.db, [1], { categoryId: 5 });
      expect(res).toHaveLength(1);
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: null, isIncome: false, incomeMonth: null });
    });

    it("BUG 1.5: forces isIncome to false and incomeMonth to null when categorizing transactions on on-budget accounts", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 1, accountId: 1, amount: 10000, payee: "Payroll", status: "c", categoryId: null, transferAccountId: null, parentId: null, isIncome: true, incomeMonth: "2026-08" },
      ]);
      mock.respondWithNth("select:transactions", 2, []);
      mock.respondWithNth("select:accounts", 1, [{ id: 1, onBudget: true }]);
      mock.respondWith("update:transactions", [
        { id: 1, categoryId: 5, isIncome: false, incomeMonth: null },
      ]);

      const res = await bulkUpdateTransactions(mock.db, [1], { categoryId: 5 });
      expect(res).toHaveLength(1);
      const update = mock.calls.find((c) => c.op === "update" && c.table === "transactions");
      expect(update?.set).toMatchObject({ categoryId: 5, isIncome: false, incomeMonth: null });
    });

    it("rejects account changes on a split child in bulk update", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 2, parentId: 1, accountId: 1, amount: -3000, payee: "X", categoryId: 10, date: "2026-07-01", transferAccountId: null },
      ]);

      await expect(
        bulkUpdateTransactions(mock.db, [2], { accountId: 2 })
      ).rejects.toThrow(/split child/);
    });

    it("rejects changing accountId on a transfer transaction in bulk update", async () => {
      mock.respondWithNth("select:transactions", 1, [
        { id: 10, parentId: null, accountId: 1, amount: -5000, payee: "Transfer : Savings", categoryId: null, date: "2026-07-01", transferAccountId: 2 },
      ]);

      await expect(
        bulkUpdateTransactions(mock.db, [10], { accountId: 2 })
      ).rejects.toThrow(/cannot change account of a transfer/);
    });

    it("rejects setting status to 'r' via bulkUpdateTransactions", async () => {
      await expect(
        bulkUpdateTransactions(mock.db, [1, 2], { status: "r" })
      ).rejects.toMatchObject({
        name: "TransactionError",
        message: /reconcile flow/,
      });
    });

    it("rejects bulk updating a reconciled transaction via bulkUpdateTransactions", async () => {
      mock.respondWithNth("select:transactions", 1, [
        {
          id: 1,
          accountId: 1,
          amount: -1000,
          status: "r",
          reconciledAt: "2026-07-01",
          reconciliationId: 5,
          transferAccountId: null,
          parentId: null,
        },
      ]);

      await expect(bulkUpdateTransactions(mock.db, [1], { status: "c" })).rejects.toMatchObject({
        status: 422,
        name: "TransactionError",
        message: /reconciled and locked/i,
      });
    });
  });

  describe("split deletion integration (SQLite DB)", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

    function openMigratedDb() {
      const raw = new Database(":memory:");
      raw.pragma("foreign_keys = ON");
      const db = drizzle(raw, { schema });
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      return db;
    }

    async function seedTestData(db: ReturnType<typeof openMigratedDb>) {
      const [account] = await db
        .insert(schema.accounts)
        .values({
          name: "Checking",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          balance: 0,
          onBudget: true,
          sort: 0,
        })
        .returning();

      const [group] = await db
        .insert(schema.categoryGroups)
        .values({ name: "Everyday Expenses", sort: 0 })
        .returning();

      const [cat1] = await db
        .insert(schema.categories)
        .values({ name: "Groceries", groupId: group!.id, sort: 0 })
        .returning();

      const [cat2] = await db
        .insert(schema.categories)
        .values({ name: "Dining", groupId: group!.id, sort: 1 })
        .returning();

      const [cat3] = await db
        .insert(schema.categories)
        .values({ name: "Household", groupId: group!.id, sort: 2 })
        .returning();

      return {
        accountId: account!.id,
        cat1Id: cat1!.id,
        cat2Id: cat2!.id,
        cat3Id: cat3!.id,
      };
    }

    it("deleteTransaction: deleting 1 child of a 3-child split updates parent amount and allows sibling updates", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id, cat3Id } = await seedTestData(db);

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Supermarket",
          memo: "Groceries & more",
          amount: -10000,
        },
        [
          { categoryId: cat1Id, amount: -5000, memo: "food" },
          { categoryId: cat2Id, amount: -3000, memo: "coffee" },
          { categoryId: cat3Id, amount: -2000, memo: "soap" },
        ]
      );

      // Account balance should be -10000
      let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-10000);

      // Delete the 3rd child (-2000)
      const childToDelete = split.children[2]!;
      await deleteTransaction(db, childToDelete.id);

      // Account balance should now be -8000
      [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-8000);

      // Parent transaction amount should be updated to -8000
      const [parent] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, split.parent.id));
      expect(parent?.amount).toBe(-8000);

      // Subsequent child edit should succeed and not throw "split children do not sum to parent"
      const childToUpdate = split.children[1]!;
      await expect(
        updateTransaction(db, childToUpdate.id, { memo: "updated coffee memo" })
      ).resolves.not.toThrow();

      // Deleting another child should trigger 1-child flattening: remaining child 1 becomes regular transaction
      await deleteTransaction(db, childToUpdate.id);
      const remainingTx = await db.select().from(schema.transactions);
      expect(remainingTx).toHaveLength(1);
      expect(remainingTx[0]?.id).toBe(split.children[0]!.id);
      expect(remainingTx[0]?.parentId).toBeNull();
      expect(remainingTx[0]?.amount).toBe(-5000);
      expect(remainingTx[0]?.categoryId).toBe(cat1Id);

      [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-5000);
    });

    it("BUG-07: deleting a split child flattens remaining child into regular transaction and credits only deleted child amount", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Supermarket",
          memo: "Groceries & Household",
          amount: -10000,
        },
        [
          { categoryId: cat1Id, amount: -8000, memo: "Groceries" },
          { categoryId: cat2Id, amount: -2000, memo: "Household" },
        ]
      );

      let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-10000);

      const householdChild = split.children[1]!;
      await deleteTransaction(db, householdChild.id);

      // Account balance is credited +2000 (not +10000)
      [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-8000);

      // Database contains 1 transaction: Groceries ($80)
      const allTx = await db.select().from(schema.transactions);
      expect(allTx).toHaveLength(1);
      expect(allTx[0]!.amount).toBe(-8000);
      expect(allTx[0]!.categoryId).toBe(cat1Id);
      expect(allTx[0]!.parentId).toBeNull();
    });

    it("bulkDeleteTransactions: deleting 1 child of a 3-child split updates parent amount and allows sibling updates", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id, cat3Id } = await seedTestData(db);

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Supermarket",
          memo: "Groceries & more",
          amount: -10000,
        },
        [
          { categoryId: cat1Id, amount: -5000, memo: "food" },
          { categoryId: cat2Id, amount: -3000, memo: "coffee" },
          { categoryId: cat3Id, amount: -2000, memo: "soap" },
        ]
      );

      // Bulk delete the 3rd child (-2000)
      const childToDelete = split.children[2]!;
      const deleted = await bulkDeleteTransactions(db, [childToDelete.id]);
      expect(deleted).toHaveLength(1);

      // Account balance should be -8000
      let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(-8000);

      // Parent transaction amount should be updated to -8000
      const [parent] = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, split.parent.id));
      expect(parent?.amount).toBe(-8000);

      // Sibling update succeeds
      const childToUpdate = split.children[1]!;
      await expect(
        updateTransaction(db, childToUpdate.id, { memo: "updated memo" })
      ).resolves.not.toThrow();

      // Bulk delete child 1 and child 2 together (which collapses)
      await bulkDeleteTransactions(db, [split.children[0]!.id, childToUpdate.id]);
      const remainingTx = await db.select().from(schema.transactions);
      expect(remainingTx).toHaveLength(0);

      [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
      expect(acct?.balance).toBe(0);
    });

    it("Bug 2.2: updateTransaction and bulkUpdateTransactions reject accountId changes on split children", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      const [acct2] = await db
        .insert(schema.accounts)
        .values({
          name: "Savings",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          onBudget: true,
          balance: 0,
          sort: 1,
        })
        .returning();

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Store",
          memo: "Split items",
          amount: -5000,
        },
        [
          { categoryId: cat1Id, amount: -3000, memo: "item 1" },
          { categoryId: cat2Id, amount: -2000, memo: "item 2" },
        ]
      );

      const child1 = split.children[0]!;

      // updateTransaction rejecting accountId on split child
      await expect(
        updateTransaction(db, child1.id, { accountId: acct2!.id })
      ).rejects.toThrow(/split child/);

      // bulkUpdateTransactions rejecting accountId on split child
      await expect(
        bulkUpdateTransactions(db, [child1.id], { accountId: acct2!.id })
      ).rejects.toThrow(/split child/);
    });

    it("Bug 2.2: deleteTransaction on split parent reverses child balances against each child's accountId", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      const [acct2] = await db
        .insert(schema.accounts)
        .values({
          name: "Savings",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          onBudget: true,
          balance: 0,
          sort: 1,
        })
        .returning();

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Store",
          memo: "Split items",
          amount: -5000,
        },
        [
          { categoryId: cat1Id, amount: -3000, memo: "item 1" },
          { categoryId: cat2Id, amount: -2000, memo: "item 2" },
        ]
      );

      // Manually move child 2 to account 2 in DB (simulating legacy data) and adjust balance accordingly
      const child2 = split.children[1]!;
      await db
        .update(schema.transactions)
        .set({ accountId: acct2!.id })
        .where(eq(schema.transactions.id, child2.id));
      await db
        .update(schema.accounts)
        .set({ balance: -2000 })
        .where(eq(schema.accounts.id, acct2!.id));
      await db
        .update(schema.accounts)
        .set({ balance: -3000 })
        .where(eq(schema.accounts.id, accountId));

      // Now delete the split parent
      await deleteTransaction(db, split.parent.id);

      // Account 1 should be restored from -3000 to 0 (reversed child1's -3000)
      const [finalAcct1] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId));
      expect(finalAcct1?.balance).toBe(0);

      // Account 2 should be restored from -2000 to 0 (reversed child2's -2000)
      const [finalAcct2] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, acct2!.id));
      expect(finalAcct2?.balance).toBe(0);
    });

    it("Bug 2.2: bulkDeleteTransactions on split parent reverses child balances against each child's accountId", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      const [acct2] = await db
        .insert(schema.accounts)
        .values({
          name: "Savings",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          onBudget: true,
          balance: 0,
          sort: 1,
        })
        .returning();

      const split = await createSplitWithChildren(
        db,
        {
          accountId,
          date: "2026-08-01",
          payee: "Store",
          memo: "Split items",
          amount: -5000,
        },
        [
          { categoryId: cat1Id, amount: -3000, memo: "item 1" },
          { categoryId: cat2Id, amount: -2000, memo: "item 2" },
        ]
      );

      // Manually move child 2 to account 2 in DB and adjust balance
      const child2 = split.children[1]!;
      await db
        .update(schema.transactions)
        .set({ accountId: acct2!.id })
        .where(eq(schema.transactions.id, child2.id));
      await db
        .update(schema.accounts)
        .set({ balance: -2000 })
        .where(eq(schema.accounts.id, acct2!.id));
      await db
        .update(schema.accounts)
        .set({ balance: -3000 })
        .where(eq(schema.accounts.id, accountId));

      // Bulk delete the split parent
      await bulkDeleteTransactions(db, [split.parent.id]);

      const [finalAcct1] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId));
      expect(finalAcct1?.balance).toBe(0);

      const [finalAcct2] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, acct2!.id));
      expect(finalAcct2?.balance).toBe(0);
    });

    describe("BUG-26: split status changes propagate atomically across parent and children", () => {
      it("updateTransaction: cycling status on split parent propagates to all children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Split items",
            amount: -5000,
            status: "c",
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "Groceries" },
            { categoryId: cat2Id, amount: -2000, memo: "Household" },
          ]
        );

        // Update parent status from 'c' to 'u'
        await updateTransaction(db, split.parent.id, { status: "u" });

        const rows = await db
          .select()
          .from(schema.transactions)
          .where(
            or(
              eq(schema.transactions.id, split.parent.id),
              eq(schema.transactions.parentId, split.parent.id)
            )
          );

        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.status).toBe("u");
        }
      });

      it("updateTransaction: updating status on split child propagates to parent and sibling children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Split items",
            amount: -5000,
            status: "c",
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "Groceries" },
            { categoryId: cat2Id, amount: -2000, memo: "Household" },
          ]
        );

        // Update child status from 'c' to 'u'
        const child1 = split.children[0]!;
        await updateTransaction(db, child1.id, { status: "u" });

        const rows = await db
          .select()
          .from(schema.transactions)
          .where(
            or(
              eq(schema.transactions.id, split.parent.id),
              eq(schema.transactions.parentId, split.parent.id)
            )
          );

        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.status).toBe("u");
        }
      });

      it("bulkUpdateTransactions: updating status on split parent propagates to children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Split items",
            amount: -5000,
            status: "c",
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "Groceries" },
            { categoryId: cat2Id, amount: -2000, memo: "Household" },
          ]
        );

        await bulkUpdateTransactions(db, [split.parent.id], { status: "u" });

        const rows = await db
          .select()
          .from(schema.transactions)
          .where(
            or(
              eq(schema.transactions.id, split.parent.id),
              eq(schema.transactions.parentId, split.parent.id)
            )
          );

        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.status).toBe("u");
        }
      });

      it("bulkUpdateTransactions: updating status on split child propagates to parent and siblings", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Split items",
            amount: -5000,
            status: "c",
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "Groceries" },
            { categoryId: cat2Id, amount: -2000, memo: "Household" },
          ]
        );

        await bulkUpdateTransactions(db, [split.children[1]!.id], { status: "u" });

        const rows = await db
          .select()
          .from(schema.transactions)
          .where(
            or(
              eq(schema.transactions.id, split.parent.id),
              eq(schema.transactions.parentId, split.parent.id)
            )
          );

        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.status).toBe("u");
        }
      });
    });

    describe("Bug 2.3: transfers and split parents force categoryId to null", () => {
      it("forces categoryId to null on internal transfer insertion", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);
        const [acct2] = await db
          .insert(schema.accounts)
          .values({
            name: "Savings",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 1,
          })
          .returning();

        const transfer = await createTransfer(
          db,
          {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "",
            memo: "Transfer with category",
            amount: -5000,
          },
          acct2!.id
        );

        expect(transfer.categoryId).toBeNull();
        expect(transfer.isIncome).toBe(false);

        const [row] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, transfer.id));
        expect(row?.categoryId).toBeNull();
        expect(row?.isIncome).toBe(false);
      });

      it("forces categoryId to null on split parent creation via createTransaction", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);

        const row = await createTransaction(db, {
          accountId,
          categoryId: cat1Id,
          date: "2026-08-01",
          payee: "Costco",
          memo: "Split parent",
          amount: -10000,
          skipBalance: true,
        });

        expect(row.categoryId).toBeNull();
        expect(row.isIncome).toBe(false);

        const [dbRow] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, row.id));
        expect(dbRow?.categoryId).toBeNull();
      });

      it("forces categoryId to null on internal transfer split child via createTransaction", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);
        const [acct2] = await db
          .insert(schema.accounts)
          .values({
            name: "Savings",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 1,
          })
          .returning();

        const parent = await createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-08-01",
          payee: "Bank",
          memo: "Parent",
          amount: -10000,
          skipBalance: true,
        });

        const childTransfer = await createTransaction(db, {
          accountId,
          categoryId: cat1Id,
          date: "2026-08-01",
          payee: "",
          memo: "Child transfer",
          amount: -5000,
          transferAccountId: acct2!.id,
          parentId: parent.id,
        });

        expect(childTransfer.categoryId).toBeNull();
        expect(childTransfer.isIncome).toBe(false);
      });

      it("forces categoryId to null when updating an internal transfer", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);
        const [acct2] = await db
          .insert(schema.accounts)
          .values({
            name: "Savings",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 1,
          })
          .returning();

        const transfer = await createTransfer(
          db,
          {
            accountId,
            categoryId: null,
            date: "2026-08-01",
            payee: "",
            memo: "Transfer",
            amount: -5000,
          },
          acct2!.id
        );

        const updated = await updateTransaction(db, transfer.id, {
          categoryId: cat1Id,
        });

        expect(updated?.categoryId).toBeNull();
        expect(updated?.isIncome).toBe(false);

        const [row] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, transfer.id));
        expect(row?.categoryId).toBeNull();
      });

      it("BUG-28: rejects changing accountId on a transfer via updateTransaction and bulkUpdateTransactions", async () => {
        const db = openMigratedDb();
        const { accountId } = await seedTestData(db);
        const [acct2] = await db
          .insert(schema.accounts)
          .values({
            name: "Savings",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 1,
          })
          .returning();
        const [acct3] = await db
          .insert(schema.accounts)
          .values({
            name: "Checking 2",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 2,
          })
          .returning();

        const transfer = await createTransfer(
          db,
          {
            accountId,
            categoryId: null,
            date: "2026-08-01",
            payee: "",
            memo: "Transfer",
            amount: -5000,
          },
          acct2!.id
        );

        // Reject updating accountId to a different account in updateTransaction
        await expect(
          updateTransaction(db, transfer.id, {
            accountId: acct3!.id,
          })
        ).rejects.toThrow(/cannot change account of a transfer/);

        // Reject updating accountId in bulkUpdateTransactions
        await expect(
          bulkUpdateTransactions(db, [transfer.id], {
            accountId: acct3!.id,
          })
        ).rejects.toThrow(/cannot change account of a transfer/);

        // Updating with the same accountId succeeds
        const updatedSame = await updateTransaction(db, transfer.id, {
          accountId,
          memo: "Updated memo",
        });
        expect(updatedSame?.memo).toBe("Updated memo");
        expect(updatedSame?.accountId).toBe(accountId);

        // Updating with blank payee auto-regenerates payee
        const updatedBlankPayee = await updateTransaction(db, transfer.id, {
          payee: "",
        });
        expect(updatedBlankPayee?.payee).toBe("Transfer : Savings");
      });

      it("forces categoryId to null when updating a split parent", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Store",
            memo: "Split items",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "item 1" },
            { categoryId: cat2Id, amount: -2000, memo: "item 2" },
          ]
        );

        const updated = await updateTransaction(db, split.parent.id, {
          categoryId: cat1Id,
        });

        expect(updated?.categoryId).toBeNull();
        expect(updated?.isIncome).toBe(false);

        const [row] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, split.parent.id));
        expect(row?.categoryId).toBeNull();
      });

      it("forces categoryId to null on internal transfers and split parents in bulkUpdateTransactions", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);
        const [acct2] = await db
          .insert(schema.accounts)
          .values({
            name: "Savings",
            kind: "liquid",
            groupLabel: "Budget Accounts",
            onBudget: true,
            balance: 0,
            sort: 1,
          })
          .returning();

        // 1. Regular transaction
        const regular = await createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-08-01",
          payee: "Coffee",
          memo: "Latte",
          amount: -500,
        });

        // 2. Internal transfer
        const transfer = await createTransfer(
          db,
          {
            accountId,
            categoryId: null,
            date: "2026-08-01",
            payee: "",
            memo: "Transfer",
            amount: -3000,
          },
          acct2!.id
        );

        // 3. Split parent
        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Store",
            memo: "Split",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000 },
            { categoryId: cat2Id, amount: -2000 },
          ]
        );

        // Bulk categorize all three with cat2Id
        await bulkUpdateTransactions(db, [regular.id, transfer.id, split.parent.id], {
          categoryId: cat2Id,
        });

        const [dbRegular] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, regular.id));
        expect(dbRegular?.categoryId).toBe(cat2Id);

        const [dbTransfer] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, transfer.id));
        expect(dbTransfer?.categoryId).toBeNull();
        expect(dbTransfer?.isIncome).toBe(false);

        const [dbSplitParent] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, split.parent.id));
        expect(dbSplitParent?.categoryId).toBeNull();
        expect(dbSplitParent?.isIncome).toBe(false);
      });

      it("preserves categoryId on cross-boundary transfers (e.g. to off-budget)", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);
        const [offBudgetAcct] = await db
          .insert(schema.accounts)
          .values({
            name: "Brokerage",
            kind: "offbudget",
            groupLabel: "Tracking Accounts",
            onBudget: false,
            balance: 0,
            sort: 1,
          })
          .returning();

        // 1. Create cross-boundary transfer with category
        const transfer = await createTransfer(
          db,
          {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "",
            memo: "Investment transfer",
            amount: -5000,
          },
          offBudgetAcct!.id
        );

        expect(transfer.categoryId).toBe(cat1Id);

        // 2. Update category on cross-boundary transfer
        const updated = await updateTransaction(db, transfer.id, {
          categoryId: cat2Id,
        });
        expect(updated?.categoryId).toBe(cat2Id);

        // 3. Bulk update category on cross-boundary transfer
        await bulkUpdateTransactions(db, [transfer.id], {
          categoryId: cat1Id,
        });
        const [dbRow] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, transfer.id));
        expect(dbRow?.categoryId).toBe(cat1Id);
      });

      it("enforces category requirement for boundary outflows across create/update/bulk/split paths and both orientations", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);
        const [offBudgetAcct] = await db
          .insert(schema.accounts)
          .values({
            name: "Brokerage",
            kind: "offbudget",
            groupLabel: "Tracking Accounts",
            onBudget: false,
            balance: 0,
            sort: 1,
          })
          .returning();

        // A. createTransfer boundary outflow without category (Orientation 1: on-budget -> off-budget, negative amount)
        await expect(
          createTransfer(
            db,
            {
              accountId,
              categoryId: null,
              date: "2026-08-01",
              payee: "",
              memo: "Investment transfer",
              amount: -5000,
            },
            offBudgetAcct!.id
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // B. createTransfer boundary outflow without category (Orientation 2: off-budget -> on-budget, positive amount on off-budget)
        await expect(
          createTransfer(
            db,
            {
              accountId: offBudgetAcct!.id,
              categoryId: null,
              date: "2026-08-01",
              payee: "",
              memo: "Investment transfer",
              amount: 5000,
            },
            accountId
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // C. createTransaction boundary outflow without category
        await expect(
          createTransaction(db, {
            accountId,
            categoryId: null,
            date: "2026-08-01",
            payee: "Transfer : Brokerage",
            memo: "Investment transfer",
            amount: -5000,
            transferAccountId: offBudgetAcct!.id,
          })
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // Create valid boundary outflow transfer
        const validOutflow = await createTransfer(
          db,
          {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "",
            memo: "Investment transfer",
            amount: -5000,
          },
          offBudgetAcct!.id
        );

        // D. updateTransaction attempting to strip category on boundary outflow
        await expect(
          updateTransaction(db, validOutflow.id, {
            categoryId: null,
          })
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // E. bulkUpdateTransactions attempting to strip category on boundary outflow
        await expect(
          bulkUpdateTransactions(db, [validOutflow.id], {
            categoryId: null,
          })
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // F. createSplitWithChildren with boundary outflow transfer child lacking category
        await expect(
          createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Split investment",
              memo: "Split",
              amount: -5000,
            },
            [
              { categoryId: cat1Id, amount: -2000 },
              { transferAccountId: offBudgetAcct!.id, categoryId: null, amount: -3000 },
            ]
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });

        // Valid split with boundary outflow transfer child having a category succeeds
        const validSplit = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Split investment",
            memo: "Split",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -2000 },
            { transferAccountId: offBudgetAcct!.id, categoryId: cat1Id, amount: -3000 },
          ]
        );
        expect(validSplit.children[1]?.categoryId).toBe(cat1Id);

        // G. updateSplit with boundary outflow transfer child lacking category
        await expect(
          updateSplit(
            db,
            validSplit.parent.id,
            {},
            [
              { categoryId: cat1Id, amount: -2000 },
              { transferAccountId: offBudgetAcct!.id, categoryId: null, amount: -3000 },
            ]
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "Boundary transfer outflow requires a category",
        });
      });

      it("forces isIncome: true for uncategorized boundary inflows across create/update/bulk paths and both orientations even if isIncome: false is passed", async () => {
        const db = openMigratedDb();
        const { accountId } = await seedTestData(db);
        const [offBudgetAcct] = await db
          .insert(schema.accounts)
          .values({
            name: "Brokerage",
            kind: "offbudget",
            groupLabel: "Tracking Accounts",
            onBudget: false,
            balance: 100000,
            sort: 1,
          })
          .returning();

        // 1. createTransfer (Orientation 1: on-budget account with positive amount, isIncome: false)
        const inbound1 = await createTransfer(
          db,
          {
            accountId,
            categoryId: null,
            date: "2026-08-01",
            payee: "",
            memo: "Inbound 1",
            amount: 5000,
            isIncome: false,
          },
          offBudgetAcct!.id
        );
        expect(inbound1.isIncome).toBe(true);
        expect(inbound1.categoryId).toBeNull();

        // 2. createTransfer (Orientation 2: off-budget account with negative amount, isIncome: false)
        const inbound2 = await createTransfer(
          db,
          {
            accountId: offBudgetAcct!.id,
            categoryId: null,
            date: "2026-08-01",
            payee: "",
            memo: "Inbound 2",
            amount: -5000,
            isIncome: false,
          },
          accountId
        );
        expect(inbound2.isIncome).toBe(true);
        expect(inbound2.categoryId).toBeNull();

        // 3. createTransaction with boundary inflow transfer and isIncome: false
        const inbound3 = await createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-08-01",
          payee: "Transfer : Brokerage",
          memo: "Inbound 3",
          amount: 5000,
          transferAccountId: offBudgetAcct!.id,
          isIncome: false,
        });
        expect(inbound3.isIncome).toBe(true);
        expect(inbound3.categoryId).toBeNull();

        // 4. updateTransaction with isIncome: false on uncategorized boundary inflow
        const updated = await updateTransaction(db, inbound1.id, {
          isIncome: false,
        });
        expect(updated?.isIncome).toBe(true);

        // 5. bulkUpdateTransactions with isIncome: false / category null
        await bulkUpdateTransactions(db, [inbound1.id, inbound2.id], {
          memo: "Bulk updated inbounds",
        });
        const [dbRow1] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, inbound1.id));
        expect(dbRow1?.isIncome).toBe(true);
        expect(dbRow1?.categoryId).toBeNull();

        // 6. createSplitWithChildren with boundary inflow transfer child without category
        const splitInbound = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Split inbound",
            memo: "",
            amount: 5000,
          },
          [
            { categoryId: null, amount: 2000 },
            { transferAccountId: offBudgetAcct!.id, categoryId: null, amount: 3000 },
          ]
        );
        expect(splitInbound.children[1]?.isIncome).toBe(true);
        expect(splitInbound.children[1]?.categoryId).toBeNull();
      });

      it("BUG-01: preserves incomeMonth on boundary income transfers when bulk-updating an unrelated field", async () => {
        const db = openMigratedDb();
        const { accountId } = await seedTestData(db);
        const [offBudgetAcct] = await db
          .insert(schema.accounts)
          .values({
            name: "Brokerage",
            kind: "offbudget",
            groupLabel: "Tracking Accounts",
            onBudget: false,
            balance: 0,
            sort: 99,
          })
          .returning();

        const transfer = await createTransfer(
          db,
          {
            accountId: offBudgetAcct!.id,
            categoryId: null,
            date: "2026-01-15",
            payee: "",
            memo: "Deferred income",
            amount: -5000,
            incomeMonth: "2026-02",
          },
          accountId
        );
        expect(transfer.incomeMonth).toBe("2026-02");

        await bulkUpdateTransactions(db, [transfer.id], { flagColor: "red" });

        const [row] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, transfer.id));
        expect(row?.isIncome).toBe(true);
        expect(row?.incomeMonth).toBe("2026-02");
      });
    });

    describe("Bug 2.7: 1-child collapse reconcile lock", () => {
      it("deleteTransaction: flattens an unreconciled child's sibling into a regular transaction even when sibling is reconciled", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Shopping",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "clothes" },
            { categoryId: cat2Id, amount: -2000, memo: "groceries" },
          ]
        );

        // Mark child 2 as reconciled ("r")
        const child1 = split.children[0]!;
        const child2 = split.children[1]!;
        await db
          .update(schema.transactions)
          .set({ status: "r" })
          .where(eq(schema.transactions.id, child2.id));

        // Deleting child 1 flattens child 2 into a regular transaction and preserves its reconciled status
        await expect(deleteTransaction(db, child1.id)).resolves.not.toThrow();

        const allTx = await db.select().from(schema.transactions);
        expect(allTx).toHaveLength(1);
        expect(allTx[0]?.id).toBe(child2.id);
        expect(allTx[0]?.status).toBe("r");
        expect(allTx[0]?.parentId).toBeNull();
        expect(allTx[0]?.amount).toBe(-2000);

        const [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
        expect(acct?.balance).toBe(-2000);
      });

      it("bulkDeleteTransactions: flattens an unreconciled child's sibling into a regular transaction even when sibling is reconciled", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Shopping",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "clothes" },
            { categoryId: cat2Id, amount: -2000, memo: "groceries" },
          ]
        );

        // Mark child 2 as reconciled ("r")
        const child1 = split.children[0]!;
        const child2 = split.children[1]!;
        await db
          .update(schema.transactions)
          .set({ status: "r" })
          .where(eq(schema.transactions.id, child2.id));

        // Bulk deleting child 1 flattens child 2 into a regular transaction
        await expect(bulkDeleteTransactions(db, [child1.id])).resolves.not.toThrow();

        const allTx = await db.select().from(schema.transactions);
        expect(allTx).toHaveLength(1);
        expect(allTx[0]?.id).toBe(child2.id);
        expect(allTx[0]?.status).toBe("r");
        expect(allTx[0]?.parentId).toBeNull();
        expect(allTx[0]?.amount).toBe(-2000);

        const [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
        expect(acct?.balance).toBe(-2000);
      });

      it("allows deleting children sequentially down to 1 child preserving reconciled sibling", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id, cat3Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Supermarket",
            memo: "Split items",
            amount: -6000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "food" },
            { categoryId: cat2Id, amount: -2000, memo: "coffee" },
            { categoryId: cat3Id, amount: -1000, memo: "household" },
          ]
        );

        const child1 = split.children[0]!;
        const child2 = split.children[1]!;
        const child3 = split.children[2]!;

        // Mark child 2 as reconciled ("r")
        await db
          .update(schema.transactions)
          .set({ status: "r" })
          .where(eq(schema.transactions.id, child2.id));

        // Deleting child 1 does NOT trigger collapse (2 children remain), so it should succeed
        await expect(deleteTransaction(db, child1.id)).resolves.not.toThrow();

        // Account balance updated to -3000
        let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
        expect(acct?.balance).toBe(-3000);

        // Parent amount re-totaled to -3000
        const [parent] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, split.parent.id));
        expect(parent?.amount).toBe(-3000);

        // Now deleting child 3 leaves only child 2 (reconciled), which flattens into a regular transaction
        await expect(deleteTransaction(db, child3.id)).resolves.not.toThrow();

        const allTx = await db.select().from(schema.transactions);
        expect(allTx).toHaveLength(1);
        expect(allTx[0]?.id).toBe(child2.id);
        expect(allTx[0]?.status).toBe("r");
        expect(allTx[0]?.parentId).toBeNull();
        expect(allTx[0]?.amount).toBe(-2000);

        // Account balance is now -2000
        [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
        expect(acct?.balance).toBe(-2000);
      });

      it("prevents self-transfer in createSplitWithChildren and updateSplit", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        // createSplitWithChildren with self-transfer child should be rejected
        await expect(
          createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Supermarket",
              memo: "Split items",
              amount: -5000,
            },
            [
              { categoryId: cat1Id, amount: -3000, memo: "food" },
              { transferAccountId: accountId, amount: -2000, memo: "self transfer" },
            ]
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "transfer account must differ from source account",
        });

        // Create valid split
        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Supermarket",
            memo: "Split items",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "food" },
            { categoryId: cat2Id, amount: -2000, memo: "coffee" },
          ]
        );

        // updateSplit with self-transfer child should be rejected
        await expect(
          updateSplit(
            db,
            split.parent.id,
            {},
            [
              { categoryId: cat1Id, amount: -3000, memo: "food" },
              { transferAccountId: accountId, amount: -2000, memo: "self transfer" },
            ]
          )
        ).rejects.toMatchObject({
          name: "TransactionError",
          message: "transfer account must differ from source account",
        });
      });
    });

    describe("Bug 2.9: editing split parent date propagates to children", () => {
      it("updateTransaction: updating split parent date changes date for all children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Grocery Store",
            memo: "Groceries",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "produce" },
            { categoryId: cat2Id, amount: -2000, memo: "dairy" },
          ]
        );

        // Update parent date to 2026-08-15
        await updateTransaction(db, split.parent.id, { date: "2026-08-15" });

        // Verify parent was updated
        const [parent] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, split.parent.id));
        expect(parent?.date).toBe("2026-08-15");

        // Verify all children were updated to the new date
        const children = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.parentId, split.parent.id));
        expect(children).toHaveLength(2);
        for (const child of children) {
          expect(child.date).toBe("2026-08-15");
        }
      });

      it("bulkUpdateTransactions: updating split parent date changes date for all children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Hardware Store",
            memo: "Supplies",
            amount: -7500,
          },
          [
            { categoryId: cat1Id, amount: -4500, memo: "tools" },
            { categoryId: cat2Id, amount: -3000, memo: "paint" },
          ]
        );

        // Bulk update parent date to 2026-08-20
        await bulkUpdateTransactions(db, [split.parent.id], { date: "2026-08-20" });

        // Verify parent was updated
        const [parent] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, split.parent.id));
        expect(parent?.date).toBe("2026-08-20");

        // Verify all children were updated to the new date
        const children = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.parentId, split.parent.id));
        expect(children).toHaveLength(2);
        for (const child of children) {
          expect(child.date).toBe("2026-08-20");
        }
      });

      describe("reconciled transaction lock and account metadata integrity (Bug 2.5)", () => {
        it("rejects updateTransaction on reconciled transaction and preserves account metadata", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id } = await seedTestData(db);

          const t1 = await createTransaction(db, {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "Grocery Store",
            amount: -5000,
            status: "c",
          });

          const recResult = await reconcileAccount(db, {
            accountId,
            statementBalance: -5000,
            statementDate: "2026-08-01",
          });
          expect(recResult.finalDiff).toBe(0);

          // Verify row is reconciled
          const [t1Db] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t1.id));
          expect(t1Db?.status).toBe("r");
          expect(t1Db?.reconciliationId).toBeTruthy();

          // Account metadata is stamped
          const [acctBefore] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acctBefore?.lastReconciledAt).toBeTruthy();
          expect(acctBefore?.lastReconciledBalance).toBe(-5000);

          // 1. Attempting to change status to 'c' must fail with 422
          await expect(
            updateTransaction(db, t1.id, { status: "c" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // 2. Attempting to change other fields (memo, payee, amount) without unreconciling must fail with 422
          await expect(
            updateTransaction(db, t1.id, { memo: "New Memo" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          await expect(
            updateTransaction(db, t1.id, { amount: -6000 })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Verify transaction was untouched in DB
          const [t1DbAfter] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t1.id));
          expect(t1DbAfter?.status).toBe("r");
          expect(t1DbAfter?.reconciliationId).toBe(t1Db?.reconciliationId);
          expect(t1DbAfter?.memo).toBe(t1Db?.memo);

          // Verify account metadata was untouched
          const [acctAfter] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acctAfter?.lastReconciledAt).toBe(acctBefore?.lastReconciledAt);
          expect(acctAfter?.lastReconciledBalance).toBe(acctBefore?.lastReconciledBalance);

          // 4. Calling unreconcileAccount successfully unreconciles
          const unrec = await unreconcileAccount(db, accountId);
          expect(unrec.flipped).toBe(1);

          const [acctUnrec] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acctUnrec?.lastReconciledAt).toBeNull();
          expect(acctUnrec?.lastReconciledBalance).toBeNull();

          // Now the transaction can be updated normally
          await expect(
            updateTransaction(db, t1.id, { status: "u", memo: "Updated after unreconcile" })
          ).resolves.not.toThrow();

          const [t1Final] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t1.id));
          expect(t1Final?.status).toBe("u");
          expect(t1Final?.memo).toBe("Updated after unreconcile");
        });

        it("bulkUpdateTransactions: rejects batch containing a reconciled transaction and rolls back atomically", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const t1 = await createTransaction(db, {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "Store 1",
            amount: -3000,
            status: "c",
          });

          await reconcileAccount(db, {
            accountId,
            statementBalance: -3000,
            statementDate: "2026-08-01",
          });

          // Create a new unreconciled transaction
          const t2 = await createTransaction(db, {
            accountId,
            categoryId: cat2Id,
            date: "2026-08-02",
            payee: "Store 2",
            amount: -2000,
            status: "c",
          });

          // Attempt bulk update on [t2, t1] changing category
          await expect(
            bulkUpdateTransactions(db, [t2.id, t1.id], { categoryId: cat1Id })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Verify t2 was rolled back and still has cat2Id
          const [t2Db] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t2.id));
          expect(t2Db?.categoryId).toBe(cat2Id);

          // Verify t1 is still reconciled
          const [t1Db] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t1.id));
          expect(t1Db?.status).toBe("r");

          // Attempt bulk update changing status to 'u' on [t1, t2]
          await expect(
            bulkUpdateTransactions(db, [t1.id, t2.id], { status: "u" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Verify t1 and t2 status are unchanged
          const [t1Db2] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t1.id));
          expect(t1Db2?.status).toBe("r");

          const [t2Db2] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, t2.id));
          expect(t2Db2?.status).toBe("c");
        });

        it("rejects updateTransaction and bulkUpdateTransactions on split parents/children when reconciled", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Department Store",
              memo: "Items",
              amount: -8000,
              status: "c",
            },
            [
              { categoryId: cat1Id, amount: -5000, memo: "clothes" },
              { categoryId: cat2Id, amount: -3000, memo: "shoes" },
            ]
          );

          await reconcileAccount(db, {
            accountId,
            statementBalance: -8000,
            statementDate: "2026-08-01",
          });

          const child1 = split.children[0]!;

          // Attempting to update split child via updateTransaction must fail with 422
          await expect(
            updateTransaction(db, child1.id, { memo: "new child memo" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Attempting to update split parent via updateTransaction must fail with 422
          await expect(
            updateTransaction(db, split.parent.id, { payee: "New Store" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Attempting bulk update on split child must fail with 422
          await expect(
            bulkUpdateTransactions(db, [child1.id], { memo: "bulk child memo" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Attempting bulk update on split parent must fail with 422
          await expect(
            bulkUpdateTransactions(db, [split.parent.id], { payee: "Bulk Store" })
          ).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });
        });
      });

      describe("BUG-09: bulkUpdateTransactions self-transfer prevention", () => {
        it("rejects bulk updating a transfer's source account to its transferAccountId", async () => {
          const db = openMigratedDb();
          const [acctA] = await db
            .insert(schema.accounts)
            .values({ name: "Account A", kind: "liquid", groupLabel: "Budget Accounts", sort: 0 })
            .returning();
          const [acctB] = await db
            .insert(schema.accounts)
            .values({ name: "Account B", kind: "liquid", groupLabel: "Budget Accounts", sort: 1 })
            .returning();

          const transfer = await createTransfer(
            db,
            {
              accountId: acctA!.id,
              date: "2026-08-01",
              payee: "Transfer : Account B",
              memo: "",
              amount: -5000,
              categoryId: null,
            },
            acctB!.id
          );

          // Attempt to bulk-patch transfer with accountId = acctB.id
          await expect(
            bulkUpdateTransactions(db, [transfer.id], { accountId: acctB!.id })
          ).rejects.toMatchObject({
            name: "TransactionError",
            message: /transfer account must differ from source account/i,
          });
        });

        it("enforces database check constraint rejecting transactions where accountId === transferAccountId", async () => {
          const db = openMigratedDb();
          const [acct] = await db
            .insert(schema.accounts)
            .values({ name: "Single Account", kind: "liquid", groupLabel: "Budget Accounts", sort: 0 })
            .returning();

          // Direct database insert where accountId === transferAccountId must fail check constraint
          await expect(
            db.insert(schema.transactions).values({
              accountId: acct!.id,
              transferAccountId: acct!.id,
              date: "2026-08-01",
              payee: "Self Transfer",
              memo: "",
              amount: -5000,
            })
          ).rejects.toThrow(/CHECK constraint failed/);
        });
      });

      describe("BUG-10: Split-child amount edit restrictions and atomic full-split updates", () => {
        it("updateTransaction: rejects changing amount of a split child and rolls back", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Costco",
              memo: "Groceries & Household",
              amount: -10000,
            },
            [
              { categoryId: cat1Id, amount: -6000, memo: "groceries" },
              { categoryId: cat2Id, amount: -4000, memo: "household" },
            ]
          );

          const child1 = split.children[0]!;

          // Attempt to update child amount via updateTransaction
          await expect(
            updateTransaction(db, child1.id, { amount: -5000 })
          ).rejects.toMatchObject({
            status: 400,
            name: "TransactionError",
            message: /cannot change amount of a split child; edit the split/i,
          });

          // Verify parent, children, and account balance are untouched
          const [parent] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, split.parent.id));
          expect(parent?.amount).toBe(-10000);

          const [child] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, child1.id));
          expect(child?.amount).toBe(-6000);

          const [acct] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(-10000);
        });

        it("bulkUpdateTransactions: rejects changing amount of a split child and preserves split invariants", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Costco",
              memo: "Groceries & Household",
              amount: -10000,
            },
            [
              { categoryId: cat1Id, amount: -6000, memo: "groceries" },
              { categoryId: cat2Id, amount: -4000, memo: "household" },
            ]
          );

          const child1 = split.children[0]!;

          // Attempt to bulk update child amount
          await expect(
            bulkUpdateTransactions(db, [child1.id], { amount: -5000 })
          ).rejects.toMatchObject({
            status: 400,
            name: "TransactionError",
            message: /cannot change amount of a split child; edit the split/i,
          });

          // Verify invariant sum(children) === parent.amount
          const [parent] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, split.parent.id));
          expect(parent?.amount).toBe(-10000);

          const [child] = await db
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, child1.id));
          expect(child?.amount).toBe(-6000);

          const [acct] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(-10000);
        });

        it("updateSplit: atomically updates total parent amount and replaced children", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Costco",
              memo: "Original split",
              amount: -10000,
            },
            [
              { categoryId: cat1Id, amount: -6000, memo: "groceries" },
              { categoryId: cat2Id, amount: -4000, memo: "household" },
            ]
          );

          // Update split with new total amount (-12000) and new child amounts (-7000, -5000)
          const result = await updateSplit(
            db,
            split.parent.id,
            {
              amount: -12000,
              memo: "Updated split with higher amount",
            },
            [
              { categoryId: cat1Id, amount: -7000, memo: "more groceries" },
              { categoryId: cat2Id, amount: -5000, memo: "more household" },
            ]
          );

          expect(result.parent.amount).toBe(-12000);
          expect(result.children).toHaveLength(2);
          expect(result.children[0]?.amount).toBe(-7000);
          expect(result.children[1]?.amount).toBe(-5000);

          const [acct] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(-12000);
        });
      });

      describe("BUG-11: Deleting split child respects reconciled parent lock", () => {
        it("deleteTransaction: rejects deleting child of a reconciled parent with 422 even if child is uncleared", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Target",
              memo: "Shopping",
              amount: -5000,
              status: "c",
            },
            [
              { categoryId: cat1Id, amount: -3000, memo: "clothes" },
              { categoryId: cat2Id, amount: -2000, memo: "groceries" },
            ]
          );

          const child1 = split.children[0]!;

          // Set child 1 to uncleared ("u") and parent to reconciled ("r")
          await db
            .update(schema.transactions)
            .set({ status: "u" })
            .where(eq(schema.transactions.id, child1.id));
          await db
            .update(schema.transactions)
            .set({ status: "r", reconciledAt: "2026-08-01" })
            .where(eq(schema.transactions.id, split.parent.id));

          // Attempt to delete uncleared child1 individually via deleteTransaction
          await expect(deleteTransaction(db, child1.id)).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Verify transactions still exist
          const allTx = await db.select().from(schema.transactions);
          expect(allTx).toHaveLength(3);

          const [acct] = await db
            .select()
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(-5000);
        });

        it("bulkDeleteTransactions: rejects deleting child of a reconciled parent with 422", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Target",
              memo: "Shopping",
              amount: -5000,
              status: "c",
            },
            [
              { categoryId: cat1Id, amount: -3000, memo: "clothes" },
              { categoryId: cat2Id, amount: -2000, memo: "groceries" },
            ]
          );

          const child1 = split.children[0]!;

          // Mark parent as reconciled ("r")
          await db
            .update(schema.transactions)
            .set({ status: "r", reconciledAt: "2026-08-01" })
            .where(eq(schema.transactions.id, split.parent.id));

          // Attempt to bulk-delete child1
          await expect(bulkDeleteTransactions(db, [child1.id])).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });

          // Verify transactions still exist
          const allTx = await db.select().from(schema.transactions);
          expect(allTx).toHaveLength(3);
        });

        it("propagates status changes from split parent to split children on updateTransaction", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);

          const split = await createSplitWithChildren(
            db,
            {
              accountId,
              date: "2026-08-01",
              payee: "Supermarket",
              memo: "Weekly shop",
              amount: -5000,
              status: "c",
            },
            [
              { categoryId: cat1Id, amount: -3000, memo: "food" },
              { categoryId: cat2Id, amount: -2000, memo: "supplies" },
            ]
          );

          // Both children start as 'c'
          const [child1, child2] = split.children;

          // Update parent status to 'u'
          await updateTransaction(db, split.parent.id, { status: "u" });

          // Verify parent and both children are now 'u'
          const [parentDb] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.parent.id));
          expect(parentDb?.status).toBe("u");

          const [child1Db] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child1!.id));
          expect(child1Db?.status).toBe("u");

          const [child2Db] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child2!.id));
          expect(child2Db?.status).toBe("u");

          // Update parent status back to 'c'
          await updateTransaction(db, split.parent.id, { status: "c" });

          const [parentDb2] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.parent.id));
          expect(parentDb2?.status).toBe("c");

          const [child1Db2] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child1!.id));
          expect(child1Db2?.status).toBe("c");

          const [child2Db2] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, child2!.id));
          expect(child2Db2?.status).toBe("c");
        });
      });
    });
  });

  describe("BUG-19: Strict calendar date validation", () => {
    it("rejects createTransaction with invalid calendar date or incomeMonth", async () => {
      const db = openMigratedDb();
      const { accountId } = await seedTestData(db);

      await expect(
        createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-02-31",
          payee: "Test",
          memo: "",
          amount: -1000,
        })
      ).rejects.toThrow(/Invalid calendar date/);

      await expect(
        createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-06-15",
          payee: "Income",
          memo: "",
          amount: 1000,
          incomeMonth: "2026-13",
        })
      ).rejects.toThrow(/Invalid month format/);
    });

    it("rejects createSplitWithChildren with invalid calendar date", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      await expect(
        createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-02-31",
            payee: "Split",
            memo: "",
            amount: -2000,
          },
          [
            { categoryId: cat1Id, amount: -1000 },
            { categoryId: cat2Id, amount: -1000 },
          ]
        )
      ).rejects.toThrow(/Invalid calendar date/);
    });

    it("rejects updateTransaction with invalid calendar date", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id } = await seedTestData(db);

      const txn = await createTransaction(db, {
        accountId,
        categoryId: cat1Id,
        date: "2026-06-15",
        payee: "Valid",
        memo: "",
        amount: -1000,
      });

      await expect(
        updateTransaction(db, txn!.id, { date: "2026-04-31" })
      ).rejects.toThrow(/Invalid calendar date/);
    });

    it("rejects bulkUpdateTransactions with invalid calendar date", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id } = await seedTestData(db);

      const txn = await createTransaction(db, {
        accountId,
        categoryId: cat1Id,
        date: "2026-06-15",
        payee: "Valid",
        memo: "",
        amount: -1000,
      });

      await expect(
        bulkUpdateTransactions(db, [txn!.id], { date: "2026-02-29" })
      ).rejects.toThrow(/Invalid calendar date/);
    });
  });

  describe("BUG-40: Nonzero amount constraints", () => {
    it("rejects createTransaction with amount 0", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id } = await seedTestData(db);

      await expect(
        createTransaction(db, {
          accountId,
          categoryId: cat1Id,
          date: "2026-06-15",
          payee: "Test",
          memo: "",
          amount: 0,
        })
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("rejects updateTransaction with amount 0", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id } = await seedTestData(db);

      const txn = await createTransaction(db, {
        accountId,
        categoryId: cat1Id,
        date: "2026-06-15",
        payee: "Test",
        memo: "",
        amount: 1000,
      });

      await expect(
        updateTransaction(db, txn!.id, { amount: 0 })
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("rejects createTransfer with amount 0", async () => {
      const db = openMigratedDb();
      const { accountId } = await seedTestData(db);
      const [otherAcct] = await db
        .insert(schema.accounts)
        .values({
          name: "Savings",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          balance: 0,
          onBudget: true,
          sort: 1,
        })
        .returning();

      await expect(
        createTransfer(db, {
          accountId,
          categoryId: null,
          date: "2026-06-15",
          payee: "Transfer",
          memo: "",
          amount: 0,
        }, otherAcct!.id)
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("rejects createSplitWithChildren with zero parent amount or zero child amount", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id, cat2Id } = await seedTestData(db);

      await expect(
        createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-06-15",
            payee: "Split",
            memo: "",
            amount: 0,
          },
          [
            { categoryId: cat1Id, amount: 0, memo: "c1" },
            { categoryId: cat2Id, amount: 0, memo: "c2" },
          ]
        )
      ).rejects.toThrow(/Amount cannot be zero/);

      await expect(
        createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-06-15",
            payee: "Split",
            memo: "",
            amount: -5000,
          },
          [
            { categoryId: cat1Id, amount: -5000, memo: "c1" },
            { categoryId: cat2Id, amount: 0, memo: "c2" },
          ]
        )
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("rejects bulkUpdateTransactions with amount 0", async () => {
      const db = openMigratedDb();
      const { accountId, cat1Id } = await seedTestData(db);

      const txn = await createTransaction(db, {
        accountId,
        categoryId: cat1Id,
        date: "2026-06-15",
        payee: "Test",
        memo: "",
        amount: 1000,
      });

      await expect(
        bulkUpdateTransactions(db, [txn!.id], { amount: 0 })
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("enforces database CHECK constraint for amount != 0 on direct SQL insert", async () => {
      const db = openMigratedDb();
      const { accountId } = await seedTestData(db);

      expect(() => {
        db.insert(schema.transactions)
          .values({
            accountId,
            date: "2026-06-15",
            amount: 0,
            status: "c",
          })
          .run();
      }).toThrow(/CHECK constraint failed: transactions_amount_check/);
    });

    describe("BUG-06: editing split children categories and fields without invalid balance failures", () => {
      it("allows single updateTransaction on split child to set categoryId: null", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Costco",
            memo: "Groceries & Household",
            amount: -10000,
          },
          [
            { categoryId: cat1Id, amount: -6000, memo: "groceries" },
            { categoryId: cat2Id, amount: -4000, memo: "household" },
          ]
        );

        const child1 = split.children[0]!;
        const updated = await updateTransaction(db, child1.id, { categoryId: null });
        expect(updated).toBeDefined();
        expect(updated!.categoryId).toBeNull();
      });

      it("allows bulkUpdateTransactions on split children to set categoryId: null", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Costco",
            memo: "Groceries & Household",
            amount: -10000,
          },
          [
            { categoryId: cat1Id, amount: -6000, memo: "groceries" },
            { categoryId: cat2Id, amount: -4000, memo: "household" },
          ]
        );

        const childIds = split.children.map((c) => c.id);
        const updated = await bulkUpdateTransactions(db, childIds, { categoryId: null });
        expect(updated).toHaveLength(2);
        expect(updated.every((c) => c.categoryId === null)).toBe(true);
      });

      it("allows bulkUpdateTransactions on split children to update date and status without balance validation failure", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Costco",
            memo: "Groceries & Household",
            amount: -10000,
          },
          [
            { categoryId: cat1Id, amount: -6000, memo: "groceries" },
            { categoryId: cat2Id, amount: -4000, memo: "household" },
          ]
        );

        const child1 = split.children[0]!;
        const updated = await bulkUpdateTransactions(db, [child1.id], { status: "u", date: "2026-08-05" });
        expect(updated).toHaveLength(1);
        expect(updated[0]!.status).toBe("u");
        expect(updated[0]!.date).toBe("2026-08-05");
      });

      it("BUG-10: propagates date changes on split children to parent and sibling children on updateTransaction", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Costco",
            memo: "Groceries & Household",
            amount: -10000,
          },
          [
            { categoryId: cat1Id, amount: -6000, memo: "groceries" },
            { categoryId: cat2Id, amount: -4000, memo: "household" },
          ]
        );

        const child1 = split.children[0]!;
        await updateTransaction(db, child1.id, { date: "2026-08-15" });

        const [parentRow] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.parent.id));
        const [child1Row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.children[0]!.id));
        const [child2Row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.children[1]!.id));

        expect(parentRow?.date).toBe("2026-08-15");
        expect(child1Row?.date).toBe("2026-08-15");
        expect(child2Row?.date).toBe("2026-08-15");
      });

      it("BUG-10: propagates date changes on split children to parent and sibling children on bulkUpdateTransactions", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Costco",
            memo: "Groceries & Household",
            amount: -10000,
          },
          [
            { categoryId: cat1Id, amount: -6000, memo: "groceries" },
            { categoryId: cat2Id, amount: -4000, memo: "household" },
          ]
        );

        const child1 = split.children[0]!;
        await bulkUpdateTransactions(db, [child1.id], { date: "2026-08-20" });

        const [parentRow] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.parent.id));
        const [child1Row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.children[0]!.id));
        const [child2Row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, split.children[1]!.id));

        expect(parentRow?.date).toBe("2026-08-20");
        expect(child1Row?.date).toBe("2026-08-20");
        expect(child2Row?.date).toBe("2026-08-20");
      });
    });

    describe("BUG-05: deterministic split propagation in bulkUpdateTransactions", () => {
      async function seedSplitForBug05(db: ReturnType<typeof openMigratedDb>) {
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);
        return createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-01",
            payee: "Target",
            memo: "Split items",
            amount: -5000,
            status: "c",
          },
          [
            { categoryId: cat1Id, amount: -3000, memo: "Groceries" },
            { categoryId: cat2Id, amount: -2000, memo: "Household" },
          ]
        );
      }

      async function familyRows(db: ReturnType<typeof openMigratedDb>, parentId: number) {
        return db
          .select()
          .from(schema.transactions)
          .where(or(eq(schema.transactions.id, parentId), eq(schema.transactions.parentId, parentId)));
      }

      it("status propagation is order-independent: [child1, parent] and [parent, child1] converge", async () => {
        const dbA = openMigratedDb();
        const splitA = await seedSplitForBug05(dbA);
        await bulkUpdateTransactions(dbA, [splitA.children[0]!.id, splitA.parent.id], { status: "u" });

        const dbB = openMigratedDb();
        const splitB = await seedSplitForBug05(dbB);
        await bulkUpdateTransactions(dbB, [splitB.parent.id, splitB.children[0]!.id], { status: "u" });

        const rowsA = await familyRows(dbA, splitA.parent.id);
        const rowsB = await familyRows(dbB, splitB.parent.id);
        expect(rowsA).toHaveLength(3);
        expect(rowsB).toHaveLength(3);
        for (const row of [...rowsA, ...rowsB]) {
          expect(row.status).toBe("u");
          expect(row.reconciledAt).toBeNull();
          expect(row.reconciliationId).toBeNull();
        }
      });

      it("date propagation is order-independent: [child1, child2] and [child2, child1] converge", async () => {
        const dbA = openMigratedDb();
        const splitA = await seedSplitForBug05(dbA);
        await bulkUpdateTransactions(
          dbA,
          [splitA.children[0]!.id, splitA.children[1]!.id],
          { date: "2026-08-20" }
        );

        const dbB = openMigratedDb();
        const splitB = await seedSplitForBug05(dbB);
        await bulkUpdateTransactions(
          dbB,
          [splitB.children[1]!.id, splitB.children[0]!.id],
          { date: "2026-08-20" }
        );

        const rowsA = await familyRows(dbA, splitA.parent.id);
        const rowsB = await familyRows(dbB, splitB.parent.id);
        expect(rowsA).toHaveLength(3);
        expect(rowsB).toHaveLength(3);
        for (const row of [...rowsA, ...rowsB]) {
          expect(row.date).toBe("2026-08-20");
        }
      });

      it("bulk-updating one child rejects with 422 instead of clobbering a reconciled sibling", async () => {
        const db = openMigratedDb();
        const split = await seedSplitForBug05(db);
        const child1 = split.children[0]!;
        const child2 = split.children[1]!;

        await db
          .update(schema.transactions)
          .set({ status: "r", reconciledAt: "2026-08-01" })
          .where(eq(schema.transactions.id, child1.id));

        await expect(bulkUpdateTransactions(db, [child2.id], { status: "u" })).rejects.toMatchObject({
          status: 422,
          name: "TransactionError",
          message: /reconciled and locked/i,
        });

        const rows = await familyRows(db, split.parent.id);
        const rowById = new Map(rows.map((r) => [r.id, r]));
        expect(rowById.get(child1.id)?.status).toBe("r");
        expect(rowById.get(child1.id)?.reconciledAt).toBe("2026-08-01");
        expect(rowById.get(child2.id)?.status).toBe("c");
        expect(rowById.get(split.parent.id)?.status).toBe("c");
      });

      it("batch containing parent and child rejects with 422 regardless of order when a sibling is reconciled", async () => {
        for (const order of ["child-first", "parent-first"] as const) {
          const db = openMigratedDb();
          const split = await seedSplitForBug05(db);

          await db
            .update(schema.transactions)
            .set({ status: "r", reconciledAt: "2026-08-01" })
            .where(eq(schema.transactions.id, split.children[0]!.id));

          const ids =
            order === "child-first"
              ? [split.children[1]!.id, split.parent.id]
              : [split.parent.id, split.children[1]!.id];

          await expect(bulkUpdateTransactions(db, ids, { status: "u" })).rejects.toMatchObject({
            status: 422,
            name: "TransactionError",
            message: /reconciled and locked/i,
          });
        }
      });
    });

    describe("BUG-18.2: split-child income parity", () => {
      it("createTransaction(parentId) marks uncategorized positive children as income, matching createSplitWithChildren", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);

        // Engine-level path: split parent + one uncategorized positive child,
        // one categorized negative child, via createTransaction(parentId).
        const parentA = await createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-08-01",
          payee: "Parent A",
          memo: "",
          amount: 300,
          skipBalance: true,
        });
        const enginePositiveChild = await createTransaction(db, {
          accountId,
          parentId: parentA!.id,
          categoryId: null,
          date: "2026-08-01",
          payee: "Income leg",
          memo: "",
          amount: 500,
        });
        const engineCategorizedChild = await createTransaction(db, {
          accountId,
          parentId: parentA!.id,
          categoryId: cat1Id,
          date: "2026-08-01",
          payee: "Expense leg",
          memo: "",
          amount: -200,
        });

        // Split-handler path for the same child shapes.
        const splitB = await createSplitWithChildren(
          db,
          { accountId, date: "2026-08-01", payee: "Parent B", memo: "", amount: 300 },
          [
            { categoryId: null, amount: 500 },
            { categoryId: cat1Id, amount: -200 },
          ]
        );

        expect(enginePositiveChild!.isIncome).toBe(
          splitB.children[0]!.isIncome
        );
        expect(enginePositiveChild!.isIncome).toBe(true);
        expect(engineCategorizedChild!.isIncome).toBe(
          splitB.children[1]!.isIncome
        );
        expect(engineCategorizedChild!.isIncome).toBe(false);
      });

      it("createTransaction(parentId) marks categorized negative children as not income, matching createSplitWithChildren", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id, cat2Id } = await seedTestData(db);

        const parent = await createTransaction(db, {
          accountId,
          categoryId: null,
          date: "2026-08-01",
          payee: "Parent",
          memo: "",
          amount: -100,
          skipBalance: true,
        });
        const engineCategorizedChild = await createTransaction(db, {
          accountId,
          parentId: parent!.id,
          categoryId: cat1Id,
          date: "2026-08-01",
          payee: "Expense",
          memo: "",
          amount: -100,
        });

        const split = await createSplitWithChildren(
          db,
          { accountId, date: "2026-08-01", payee: "Split", memo: "", amount: -100 },
          [
            { categoryId: cat1Id, amount: -40 },
            { categoryId: cat2Id, amount: -60 },
          ]
        );

        expect(engineCategorizedChild!.isIncome).toBe(split.children[0]!.isIncome);
        expect(engineCategorizedChild!.isIncome).toBe(false);
      });

      it("updateTransaction preserves income classification for uncategorized positive split children", async () => {
        const db = openMigratedDb();
        const { accountId } = await seedTestData(db);

        const split = await createSplitWithChildren(
          db,
          { accountId, date: "2026-08-01", payee: "Paycheck", memo: "", amount: 300 },
          [
            { categoryId: null, amount: 100 },
            { categoryId: 1, amount: 200 },
          ]
        );
        expect(split.children[0]!.isIncome).toBe(true);

        // A memo-only edit on the uncategorized positive child must not
        // silently clear its income classification.
        const updated = await updateTransaction(db, split.children[0]!.id, {
          memo: "edited",
        });
        expect(updated?.isIncome).toBe(true);

        // And categorizing the child flips isIncome off, as everywhere else.
        const recategorized = await updateTransaction(db, split.children[0]!.id, {
          categoryId: 1,
        });
        expect(recategorized?.isIncome).toBe(false);
      });

      describe("BUG-01: Correct balance delta on updateTransaction and bulkUpdateTransactions", () => {
        it("updateTransaction: editing amount does not double-subtract old amount", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id } = await seedTestData(db);
          // Initial balance from seedTestData: account has balance 0
          // Set starting balance to 10000 cents ($100.00)
          await db.update(schema.accounts).set({ balance: 10000 }).where(eq(schema.accounts.id, accountId));

          // 1. Create transaction for -$10.00 (-1000 cents)
          const txn = await createTransaction(db, {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "Coffee",
            memo: "",
            amount: -1000,
          });
          expect(txn).toBeDefined();

          let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(9000); // $90.00

          // 2. Edit amount to -$30.00 (-3000 cents)
          await updateTransaction(db, txn!.id, { amount: -3000 });

          [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          // Correct balance should be 10000 - 3000 = 7000 ($70.00)
          // Under the bug, it was 8000 ($80.00) due to double-subtraction of old amount
          expect(acct?.balance).toBe(7000);
        });

        it("bulkUpdateTransactions: editing amount does not double-subtract old amount", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id } = await seedTestData(db);
          await db.update(schema.accounts).set({ balance: 10000 }).where(eq(schema.accounts.id, accountId));

          const txn = await createTransaction(db, {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "Coffee",
            memo: "",
            amount: -1000,
          });

          let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(9000);

          await bulkUpdateTransactions(db, [txn!.id], { amount: -3000 });

          [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(7000);
        });
      });

      describe("BUG-02: Converting single transaction to a split in updateSplit", () => {
        it("converts a single transaction into a split transaction with correct balance", async () => {
          const db = openMigratedDb();
          const { accountId, cat1Id, cat2Id } = await seedTestData(db);
          await db.update(schema.accounts).set({ balance: 20000 }).where(eq(schema.accounts.id, accountId));

          // 1. Create a regular single transaction of -$100.00 (-10000 cents)
          const single = await createTransaction(db, {
            accountId,
            categoryId: cat1Id,
            date: "2026-08-01",
            payee: "Whole Foods",
            memo: "Groceries",
            amount: -10000,
          });

          let [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(10000); // 20000 - 10000 = 10000 ($100.00)

          // 2. Convert to a split transaction with two children (-6000, -4000)
          const splitResult = await updateSplit(
            db,
            single!.id,
            { payee: "Whole Foods Split" },
            [
              { categoryId: cat1Id, amount: -6000, memo: "groceries" },
              { categoryId: cat2Id, amount: -4000, memo: "household" },
            ]
          );

          expect(splitResult.parent.id).toBe(single!.id);
          expect(splitResult.children).toHaveLength(2);

          // Verify parent row categoryId is cleared
          const [parentRow] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, single!.id));
          expect(parentRow?.categoryId).toBeNull();
          expect(parentRow?.isIncome).toBe(false);

          // Account balance should remain 10000 (parent -10000 reversed, children -6000 + -4000 = -10000 applied)
          [acct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
          expect(acct?.balance).toBe(10000);
        });
      });
    });

    describe("BUG-02 & BUG-03: Income classification and bulk update invariants", () => {
      it("BUG-02: manual uncategorized inflow on a credit card is never classified as income", async () => {
        const db = openMigratedDb();
        const { accountId: liquidId } = await seedTestData(db);
        const [ccAcct] = await db
          .insert(schema.accounts)
          .values({
            name: "Credit Card",
            kind: "credit",
            groupLabel: "Credit Cards",
            balance: -50000,
            onBudget: true,
            sort: 10,
          })
          .returning();

        // 1. Plain uncategorized positive transaction on credit card
        const ccTx = await createTransaction(db, {
          accountId: ccAcct!.id,
          categoryId: null,
          date: "2026-08-01",
          payee: "Cashback Refund",
          memo: "Manual refund",
          amount: 2500,
        });
        expect(ccTx?.isIncome).toBe(false);
        expect(ccTx?.incomeMonth).toBeNull();

        // 2. updateTransaction on credit card
        const updatedCcTx = await updateTransaction(db, ccTx!.id, {
          amount: 3000,
        });
        expect(updatedCcTx?.isIncome).toBe(false);
        expect(updatedCcTx?.incomeMonth).toBeNull();

        // 3. createSplitWithChildren on credit card with positive uncategorized child
        const ccSplit = await createSplitWithChildren(
          db,
          {
            accountId: ccAcct!.id,
            date: "2026-08-02",
            payee: "Card Adjustment",
            memo: "",
            amount: 5000,
          },
          [
            { categoryId: null, amount: 2000, memo: "cashback" },
            { categoryId: null, amount: 3000, memo: "bonus" },
          ]
        );
        expect(ccSplit.children[0]?.isIncome).toBe(false);
        expect(ccSplit.children[1]?.isIncome).toBe(false);

        // 4. bulkUpdateTransactions on credit card
        await bulkUpdateTransactions(db, [ccTx!.id], { memo: "Bulk edited CC memo" });
        const [reloadedCcTx] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, ccTx!.id));
        expect(reloadedCcTx?.isIncome).toBe(false);
      });

      it("BUG-03: bulkUpdateTransactions preserves isIncome and incomeMonth on split income children", async () => {
        const db = openMigratedDb();
        const { accountId, cat1Id } = await seedTestData(db);

        // 1. Create a split on a liquid account: $1000 paycheck ($800 income, $200 expense reimbursement)
        const split = await createSplitWithChildren(
          db,
          {
            accountId,
            date: "2026-08-15",
            payee: "Employer Inc",
            memo: "Paycheck split",
            amount: 100000,
          },
          [
            { categoryId: null, amount: 80000, memo: "Base salary" },
            { categoryId: cat1Id, amount: 20000, memo: "Expense reimbursement" },
          ]
        );

        const incomeChild = split.children.find((c) => c.categoryId == null);
        expect(incomeChild).toBeDefined();
        expect(incomeChild?.isIncome).toBe(true);

        // 2. Bulk update non-financial fields (date, memo, status, flagColor) on the income split child
        const bulkRes = await bulkUpdateTransactions(db, [incomeChild!.id], {
          date: "2026-08-20",
          memo: "Updated salary memo",
          status: "c",
          flagColor: "blue",
        });

        expect(bulkRes).toHaveLength(1);
        expect(bulkRes[0]?.isIncome).toBe(true);

        // Verify in database
        const [dbChild] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, incomeChild!.id));
        expect(dbChild?.isIncome).toBe(true);
        expect(dbChild?.memo).toBe("Updated salary memo");
        expect(dbChild?.date).toBe("2026-08-20");

        // 3. If bulk updating categoryId to a real category, isIncome should become false
        const bulkCatRes = await bulkUpdateTransactions(db, [incomeChild!.id], {
          categoryId: cat1Id,
        });
        expect(bulkCatRes[0]?.isIncome).toBe(false);
        expect(bulkCatRes[0]?.categoryId).toBe(cat1Id);

        // 4. If bulk updating categoryId back to null on liquid account with amount > 0, isIncome becomes true
        const bulkNullCatRes = await bulkUpdateTransactions(db, [incomeChild!.id], {
          categoryId: null,
        });
        expect(bulkNullCatRes[0]?.isIncome).toBe(true);
        expect(bulkNullCatRes[0]?.categoryId).toBeNull();
      });
    });
  });
});
