import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  AccountPatchSchema,
  AssignmentUpsertSchema,
  CategoryCreateSchema,
  CategoryGroupCreateSchema,
  CategoryGroupPatchSchema,
  CategoryPatchSchema,
  ReconcileAccountSchema,
  RecurringCreateSchema,
  RecurringPatchSchema,
  TransactionBulkDeleteSchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
  UnreconcileAccountSchema,
} from "../src/app/api/schemas";

describe("API Runtime Schemas (UNI-21 / F-15 / BUG-26)", () => {
  describe("TransactionCreateSchema", () => {
    it("accepts valid transaction payload", () => {
      const payload = {
        accountId: 1,
        categoryId: 10,
        date: "2026-06-15",
        payee: "Grocery Store",
        amount: -4500,
        status: "c",
        memo: "Dinner ingredients",
      };
      const result = TransactionCreateSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects invalid date format", () => {
      const payload = {
        accountId: 1,
        date: "06/15/2026",
        amount: -4500,
      };
      const result = TransactionCreateSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("accepts valid subTransactions", () => {
      const payload = {
        accountId: 1,
        date: "2026-06-15",
        amount: -5000,
        subTransactions: [
          { categoryId: 10, amount: -3000, memo: "Food" },
          { categoryId: 11, amount: -2000, memo: "Household" },
        ],
      };
      const result = TransactionCreateSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("strips parentId and skipBalance from output", () => {
      const payload = {
        accountId: 1,
        date: "2026-06-15",
        amount: -5000,
        parentId: 42,
        skipBalance: true,
      };
      const result = TransactionCreateSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect("parentId" in result.data).toBe(false);
        expect("skipBalance" in result.data).toBe(false);
      }
    });
  });

  describe("TransactionPatchSchema", () => {
    it("accepts partial updates with valid id", () => {
      const payload = { id: 100, payee: "Updated Payee", amount: -2500 };
      const result = TransactionPatchSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects non-positive id", () => {
      const payload = { id: 0, payee: "Test" };
      const result = TransactionPatchSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("Bulk Schemas", () => {
    it("validates bulk delete", () => {
      expect(TransactionBulkDeleteSchema.safeParse({ ids: [1, 2, 3] }).success).toBe(true);
      expect(TransactionBulkDeleteSchema.safeParse({ ids: [] }).success).toBe(false);
    });

    it("validates bulk update", () => {
      expect(
        TransactionBulkUpdateSchema.safeParse({ ids: [1, 2], patch: { status: "c" } }).success
      ).toBe(true);
      expect(TransactionBulkUpdateSchema.safeParse({ ids: [1], patch: {} }).success).toBe(true);
      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1, 2, 3],
          patch: {
            payee: "Target",
            date: "2026-09-01",
            memo: "Grocery run",
            amount: -5400,
            accountId: 2,
            categoryId: 5,
            flagColor: "blue",
            incomeMonth: "2026-10",
          },
        }).success
      ).toBe(true);
      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1],
          patch: { date: "invalid-date" },
        }).success
      ).toBe(false);
    });
  });

  describe("Account Schemas", () => {
    it("validates account create", () => {
      const valid = {
        name: "Checking",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 100000,
        onBudget: true,
      };
      expect(AccountCreateSchema.safeParse(valid).success).toBe(true);
      expect(AccountCreateSchema.safeParse({ ...valid, kind: "invalid_kind" }).success).toBe(false);

      // Rejects contradictory kind and onBudget
      expect(AccountCreateSchema.safeParse({ ...valid, kind: "offbudget", onBudget: true }).success).toBe(false);
      expect(AccountCreateSchema.safeParse({ ...valid, kind: "liquid", onBudget: false }).success).toBe(false);
      expect(AccountCreateSchema.safeParse({ ...valid, kind: "credit", onBudget: false }).success).toBe(false);

      // Defaults onBudget for offbudget
      const offbudgetResult = AccountCreateSchema.safeParse({
        name: "Investment",
        kind: "offbudget",
        groupLabel: "Off Budget",
      });
      expect(offbudgetResult.success).toBe(true);
      if (offbudgetResult.success) {
        expect(offbudgetResult.data.onBudget).toBe(false);
      }
    });

    it("validates account patch", () => {
      expect(AccountPatchSchema.safeParse({ id: 1, name: "New Name" }).success).toBe(true);
      expect(AccountPatchSchema.safeParse({ name: "No ID" }).success).toBe(false);

      // Rejects contradictory kind and onBudget in patch
      expect(
        AccountPatchSchema.safeParse({ id: 1, kind: "offbudget", onBudget: true }).success
      ).toBe(false);
      expect(
        AccountPatchSchema.safeParse({ id: 1, kind: "liquid", onBudget: false }).success
      ).toBe(false);
      expect(
        AccountPatchSchema.safeParse({ id: 1, kind: "offbudget", onBudget: false }).success
      ).toBe(true);
    });
  });

  describe("Category Schemas", () => {
    it("validates category create and group create", () => {
      expect(
        CategoryCreateSchema.safeParse({ groupId: 1, name: "Groceries", carryover: 0 }).success
      ).toBe(true);
      expect(CategoryGroupCreateSchema.safeParse({ type: "group", name: "Living" }).success).toBe(
        true
      );
    });

    it("validates category patch", () => {
      expect(
        CategoryPatchSchema.safeParse({ id: 5, name: "Updated", overspendCarriesOver: true }).success
      ).toBe(true);
      expect(
        CategoryPatchSchema.safeParse({ id: 5, carryover: 0 }).success
      ).toBe(true);
      expect(
        CategoryPatchSchema.safeParse({ id: 5, carryover: 5000 }).success
      ).toBe(true);
      expect(
        CategoryPatchSchema.safeParse({ id: 5, carryover: -5000 }).success
      ).toBe(true);
      expect(
        CategoryPatchSchema.safeParse({ id: 5, carryover: null }).success
      ).toBe(true);
    });

    it("validates category group patch requires at least one field", () => {
      expect(
        CategoryGroupPatchSchema.safeParse({ id: 1, type: "group", name: "Renamed Group" }).success
      ).toBe(true);
      expect(
        CategoryGroupPatchSchema.safeParse({ id: 1, type: "group", sort: 3 }).success
      ).toBe(true);
      expect(
        CategoryGroupPatchSchema.safeParse({ id: 1, type: "group", name: "Renamed Group", sort: 3 }).success
      ).toBe(true);

      // Rejects patch when neither name nor sort is provided (BUG-5.2)
      const noFieldsResult = CategoryGroupPatchSchema.safeParse({ id: 1, type: "group" });
      expect(noFieldsResult.success).toBe(false);

      // Rejects patch when name is empty string
      const emptyNameResult = CategoryGroupPatchSchema.safeParse({ id: 1, type: "group", name: "" });
      expect(emptyNameResult.success).toBe(false);
    });
  });

  describe("Assignment & Reconcile Schemas", () => {
    it("validates assignment upsert", () => {
      expect(
        AssignmentUpsertSchema.safeParse({ categoryId: 10, month: "2026-06", amount: 15000 }).success
      ).toBe(true);
      expect(
        AssignmentUpsertSchema.safeParse({ categoryId: 10, month: "June 2026", amount: 15000 }).success
      ).toBe(false);
    });

    it("validates reconcile and unreconcile schemas", () => {
      expect(
        ReconcileAccountSchema.safeParse({ accountId: 1, statementBalance: 50000 }).success
      ).toBe(true);
      expect(UnreconcileAccountSchema.safeParse({ action: "unreconcile", accountId: 1 }).success).toBe(
        true
      );
    });
  });

  describe("Recurring Schemas", () => {
    it("validates recurring create and patch", () => {
      const rec = {
        accountId: 1,
        categoryId: 10,
        payee: "Landlord",
        amount: -150000,
        frequency: "monthly",
        nextDate: "2026-07-01",
      };
      expect(RecurringCreateSchema.safeParse(rec).success).toBe(true);
      expect(RecurringPatchSchema.safeParse({ id: 1, active: false }).success).toBe(true);
    });
  });

  describe("BUG-19: Calendar date and month rejection", () => {
    it("rejects invalid calendar dates in TransactionCreateSchema, Patch, and BulkUpdate", () => {
      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-02-31",
          amount: -1000,
        }).success
      ).toBe(false);

      expect(
        TransactionPatchSchema.safeParse({
          id: 1,
          date: "2026-04-31",
        }).success
      ).toBe(false);

      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1],
          patch: { date: "2026-02-29" },
        }).success
      ).toBe(false);

      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: 1000,
          incomeMonth: "2026-13",
        }).success
      ).toBe(false);
    });

    it("rejects invalid months in AssignmentUpsertSchema", () => {
      expect(
        AssignmentUpsertSchema.safeParse({
          categoryId: 1,
          month: "2026-13",
          amount: 5000,
        }).success
      ).toBe(false);

      expect(
        AssignmentUpsertSchema.safeParse({
          categoryId: 1,
          month: "2026-00",
          amount: 5000,
        }).success
      ).toBe(false);
    });

    it("rejects invalid dates in Recurring schemas", () => {
      expect(
        RecurringCreateSchema.safeParse({
          accountId: 1,
          amount: -5000,
          frequency: "monthly",
          nextDate: "2026-02-31",
        }).success
      ).toBe(false);

      expect(
        RecurringPatchSchema.safeParse({
          id: 1,
          nextDate: "2026-02-31",
        }).success
      ).toBe(false);
    });

    it("rejects invalid dates in ReconcileAccountSchema", () => {
      expect(
        ReconcileAccountSchema.safeParse({
          accountId: 1,
          statementBalance: 10000,
          statementDate: "2026-02-31",
        }).success
      ).toBe(false);
    });
  });

  describe("BUG-40: Nonzero amount rejection in transaction and recurring schemas", () => {
    it("rejects amount 0 in TransactionCreateSchema, Patch, and BulkUpdate", () => {
      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: 0,
        }).success
      ).toBe(false);

      expect(
        TransactionPatchSchema.safeParse({
          id: 1,
          amount: 0,
        }).success
      ).toBe(false);

      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1],
          patch: { amount: 0 },
        }).success
      ).toBe(false);

      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: -5000,
          subTransactions: [
            { categoryId: 1, amount: -5000 },
            { categoryId: 2, amount: 0 },
          ],
        }).success
      ).toBe(false);
    });

    it("rejects amount 0 in RecurringCreateSchema and RecurringPatchSchema", () => {
      expect(
        RecurringCreateSchema.safeParse({
          accountId: 1,
          frequency: "monthly",
          nextDate: "2026-06-15",
          amount: 0,
        }).success
      ).toBe(false);

      expect(
        RecurringPatchSchema.safeParse({
          id: 1,
          amount: 0,
        }).success
      ).toBe(false);
    });

    it("allows balance 0 for accounts and amount 0 for assignments and category carryover", () => {
      expect(
        AccountCreateSchema.safeParse({
          name: "New Account",
          kind: "liquid",
          groupLabel: "Budget Accounts",
          balance: 0,
        }).success
      ).toBe(true);

      expect(
        AssignmentUpsertSchema.safeParse({
          categoryId: 1,
          month: "2026-06",
          amount: 0,
        }).success
      ).toBe(true);

      expect(
        CategoryCreateSchema.safeParse({
          groupId: 1,
          name: "Groceries",
          carryover: 0,
          goalTarget: 0,
        }).success
      ).toBe(true);
    });
  });

  describe("BUG-26: Reconciled status 'r' rejection in transaction schemas", () => {
    it("rejects status 'r' in TransactionCreateSchema, TransactionPatchSchema, and TransactionBulkUpdateSchema", () => {
      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: -1000,
          status: "r",
        }).success
      ).toBe(false);

      expect(
        TransactionPatchSchema.safeParse({
          id: 1,
          status: "r",
        }).success
      ).toBe(false);

      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1],
          patch: { status: "r" },
        }).success
      ).toBe(false);
    });

    it("accepts status 'u' and 'c' in TransactionCreateSchema, TransactionPatchSchema, and TransactionBulkUpdateSchema", () => {
      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: -1000,
          status: "u",
        }).success
      ).toBe(true);

      expect(
        TransactionCreateSchema.safeParse({
          accountId: 1,
          date: "2026-06-15",
          amount: -1000,
          status: "c",
        }).success
      ).toBe(true);

      expect(
        TransactionPatchSchema.safeParse({
          id: 1,
          status: "u",
        }).success
      ).toBe(true);

      expect(
        TransactionPatchSchema.safeParse({
          id: 1,
          status: "c",
        }).success
      ).toBe(true);

      expect(
        TransactionBulkUpdateSchema.safeParse({
          action: "bulk-update",
          ids: [1],
          patch: { status: "u" },
        }).success
      ).toBe(true);

      expect(
        TransactionBulkUpdateSchema.safeParse({
          ids: [1],
          patch: { status: "c" },
        }).success
      ).toBe(true);
    });
  });
});
