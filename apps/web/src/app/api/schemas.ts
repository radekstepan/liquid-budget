import { z } from "zod";

export const SubTransactionSchema = z.object({
  categoryId: z.number().int().positive().nullable().optional(),
  transferAccountId: z.number().int().positive().nullable().optional(),
  amount: z.number().int(),
  memo: z.string().max(1000).optional(),
});

export const TransactionCreateSchema = z.object({
  accountId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  transferAccountId: z.number().int().positive().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payee: z.string().max(255).optional().default(""),
  memo: z.string().max(1000).optional().default(""),
  amount: z.number().int(),
  status: z.enum(["u", "c", "r"]).optional().default("c"),
  incomeMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  subTransactions: z.array(SubTransactionSchema).optional(),
  skipBalance: z.boolean().optional(),
  parentId: z.number().int().nullable().optional(),
});

export const TransactionPatchSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payee: z.string().max(255).optional(),
  memo: z.string().max(1000).nullable().optional(),
  amount: z.number().int().optional(),
  status: z.enum(["u", "c", "r"]).optional(),
  incomeMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  subTransactions: z.array(SubTransactionSchema).optional(),
});

export const TransactionBulkDeleteSchema = z.object({
  action: z.literal("delete").optional(),
  ids: z.array(z.number().int().positive()).min(1),
});

export const TransactionBulkUpdateSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  patch: z.object({
    status: z.enum(["u", "c", "r"]).optional(),
    categoryId: z.number().int().positive().nullable().optional(),
  }),
});

export const AccountCreateSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["liquid", "credit", "offbudget"]),
  groupLabel: z.string().min(1).max(255),
  balance: z.number().int().optional().default(0),
  onBudget: z.boolean().optional().default(true),
  archived: z.boolean().optional().default(false),
});

export const AccountPatchSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255).optional(),
  kind: z.enum(["liquid", "credit", "offbudget"]).optional(),
  groupLabel: z.string().min(1).max(255).optional(),
  onBudget: z.boolean().optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});

export const CategoryGroupCreateSchema = z.object({
  type: z.literal("group"),
  name: z.string().min(1).max(255),
});

export const CategoryCreateSchema = z.object({
  type: z.literal("category").optional(),
  groupId: z.number().int().positive(),
  name: z.string().min(1).max(255),
  goalTarget: z.number().int().nonnegative().nullable().optional(),
  carryover: z.number().int().optional().default(0),
  overspendCarriesOver: z.boolean().optional().default(false),
});

export const CategoryGroupPatchSchema = z.object({
  id: z.number().int().positive(),
  type: z.literal("group"),
  name: z.string().min(1).max(255).optional(),
  sort: z.number().int().optional(),
});

export const CategoryPatchSchema = z.object({
  id: z.number().int().positive(),
  type: z.undefined().optional(),
  name: z.string().min(1).max(255).optional(),
  goalTarget: z.number().int().nonnegative().nullable().optional(),
  carryover: z.number().int().optional(),
  sort: z.number().int().optional(),
  overspendCarriesOver: z.boolean().optional(),
});

export const AssignmentUpsertSchema = z.object({
  categoryId: z.number().int().positive(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().int(),
});

export const RecurringCreateSchema = z.object({
  accountId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  transferAccountId: z.number().int().positive().nullable().optional(),
  payee: z.string().max(255).optional().default(""),
  memo: z.string().max(1000).optional().default(""),
  amount: z.number().int(),
  frequency: z.string().min(1).max(50),
  nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  subTransactions: z.array(SubTransactionSchema).optional(),
});

export const RecurringPatchSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  transferAccountId: z.number().int().positive().nullable().optional(),
  payee: z.string().max(255).optional(),
  memo: z.string().max(1000).nullable().optional(),
  amount: z.number().int().optional(),
  frequency: z.string().min(1).max(50).optional(),
  nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  active: z.boolean().optional(),
  subTransactions: z.array(SubTransactionSchema).optional(),
});

export const ReconcileAccountSchema = z.object({
  action: z.literal("reconcile").optional().default("reconcile"),
  accountId: z.number().int().positive(),
  statementBalance: z.number().int(),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adjustmentCategoryId: z.number().int().positive().nullable().optional(),
});

export const UnreconcileAccountSchema = z.object({
  action: z.literal("unreconcile"),
  accountId: z.number().int().positive(),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
}
