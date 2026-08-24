import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  AccountPatchSchema,
  AssignmentUpsertSchema,
  CategoryCreateSchema,
  CategoryGroupCreateSchema,
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
    });

    it("validates account patch", () => {
      expect(AccountPatchSchema.safeParse({ id: 1, name: "New Name" }).success).toBe(true);
      expect(AccountPatchSchema.safeParse({ name: "No ID" }).success).toBe(false);
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
});
