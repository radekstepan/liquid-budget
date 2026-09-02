import { z } from "zod";
import { isValidISODate, isValidISOMonth } from "@ynab/logic";

export const ISODateSchema = z.string().refine(isValidISODate, {
  message: "Invalid calendar date (expected YYYY-MM-DD)",
});

export const ISOMonthSchema = z.string().refine(isValidISOMonth, {
  message: "Invalid month format (expected YYYY-MM)",
});

export const TransactionFlagSchema = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]);

export const SubTransactionSchema = z
  .object({
    id: z.number().int().positive().nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    transferStatus: z.enum(["u", "c"]).optional(),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }),
    memo: z.string().max(1000).optional(),
    payee: z.string().max(255).optional(),
  })
  .strict();

export const TransactionCreateSchema = z
  .object({
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    date: ISODateSchema,
    payee: z.string().max(255).optional().default(""),
    memo: z.string().max(1000).optional().default(""),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }),
    status: z.enum(["u", "c"]).optional().default("c"),
    transferStatus: z.enum(["u", "c"]).optional(),
    flagColor: TransactionFlagSchema.nullable().optional(),
    incomeMonth: ISOMonthSchema.nullable().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2).optional(),
  })
  .strict();

export const TransactionPatchSchema = z
  .object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    date: ISODateSchema.optional(),
    payee: z.string().max(255).optional(),
    memo: z.string().max(1000).nullable().optional(),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
    status: z.enum(["u", "c"]).optional(),
    transferStatus: z.enum(["u", "c"]).optional(),
    flagColor: TransactionFlagSchema.nullable().optional(),
    incomeMonth: ISOMonthSchema.nullable().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2).optional(),
  })
  .strict();

export const TransactionBulkDeleteSchema = z
  .object({
    action: z.literal("delete").optional(),
    ids: z.array(z.number().int().positive()).min(1),
  })
  .strict();

export const TransactionBulkUpdateSchema = z
  .object({
    action: z.literal("bulk-update").optional(),
    ids: z.array(z.number().int().positive()).min(1),
    patch: z
      .object({
        status: z.enum(["u", "c"]).optional(),
        transferStatus: z.enum(["u", "c"]).optional(),
        categoryId: z.number().int().positive().nullable().optional(),
        flagColor: TransactionFlagSchema.nullable().optional(),
        date: ISODateSchema.optional(),
        payee: z.string().max(255).optional(),
        memo: z.string().max(1000).nullable().optional(),
        amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
        accountId: z.number().int().positive().optional(),
        incomeMonth: ISOMonthSchema.nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const AccountCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    kind: z.enum(["liquid", "credit", "offbudget"]),
    groupLabel: z.string().min(1).max(255),
    balance: z.number().int().optional().default(0),
    onBudget: z.boolean().optional(),
    archived: z.boolean().optional().default(false),
  })
  .strict()
  .transform((data) => ({
    ...data,
    onBudget: data.onBudget !== undefined ? data.onBudget : data.kind !== "offbudget",
  }))
  .refine(
    (data) => {
      if (data.kind === "offbudget" && data.onBudget === true) return false;
      if (data.kind !== "offbudget" && data.onBudget === false) return false;
      return true;
    },
    {
      message: "kind and onBudget must be consistent (offbudget requires onBudget: false, liquid/credit requires onBudget: true)",
    }
  );

export const AccountPatchSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(255).optional(),
    kind: z.enum(["liquid", "credit", "offbudget"]).optional(),
    groupLabel: z.string().min(1).max(255).optional(),
    onBudget: z.boolean().optional(),
    sort: z.number().int().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.kind !== undefined && data.onBudget !== undefined) {
        if (data.kind === "offbudget" && data.onBudget === true) return false;
        if (data.kind !== "offbudget" && data.onBudget === false) return false;
      }
      return true;
    },
    {
      message: "kind and onBudget must be consistent (offbudget requires onBudget: false, liquid/credit requires onBudget: true)",
    }
  );

export const CategoryGroupCreateSchema = z
  .object({
    type: z.literal("group"),
    name: z.string().min(1).max(255),
    isHidden: z.boolean().optional().default(false),
  })
  .strict();

export const CategoryCreateSchema = z
  .object({
    type: z.literal("category").optional(),
    groupId: z.number().int().positive(),
    name: z.string().min(1).max(255),
    goalTarget: z.number().int().nonnegative().nullable().optional(),
    carryover: z.number().int().optional().default(0),
    overspendCarriesOver: z.boolean().optional().default(false),
  })
  .strict();

export const CategoryGroupPatchSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.literal("group"),
    name: z.string().min(1).max(255).optional(),
    sort: z.number().int().optional(),
    isHidden: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.sort !== undefined || data.isHidden !== undefined, {
    message: "At least one of name, sort, or isHidden must be provided",
  });

export const CategoryPatchSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.undefined().optional(),
    name: z.string().min(1).max(255).optional(),
    goalTarget: z.number().int().nonnegative().nullable().optional(),
    carryover: z.number().int().nullable().optional(),
    sort: z.number().int().optional(),
    overspendCarriesOver: z.boolean().optional(),
  })
  .strict();

export const AssignmentUpsertSchema = z
  .object({
    categoryId: z.number().int().positive(),
    month: ISOMonthSchema,
    amount: z.number().int(),
  })
  .strict();

export const RenameRuleCreateSchema = z
  .object({
    sourcePattern: z.string().min(1).max(255),
    targetPayee: z.string().min(1).max(255),
  })
  .strict();

export const RenameRulePatchSchema = z
  .object({
    id: z.number().int().positive(),
    sourcePattern: z.string().min(1).max(255).optional(),
    targetPayee: z.string().min(1).max(255).optional(),
  })
  .strict();

export const RecurringCreateSchema = z
  .object({
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    payee: z.string().max(255).optional().default(""),
    memo: z.string().max(1000).optional().default(""),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }),
    frequency: z.string().min(1).max(50),
    nextDate: ISODateSchema,
    anchorDay: z.number().int().min(1).max(31).nullable().optional(),
    flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2).optional(),
  })
  .strict();

export const RecurringPatchSchema = z
  .object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    payee: z.string().max(255).optional(),
    memo: z.string().max(1000).nullable().optional(),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
    frequency: z.string().min(1).max(50).optional(),
    nextDate: ISODateSchema.optional(),
    anchorDay: z.number().int().min(1).max(31).nullable().optional(),
    active: z.boolean().optional(),
    flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2).optional(),
  })
  .strict();

export const RecurringPostActionSchema = z
  .object({
    action: z.literal("post"),
    id: z.number().int().positive(),
    date: ISODateSchema.optional(),
  })
  .strict();

export const RecurringBulkPostActionSchema = z
  .object({
    action: z.literal("bulk-post"),
    ids: z.array(z.number().int().positive()).min(1),
    date: ISODateSchema.optional(),
  })
  .strict();

export const RecurringAutoPostActionSchema = z
  .object({
    action: z.literal("autopost"),
    asOfDate: ISODateSchema.optional(),
  })
  .strict();

export const RecurringBulkUpdateSchema = z
  .object({
    action: z.literal("bulk-update"),
    ids: z.array(z.number().int().positive()).min(1),
    patch: z
      .object({
        flagColor: TransactionFlagSchema.nullable().optional(),
        active: z.boolean().optional(),
        categoryId: z.number().int().positive().nullable().optional(),
        nextDate: ISODateSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const RecurringBulkDeleteSchema = z
  .object({
    action: z.literal("delete").optional(),
    ids: z.array(z.number().int().positive()).min(1),
  })
  .strict();

export const ReconcileAccountSchema = z
  .object({
    action: z.literal("reconcile").optional().default("reconcile"),
    accountId: z.number().int().positive(),
    statementBalance: z.number().int(),
    statementDate: ISODateSchema.optional(),
    adjustmentCategoryId: z.number().int().positive().nullable().optional(),
    expectedWorkingBalance: z.number().int().nullable().optional(),
  })
  .strict();

export const UnreconcileAccountSchema = z
  .object({
    action: z.literal("unreconcile"),
    accountId: z.number().int().positive(),
  })
  .strict();

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
}
