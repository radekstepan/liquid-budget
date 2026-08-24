import { describe, expect, it, beforeEach } from "vitest";
import {
  autoPostDueRecurringTransactions,
  createRecurring,
  deleteRecurring,
  postRecurringTransaction,
  RecurringError,
  updateRecurring,
} from "../src/queries/recurring.js";
import { createMockDb, type MockDb } from "./mock-db.js";

const existingRow = {
  id: 1,
  accountId: 1,
  categoryId: 2,
  payee: "Netflix",
  amount: -1599,
  frequency: "monthly",
  nextDate: "2026-07-15",
  active: true,
  transferAccountId: null,
};

describe("recurring queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  describe("createRecurring", () => {
    it("inserts with defaults", async () => {
      mock.respondWith("insert:recurring", [{ id: 1 }]);
      const row = await createRecurring(mock.db, {
        accountId: 1,
        categoryId: 2,
        payee: "Netflix",
        amount: -1599,
        frequency: "monthly",
        nextDate: "2026-07-15",
      });
      expect(row).toMatchObject({ id: 1 });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: 2,
        payee: "Netflix",
        amount: -1599,
        frequency: "monthly",
        nextDate: "2026-07-15",
        active: true,
        transferAccountId: null,
      });
    });

    it("rounds float amounts to nearest integer cent", async () => {
      mock.respondWith("insert:recurring", [{ id: 2 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: 2,
        payee: "Netflix",
        amount: -1599.4,
        frequency: "monthly",
        nextDate: "2026-07-15",
      });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        amount: -1599,
      });
    });

    it("creates a recurring transfer", async () => {
      mock.respondWith("insert:recurring", [{ id: 1 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "AMEX Payment",
        amount: -100000,
        frequency: "monthly",
        nextDate: "2026-07-20",
        transferAccountId: 2,
      });
      const insertCall = mock.calls.find((c) => c.op === "insert");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: null,
        transferAccountId: 2,
      });
      const insertCount = mock.calls.filter((c) => c.op === "insert").length;
      expect(insertCount).toBe(1);
    });

    it("rejects a transfer to the same account", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Self",
          amount: -10000,
          frequency: "monthly",
          nextDate: "2026-07-20",
          transferAccountId: 1,
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("creates a recurring split with children", async () => {
      mock.respondWith("insert:recurring", [{ id: 7 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Costco",
        amount: -20000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        subTransactions: [
          { categoryId: 5, amount: -12000, memo: "groceries" },
          { categoryId: 6, amount: -8000, memo: "household" },
        ],
      });
      const inserts = mock.calls.filter((c) => c.op === "insert");
      const subValues = inserts
        .filter((c) => c.table === "recurring_sub_transactions")
        .map((c) => c.values);
      expect(subValues).toHaveLength(2);
      expect(subValues[0]).toMatchObject({
        recurringId: 7,
        categoryId: 5,
        amount: -12000,
        memo: "groceries",
        sort: 0,
      });
      expect(subValues[1]).toMatchObject({
        recurringId: 7,
        categoryId: 6,
        amount: -8000,
        memo: "household",
        sort: 1,
      });
    });

    it("rounds float amounts in split parent and sub-transactions", async () => {
      mock.respondWith("insert:recurring", [{ id: 8 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Costco",
        amount: -20000.4,
        frequency: "monthly",
        nextDate: "2026-07-01",
        subTransactions: [
          { categoryId: 5, amount: -12000.2, memo: "groceries" },
          { categoryId: 6, amount: -8000.2, memo: "household" },
        ],
      });
      const inserts = mock.calls.filter((c) => c.op === "insert");
      expect(inserts[0]?.values).toMatchObject({ amount: -20000 });
      const subValues = inserts
        .filter((c) => c.table === "recurring_sub_transactions")
        .map((c) => c.values);
      expect(subValues[0]).toMatchObject({ amount: -12000 });
      expect(subValues[1]).toMatchObject({ amount: -8000 });
    });

    it("rejects a split with fewer than two children", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Costco",
          amount: -20000,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [{ categoryId: 5, amount: -20000 }],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("rejects an unbalanced split", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Costco",
          amount: -20000,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [
            { categoryId: 5, amount: -10000 },
            { categoryId: 6, amount: -9000 },
          ],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("creates a mixed-sign split (Paycheck + tax deduction)", async () => {
      mock.respondWith("insert:recurring", [{ id: 8 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);

      const row = await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Employer Inc.",
        amount: 400000,
        frequency: "biweekly",
        nextDate: "2026-07-15",
        subTransactions: [
          { categoryId: 5, amount: 500000, memo: "gross" },
          { categoryId: 6, amount: -100000, memo: "taxes" },
        ],
      });

      expect(row).toMatchObject({ id: 8 });
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({ amount: 500000 });
      expect(subInserts[1]?.values).toMatchObject({ amount: -100000 });
    });

    it("creates a recurring split containing a transfer sub-transaction (Issue #15)", () => {
      mock.respondWith("insert:recurring", [{ id: 9 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);

      return createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Transfer and Spend",
        amount: -25000,
        frequency: "monthly",
        nextDate: "2026-07-15",
        subTransactions: [
          { categoryId: 5, amount: -15000, memo: "groceries" },
          { transferAccountId: 2, amount: -10000, memo: "savings transfer" },
        ],
      }).then(() => {
        const subInserts = mock.calls.filter(
          (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
        );
        expect(subInserts).toHaveLength(2);
        expect(subInserts[0]?.values).toMatchObject({
          categoryId: 5,
          transferAccountId: null,
          amount: -15000,
        });
        expect(subInserts[1]?.values).toMatchObject({
          categoryId: null,
          transferAccountId: 2,
          amount: -10000,
        });
      });
    });

    it("rejects a split with a missing category on update", async () => {
      const splitRow = { ...existingRow, amount: 20000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);

      await expect(
        updateRecurring(mock.db, 1, {
          subTransactions: [
            { categoryId: 5, amount: 10000 },
            { categoryId: 0, amount: 10000 },
          ],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("updateRecurring: replacing children with a mixed-sign split succeeds", async () => {
      const splitRow = { ...existingRow, amount: 400000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [splitRow]);

      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: 5, amount: 500000 },
          { categoryId: 6, amount: -100000 },
        ],
      });

      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({ amount: 500000 });
      expect(subInserts[1]?.values).toMatchObject({ amount: -100000 });
    });
  });

  describe("updateRecurring", () => {
    it("only sets fields that are provided", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { payee: "New", nextDate: "2026-08-15" });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ payee: "New", nextDate: "2026-08-15" });
    });

    it("allows null categoryId to clear the link", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { categoryId: null });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ categoryId: null });
    });

    it("replaces sub-transactions when the key is present", async () => {
      const splitRow = { ...existingRow, amount: -20000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [splitRow]);
      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: 5, amount: -12000 },
          { categoryId: 6, amount: -8000 },
        ],
      });
      const calls = mock.calls.map((c) => `${c.op}:${c.table ?? "?"}`);
      expect(calls).toContain("delete:recurring_sub_transactions");
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
    });

    it("removes all sub-transactions when the key is present with []", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, { subTransactions: [] });
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(0);
    });

    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:recurring", []);
      const out = await updateRecurring(mock.db, 99, { payee: "X" });
      expect(out).toBeNull();
    });
  });

  describe("deleteRecurring", () => {
    it("issues a delete on the recurring table", async () => {
      await deleteRecurring(mock.db, 5);
      const deleteCall = mock.calls.find((c) => c.op === "delete");
      expect(deleteCall?.table).toBe("recurring");
    });
  });

  describe("postRecurringTransaction & autoPostDueRecurringTransactions", () => {
    it("UNI-09 / F-05: posts at scheduled nextDate, advances nextDate, and preserves mixed-sign split children", async () => {
      const splitRecurring = {
        id: 10,
        accountId: 1,
        categoryId: null,
        payee: "Employer Inc",
        amount: 400000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [splitRecurring]);
      mock.respondWith("select:recurring_sub_transactions", [
        { id: 101, recurringId: 10, categoryId: 10, amount: 500000, memo: "Gross", sort: 0, transferAccountId: null },
        { id: 102, recurringId: 10, categoryId: 11, amount: -100000, memo: "Tax", sort: 1, transferAccountId: null },
      ]);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 99, date: "2026-07-01", amount: 400000 }]);
      mock.respondWith("insert:transactions", [{ id: 100, amount: 500000 }]);
      mock.respondWith("insert:transactions", [{ id: 101, amount: -100000 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...splitRecurring, nextDate: "2026-08-01" }]);

      const res = await postRecurringTransaction(mock.db, 10);
      expect(res.nextDate).toBe("2026-08-01");
      const parentInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(parentInsert?.values).toMatchObject({
        date: "2026-07-01",
        amount: 400000,
      });
    });

    it("UNI-09 / F-05: auto-posts due recurring transactions with nextDate <= asOfDate", async () => {
      const dueRow = {
        id: 20,
        accountId: 1,
        categoryId: 5,
        payee: "Gym",
        amount: -5000,
        frequency: "monthly",
        nextDate: "2026-06-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [dueRow]);
      mock.respondWithNth("select:recurring", 2, [dueRow]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 200, date: "2026-06-01" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...dueRow, nextDate: "2026-07-01" }]);

      const posted = await autoPostDueRecurringTransactions(mock.db, "2026-06-15");
      expect(posted).toHaveLength(1);
    });

    it("auto-deactivates one-off (frequency=never) transactions when posted", async () => {
      const oneOffRow = {
        id: 30,
        accountId: 1,
        categoryId: 5,
        payee: "One-off repair",
        amount: -12000,
        frequency: "never",
        nextDate: "2026-06-15",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [oneOffRow]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 300, date: "2026-06-15" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...oneOffRow, active: false }]);

      const res = await postRecurringTransaction(mock.db, 30);
      expect(res.active).toBe(false);

      const updateCall = mock.calls.find((c) => c.op === "update" && c.table === "recurring");
      expect(updateCall?.set).toMatchObject({ active: false });
    });
  });
});
