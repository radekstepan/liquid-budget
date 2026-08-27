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

    it("creates a recurring boundary transfer to off-budget preserving categoryId (BUG-01)", async () => {
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("insert:recurring", [{ id: 10 }]);

      const row = await createRecurring(mock.db, {
        accountId: 1,
        categoryId: 5,
        payee: "Wealthsimple TFSA",
        amount: -50000,
        frequency: "monthly",
        nextDate: "2026-07-20",
        transferAccountId: 2,
      });

      expect(row).toMatchObject({ id: 10 });
      const insertCall = mock.calls.find((c) => c.op === "insert" && c.table === "recurring");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: 5,
        transferAccountId: 2,
        amount: -50000,
      });
    });

    it("rejects a boundary transfer outflow to off-budget without category with 422 (BUG-01)", async () => {
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);

      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Wealthsimple TFSA",
          amount: -50000,
          frequency: "monthly",
          nextDate: "2026-07-20",
          transferAccountId: 2,
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Boundary transfer outflow requires a category",
        status: 422,
      });
    });

    it("allows a boundary transfer inflow from off-budget without category (BUG-01)", async () => {
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("insert:recurring", [{ id: 11 }]);

      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "TFSA Withdrawal",
        amount: 50000,
        frequency: "monthly",
        nextDate: "2026-07-20",
        transferAccountId: 2,
      });

      const insertCall = mock.calls.find((c) => c.op === "insert" && c.table === "recurring");
      expect(insertCall?.values).toMatchObject({
        accountId: 1,
        categoryId: null,
        transferAccountId: 2,
        amount: 50000,
      });
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

    it("rejects an invalid frequency on create with 422", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: 2,
          payee: "Netflix",
          amount: -1599,
          frequency: "every-fortnight-some-day",
          nextDate: "2026-07-15",
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 422,
      });
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

      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Costco",
          amount: -20000,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [],
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "split must have at least two sub-transactions",
      });
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

    it("rejects a split child transferring to the recurring source account", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Split with self transfer",
          amount: -20000,
          frequency: "monthly",
          nextDate: "2026-07-01",
          subTransactions: [
            { categoryId: 5, amount: -10000 },
            { transferAccountId: 1, amount: -10000 },
          ],
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "transfer account must differ from source account",
      });
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

    it("creates a recurring split containing an off-budget transfer child preserving categoryId (BUG-02)", async () => {
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("insert:recurring", [{ id: 9 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);

      await createRecurring(mock.db, {
        accountId: 1,
        categoryId: null,
        payee: "Paycheck with RRSP Transfer",
        amount: 350000,
        frequency: "monthly",
        nextDate: "2026-07-15",
        subTransactions: [
          { categoryId: null, amount: 400000, memo: "gross pay" },
          { categoryId: 15, transferAccountId: 2, amount: -50000, memo: "RRSP contribution" },
        ],
      });

      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({
        categoryId: null,
        transferAccountId: null,
        amount: 400000,
      });
      expect(subInserts[1]?.values).toMatchObject({
        categoryId: 15,
        transferAccountId: 2,
        amount: -50000,
      });
    });

    it("rejects a recurring split with a boundary transfer outflow child missing a category with 422 (BUG-02)", async () => {
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("insert:recurring", [{ id: 9 }]);

      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: null,
          payee: "Paycheck with RRSP Transfer",
          amount: 350000,
          frequency: "monthly",
          nextDate: "2026-07-15",
          subTransactions: [
            { categoryId: null, amount: 400000, memo: "gross pay" },
            { categoryId: null, transferAccountId: 2, amount: -50000, memo: "RRSP contribution" },
          ],
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Boundary transfer outflow requires a category",
        status: 422,
      });
    });

    it("creates a mixed-sign split with a positive null-category income leg", async () => {
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
          { categoryId: null, amount: 500000, memo: "gross pay (income)" },
          { categoryId: 6, amount: -100000, memo: "taxes" },
        ],
      });

      expect(row).toMatchObject({ id: 8 });
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({ categoryId: null, amount: 500000 });
      expect(subInserts[1]?.values).toMatchObject({ categoryId: 6, amount: -100000 });
    });

    it("rejects a split with a negative missing category on update", async () => {
      const splitRow = { ...existingRow, amount: -20000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);

      await expect(
        updateRecurring(mock.db, 1, {
          subTransactions: [
            { categoryId: 5, amount: -10000 },
            { categoryId: 0, amount: -10000 },
          ],
        })
      ).rejects.toBeInstanceOf(RecurringError);
    });

    it("allows updating a split with a positive null-category income child", async () => {
      const splitRow = { ...existingRow, amount: 400000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [splitRow]);

      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: null, amount: 500000, memo: "gross pay" },
          { categoryId: 6, amount: -100000, memo: "taxes" },
        ],
      });

      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({ categoryId: null, amount: 500000 });
      expect(subInserts[1]?.values).toMatchObject({ categoryId: 6, amount: -100000 });
    });

    it("rejects an invalid frequency on update with 422", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      await expect(
        updateRecurring(mock.db, 1, {
          frequency: "invalid_frequency",
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 422,
      });
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

    it("BUG-19: does not overwrite categoryId or delete subTransactions when keys have undefined values", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [existingRow]);
      await updateRecurring(mock.db, 1, {
        accountId: undefined,
        categoryId: undefined,
        payee: undefined,
        memo: undefined,
        amount: undefined,
        frequency: undefined,
        nextDate: undefined,
        anchorDay: undefined,
        active: undefined,
        flagColor: "red",
        transferAccountId: undefined,
        subTransactions: undefined,
      });
      const updateCall = mock.calls.find((c) => c.op === "update");
      const set = updateCall?.set as Record<string, unknown>;
      expect(set).toEqual({ flagColor: "red" });
      const deleteCalls = mock.calls.filter((c) => c.op === "delete");
      expect(deleteCalls).toHaveLength(0);
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

    it("rejects a split child transferring to the recurring source account on update", async () => {
      const splitRow = { ...existingRow, amount: -20000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);

      await expect(
        updateRecurring(mock.db, 1, {
          subTransactions: [
            { categoryId: 5, amount: -12000 },
            { transferAccountId: 1, amount: -8000 },
          ],
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "transfer account must differ from source account",
      });
    });

    it("updates a recurring split with a boundary-crossing transfer child preserving categoryId (BUG-02)", async () => {
      const splitRow = { ...existingRow, amount: 350000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [splitRow]);

      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: null, amount: 400000 },
          { categoryId: 15, transferAccountId: 2, amount: -50000 },
        ],
      });

      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
      expect(subInserts[0]?.values).toMatchObject({
        categoryId: null,
        transferAccountId: null,
        amount: 400000,
      });
      expect(subInserts[1]?.values).toMatchObject({
        categoryId: 15,
        transferAccountId: 2,
        amount: -50000,
      });
    });

    it("rejects updating a recurring split with a boundary transfer outflow child missing a category with 422 (BUG-02)", async () => {
      const splitRow = { ...existingRow, amount: 350000, categoryId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);

      await expect(
        updateRecurring(mock.db, 1, {
          subTransactions: [
            { categoryId: null, amount: 400000 },
            { categoryId: null, transferAccountId: 2, amount: -50000 },
          ],
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Boundary transfer outflow requires a category",
        status: 422,
      });
    });

    it("BUG-41: rejects updating recurring with empty sub-transactions array []", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      await expect(
        updateRecurring(mock.db, 1, { subTransactions: [] })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "split must have at least two sub-transactions",
      });
    });

    it("setting transferAccountId deletes existing children and nulls categoryId", async () => {
      const splitRow = { ...existingRow, amount: -20000, categoryId: null, transferAccountId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("select:recurring", [{ ...splitRow, transferAccountId: 2 }]);

      await updateRecurring(mock.db, 1, { transferAccountId: 2 });
      const updateCall = mock.calls.find((c) => c.op === "update" && c.table === "recurring");
      expect(updateCall?.set).toEqual({ transferAccountId: 2, categoryId: null });
      const calls = mock.calls.map((c) => `${c.op}:${c.table ?? "?"}`);
      expect(calls).toContain("delete:recurring_sub_transactions");
    });

    it("installing subTransactions nulls transferAccountId and categoryId", async () => {
      const transferRow = { ...existingRow, amount: -20000, transferAccountId: 2, categoryId: null };
      mock.respondWith("select:recurring", [transferRow]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("delete:recurring_sub_transactions", []);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 1 }]);
      mock.respondWith("insert:recurring_sub_transactions", [{ id: 2 }]);
      mock.respondWith("select:recurring", [{ ...transferRow, transferAccountId: null }]);

      await updateRecurring(mock.db, 1, {
        subTransactions: [
          { categoryId: 5, amount: -12000 },
          { categoryId: 6, amount: -8000 },
        ],
      });
      const updateCall = mock.calls.find((c) => c.op === "update" && c.table === "recurring");
      expect(updateCall?.set).toEqual({ transferAccountId: null, categoryId: null });
      const calls = mock.calls.map((c) => `${c.op}:${c.table ?? "?"}`);
      expect(calls).toContain("delete:recurring_sub_transactions");
      const subInserts = mock.calls.filter(
        (c) => c.op === "insert" && c.table === "recurring_sub_transactions"
      );
      expect(subInserts).toHaveLength(2);
    });

    it("rejects setting transferAccountId equal to source account on update", async () => {
      mock.respondWith("select:recurring", [existingRow]);
      await expect(
        updateRecurring(mock.db, 1, { transferAccountId: 1 })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "transfer account must differ from source account",
      });
    });

    it("validates existing children sum when amount is updated on a split", async () => {
      const splitRow = { ...existingRow, amount: -20000, categoryId: null, transferAccountId: null };
      mock.respondWith("select:recurring", [splitRow]);
      mock.respondWith("select:recurring_sub_transactions", [
        { id: 1, recurringId: 1, categoryId: 5, amount: -12000, memo: "", sort: 0, transferAccountId: null },
        { id: 2, recurringId: 1, categoryId: 6, amount: -8000, memo: "", sort: 1, transferAccountId: null },
      ]);

      await expect(
        updateRecurring(mock.db, 1, { amount: -25000 })
      ).rejects.toMatchObject({
        name: "RecurringError",
      });
    });

    it("updateRecurring: preserves and updates categoryId for boundary transfer (BUG-01)", async () => {
      const boundaryTransferRow = {
        ...existingRow,
        accountId: 1,
        categoryId: 5,
        transferAccountId: 2,
        amount: -50000,
      };
      mock.respondWith("select:recurring", [boundaryTransferRow]);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("update:recurring", [{ id: 1 }]);
      mock.respondWith("select:recurring", [{ ...boundaryTransferRow, categoryId: 6 }]);

      await updateRecurring(mock.db, 1, { categoryId: 6 });
      const updateCall = mock.calls.find((c) => c.op === "update" && c.table === "recurring");
      expect(updateCall?.set).toMatchObject({ categoryId: 6 });
    });

    it("updateRecurring: rejects boundary transfer outflow when category is cleared (BUG-01)", async () => {
      const boundaryTransferRow = {
        ...existingRow,
        accountId: 1,
        categoryId: 5,
        transferAccountId: 2,
        amount: -50000,
      };
      mock.respondWith("select:recurring", [boundaryTransferRow]);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);

      await expect(
        updateRecurring(mock.db, 1, { categoryId: null })
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Boundary transfer outflow requires a category",
        status: 422,
      });
    });

    it("returns null when the row does not exist", async () => {
      mock.respondWith("select:recurring", []);
      const out = await updateRecurring(mock.db, 99, { payee: "X" });
      expect(out).toBeNull();
    });
  });

  describe("deleteRecurring", () => {
    it("issues a delete on the recurring table and returns true when deleted", async () => {
      mock.respondWith("delete:recurring", [{ id: 5 }]);
      const res = await deleteRecurring(mock.db, 5);
      expect(res).toBe(true);
      const deleteCall = mock.calls.find((c) => c.op === "delete");
      expect(deleteCall?.table).toBe("recurring");
    });

    it("returns false when recurring row does not exist", async () => {
      mock.respondWith("delete:recurring", []);
      const res = await deleteRecurring(mock.db, 999);
      expect(res).toBe(false);
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

    it("posts recurring paycheck split with an income leg (categoryId: null) setting isIncome: true", async () => {
      const splitRecurring = {
        id: 11,
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
        { id: 111, recurringId: 11, categoryId: null, amount: 500000, memo: "Gross", sort: 0, transferAccountId: null },
        { id: 112, recurringId: 11, categoryId: 11, amount: -100000, memo: "Tax", sort: 1, transferAccountId: null },
      ]);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 110, date: "2026-07-01", amount: 400000 }]);
      mock.respondWith("insert:transactions", [{ id: 111, amount: 500000, isIncome: true }]);
      mock.respondWith("insert:transactions", [{ id: 112, amount: -100000, isIncome: false }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...splitRecurring, nextDate: "2026-08-01" }]);

      const res = await postRecurringTransaction(mock.db, 11);
      expect(res.nextDate).toBe("2026-08-01");
      const subTxInserts = mock.calls.filter((c) => c.op === "insert" && c.table === "transactions").slice(1);
      expect(subTxInserts).toHaveLength(2);
      expect(subTxInserts[0]?.values).toMatchObject({
        amount: 500000,
        categoryId: null,
        isIncome: true,
      });
      expect(subTxInserts[1]?.values).toMatchObject({
        amount: -100000,
        categoryId: 11,
        isIncome: false,
      });
    });

    it("materializes a recurring split containing an off-budget transfer child with category (BUG-02)", async () => {
      const splitRecurring = {
        id: 12,
        accountId: 1,
        categoryId: null,
        payee: "Employer Inc",
        amount: 350000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [splitRecurring]);
      mock.respondWith("select:recurring_sub_transactions", [
        { id: 121, recurringId: 12, categoryId: null, amount: 400000, memo: "Gross", sort: 0, transferAccountId: null },
        { id: 122, recurringId: 12, categoryId: 15, amount: -50000, memo: "RRSP deduction", sort: 1, transferAccountId: 2 },
      ]);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ name: "RRSP Off-Budget" }]);
      mock.respondWithNth("select:accounts", 3, [{ onBudget: false }]);
      mock.respondWith("insert:transactions", [{ id: 120, date: "2026-07-01", amount: 350000 }]);
      mock.respondWith("insert:transactions", [{ id: 121, amount: 400000, isIncome: true }]);
      mock.respondWith("insert:transactions", [{ id: 122, amount: -50000, isIncome: false, categoryId: 15, transferAccountId: 2 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...splitRecurring, nextDate: "2026-08-01" }]);

      const res = await postRecurringTransaction(mock.db, 12);
      expect(res.nextDate).toBe("2026-08-01");
      const subTxInserts = mock.calls.filter((c) => c.op === "insert" && c.table === "transactions").slice(1);
      expect(subTxInserts).toHaveLength(2);
      expect(subTxInserts[1]?.values).toMatchObject({
        amount: -50000,
        categoryId: 15,
        transferAccountId: 2,
        payee: "Transfer : RRSP Off-Budget",
        isIncome: false,
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

    it("posts as a transfer when transferAccountId is set even if children exist (flavour alignment)", async () => {
      const transferWithStaleChildren = {
        id: 40,
        accountId: 1,
        categoryId: null,
        payee: "Transfer: Savings",
        amount: -50000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: 2,
      };
      mock.respondWithNth("select:recurring", 1, [transferWithStaleChildren]);
      // Stale children in DB
      mock.respondWith("select:recurring_sub_transactions", [
        { id: 101, recurringId: 40, categoryId: 10, amount: -30000, memo: "Old split 1", sort: 0, transferAccountId: null },
        { id: 102, recurringId: 40, categoryId: 11, amount: -20000, memo: "Old split 2", sort: 1, transferAccountId: null },
      ]);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 400, date: "2026-07-01", amount: -50000, transferAccountId: 2 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...transferWithStaleChildren, nextDate: "2026-08-01" }]);

      await postRecurringTransaction(mock.db, 40);

      // Should have called createTransaction (insert single transaction with transferAccountId: 2)
      // and NOT createSplitWithChildren (which would insert children transactions)
      const txnInserts = mock.calls.filter((c) => c.op === "insert" && c.table === "transactions");
      expect(txnInserts).toHaveLength(1);
      expect(txnInserts[0]?.values).toMatchObject({
        accountId: 1,
        amount: -50000,
        transferAccountId: 2,
      });
    });

    it("posts recurring transfer to off-budget account with category without crashing (BUG-01)", async () => {
      const boundaryRecurring = {
        id: 50,
        accountId: 1,
        categoryId: 7,
        payee: "Wealthsimple TFSA",
        amount: -50000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: 2,
      };
      mock.respondWithNth("select:recurring", 1, [boundaryRecurring]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWithNth("select:accounts", 1, [{ onBudget: true }]);
      mock.respondWithNth("select:accounts", 2, [{ onBudget: false }]);
      mock.respondWith("insert:transactions", [{ id: 500, date: "2026-07-01", amount: -50000, categoryId: 7, transferAccountId: 2 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...boundaryRecurring, nextDate: "2026-08-01" }]);

      const res = await postRecurringTransaction(mock.db, 50);
      expect(res.nextDate).toBe("2026-08-01");

      const txnInserts = mock.calls.filter((c) => c.op === "insert" && c.table === "transactions");
      expect(txnInserts).toHaveLength(1);
      expect(txnInserts[0]?.values).toMatchObject({
        accountId: 1,
        categoryId: 7,
        amount: -50000,
        transferAccountId: 2,
      });
    });

    it("prevents monthly schedule drift across February when posting recurring transactions (BUG-06)", async () => {
      const janRow = {
        id: 60,
        accountId: 1,
        categoryId: 2,
        payee: "Month End Bill",
        amount: -10000,
        frequency: "monthly",
        nextDate: "2026-01-31",
        anchorDay: 31,
        active: true,
        transferAccountId: null,
      };
      const febRow = { ...janRow, nextDate: "2026-02-28" };
      const marRow = { ...janRow, nextDate: "2026-03-31" };

      // 1. Post Jan 31 -> advances to Feb 28
      mock.respondWithNth("select:recurring", 1, [janRow]);
      mock.respondWithNth("select:recurring", 2, [febRow]);
      mock.respondWithNth("select:recurring", 3, [marRow]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 601, date: "2026-01-31", amount: -10000 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{}]);

      const res1 = await postRecurringTransaction(mock.db, 60);
      expect(res1.nextDate).toBe("2026-02-28");

      // 2. Post Feb 28 -> advances to Mar 31 (NOT Mar 28!)
      const res2 = await postRecurringTransaction(mock.db, 60);
      expect(res2.nextDate).toBe("2026-03-31");

      // 3. Post Mar 31 -> advances to Apr 30 (NOT Apr 28!)
      const res3 = await postRecurringTransaction(mock.db, 60);
      expect(res3.nextDate).toBe("2026-04-30");
    });

    it("prevents semimonthly schedule drift across February (BUG-06)", async () => {
      // Starting from 2026-01-28 (anchorDay: 28)
      const r28 = {
        id: 61,
        accountId: 1,
        categoryId: 2,
        payee: "Bi-monthly Pay",
        amount: 200000,
        frequency: "semimonthly",
        nextDate: "2026-01-28",
        anchorDay: 28,
        active: true,
        transferAccountId: null,
      };
      const rFeb13 = { ...r28, nextDate: "2026-02-13" };
      const rFeb28 = { ...r28, nextDate: "2026-02-28" };
      const rMar13 = { ...r28, nextDate: "2026-03-13" };

      mock.respondWithNth("select:recurring", 1, [r28]);
      mock.respondWithNth("select:recurring", 2, [rFeb13]);
      mock.respondWithNth("select:recurring", 3, [rFeb28]);
      mock.respondWithNth("select:recurring", 4, [rMar13]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 611, date: "2026-01-28", amount: 200000 }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{}]);

      // 1. Post Jan 28 -> advances to Feb 13
      const res1 = await postRecurringTransaction(mock.db, 61);
      expect(res1.nextDate).toBe("2026-02-13");

      // 2. Post Feb 13 -> advances to Feb 28
      const res2 = await postRecurringTransaction(mock.db, 61);
      expect(res2.nextDate).toBe("2026-02-28");

      // 3. Post Feb 28 -> advances to Mar 13 (NOT 28 - 15 = 13, and anchor 28 preserved!)
      const res3 = await postRecurringTransaction(mock.db, 61);
      expect(res3.nextDate).toBe("2026-03-13");

      // 4. Post Mar 13 -> advances to Mar 28
      const res4 = await postRecurringTransaction(mock.db, 61);
      expect(res4.nextDate).toBe("2026-03-28");
    });

    it("rejects posting an inactive recurring transaction with 400 (BUG-04)", async () => {
      const inactiveRow = {
        id: 70,
        accountId: 1,
        categoryId: 2,
        payee: "Old Subscription",
        amount: -1000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: false,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [inactiveRow]);

      await expect(
        postRecurringTransaction(mock.db, 70)
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Recurring transaction is inactive",
        status: 400,
      });
    });

    it("rejects with 409 conflict when CAS update matches 0 rows (BUG-04)", async () => {
      const activeRow = {
        id: 71,
        accountId: 1,
        categoryId: 2,
        payee: "Gym Membership",
        amount: -5000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [activeRow]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 701, date: "2026-07-01", amount: -5000 }]);
      mock.respondWith("update:accounts", [{}]);
      // Return empty array to simulate CAS failure (0 rows updated)
      mock.respondWith("update:recurring", []);

      await expect(
        postRecurringTransaction(mock.db, 71)
      ).rejects.toMatchObject({
        name: "RecurringError",
        message: "Recurring transaction schedule mismatch or inactive",
        status: 409,
      });
    });

    it("rejects postRecurringTransaction and autoPostDueRecurringTransactions with invalid calendar dates (BUG-19)", async () => {
      await expect(
        postRecurringTransaction(mock.db, 1, "2026-02-31")
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 400,
      });

      await expect(
        autoPostDueRecurringTransactions(mock.db, "2026-04-31")
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 400,
      });
    });

    it("rejects createRecurring and updateRecurring with invalid calendar dates (BUG-19)", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: 2,
          amount: -5000,
          frequency: "monthly",
          nextDate: "2026-02-31",
          payee: "Test",
        })
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 400,
      });

      mock.respondWith("select:recurring", [{ id: 1, accountId: 1, amount: -5000 }]);
      await expect(
        updateRecurring(mock.db, 1, { nextDate: "2026-02-29" })
      ).rejects.toMatchObject({
        name: "RecurringError",
        status: 400,
      });
    });

    it("BUG-40: rejects createRecurring and updateRecurring with amount 0", async () => {
      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          categoryId: 2,
          amount: 0,
          frequency: "monthly",
          nextDate: "2026-06-15",
          payee: "Test",
        })
      ).rejects.toThrow(/Amount cannot be zero/);

      await expect(
        createRecurring(mock.db, {
          accountId: 1,
          amount: -5000,
          frequency: "monthly",
          nextDate: "2026-06-15",
          payee: "Split",
          subTransactions: [
            { categoryId: 2, amount: -5000 },
            { categoryId: 3, amount: 0 },
          ],
        })
      ).rejects.toThrow(/Amount cannot be zero/);

      mock.respondWith("select:recurring", [{ id: 1, accountId: 1, amount: -5000 }]);
      await expect(
        updateRecurring(mock.db, 1, { amount: 0 })
      ).rejects.toThrow(/Amount cannot be zero/);
    });

    it("BUG-08: does not stamp 'Recurring' when memo is blank and preserves non-empty rule memo", async () => {
      // 1. Regular transaction with empty memo
      const blankRecurring = {
        id: 80,
        accountId: 1,
        categoryId: 2,
        payee: "Landlord",
        memo: "",
        amount: -100000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [blankRecurring]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 801, memo: "" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...blankRecurring, nextDate: "2026-08-01" }]);

      await postRecurringTransaction(mock.db, 80);
      const blankInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(blankInsert?.values).toMatchObject({
        memo: "",
      });

      // 2. Regular transaction with non-empty memo
      mock.reset();
      const namedRecurring = {
        id: 81,
        accountId: 1,
        categoryId: 2,
        payee: "Landlord",
        memo: "Monthly rent",
        amount: -100000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        active: true,
        transferAccountId: null,
      };
      mock.respondWithNth("select:recurring", 1, [namedRecurring]);
      mock.respondWith("select:recurring_sub_transactions", []);
      mock.respondWith("select:accounts", [{ onBudget: true }]);
      mock.respondWith("insert:transactions", [{ id: 811, memo: "Monthly rent" }]);
      mock.respondWith("update:accounts", [{}]);
      mock.respondWith("update:recurring", [{ ...namedRecurring, nextDate: "2026-08-01" }]);

      await postRecurringTransaction(mock.db, 81);
      const namedInsert = mock.calls.find((c) => c.op === "insert" && c.table === "transactions");
      expect(namedInsert?.values).toMatchObject({
        memo: "Monthly rent",
      });
    });
  });
});


