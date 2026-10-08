import { z } from "zod";
import { isValidISODate, isValidISOMonth } from "./format.js";
import type { Assignment, BudgetData } from "./types.js";
import type { ReconcileState } from "./reconcile.js";
import type { DuplicateAnalysisResult } from "./duplicates.js";

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

const BaseTransactionCreateFields = {
  accountId: z.number().int().positive(),
  date: ISODateSchema,
  payee: z.string().max(255).optional().default(""),
  memo: z.string().max(1000).optional().default(""),
  amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }),
  status: z.enum(["u", "c"]).optional().default("c"),
  flagColor: TransactionFlagSchema.nullable().optional(),
  incomeMonth: ISOMonthSchema.nullable().optional(),
  cleared: z.boolean().optional(),
};

export const SingleTransactionCreateSchema = z
  .object({
    mode: z.literal("single"),
    ...BaseTransactionCreateFields,
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.null().optional(),
    transferStatus: z.undefined().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict();

export const TransferTransactionCreateSchema = z
  .object({
    mode: z.literal("transfer"),
    ...BaseTransactionCreateFields,
    transferAccountId: z.number().int().positive(),
    transferStatus: z.enum(["u", "c"]).optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict()
  .refine((data) => data.accountId !== data.transferAccountId, {
    message: "Transfer account cannot be the same as the source account",
    path: ["transferAccountId"],
  });

export const SplitTransactionCreateSchema = z
  .object({
    mode: z.literal("split"),
    ...BaseTransactionCreateFields,
    categoryId: z.null().optional(),
    transferAccountId: z.null().optional(),
    transferStatus: z.undefined().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2),
  })
  .strict()
  .refine(
    (data) => {
      const sum = data.subTransactions.reduce((acc, c) => acc + c.amount, 0);
      return sum === data.amount;
    },
    {
      message: "Sub-transactions sum must equal total parent amount",
      path: ["subTransactions"],
    }
  );

export const TransactionInputSchema = z.discriminatedUnion("mode", [
  SingleTransactionCreateSchema,
  TransferTransactionCreateSchema,
  SplitTransactionCreateSchema,
]);

function inferTransactionMode(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = input as Record<string, unknown>;
  if ("mode" in obj && typeof obj.mode === "string") return input;

  if (Array.isArray(obj.subTransactions) && obj.subTransactions.length > 0) {
    return { ...obj, mode: "split" };
  }
  if (
    (obj.transferAccountId !== undefined && obj.transferAccountId !== null) ||
    obj.transferStatus !== undefined
  ) {
    return { ...obj, mode: "transfer" };
  }
  return { ...obj, mode: "single" };
}

export const TransactionCreateSchema = z
  .preprocess(inferTransactionMode, TransactionInputSchema)
  .transform((data) => {
    if (data.cleared !== undefined && data.status === undefined) {
      data.status = data.cleared ? "c" : "u";
    }
    return data;
  });

const BaseTransactionPatchFields = {
  id: z.number().int().positive(),
  accountId: z.number().int().positive().optional(),
  date: ISODateSchema.optional(),
  payee: z.string().max(255).optional(),
  memo: z.string().max(1000).nullable().optional(),
  amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
  status: z.enum(["u", "c"]).optional(),
  flagColor: TransactionFlagSchema.nullable().optional(),
  incomeMonth: ISOMonthSchema.nullable().optional(),
  cleared: z.boolean().optional(),
};

export const SingleTransactionPatchSchema = z
  .object({
    mode: z.literal("single"),
    ...BaseTransactionPatchFields,
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.null().optional(),
    transferStatus: z.undefined().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict();

export const TransferTransactionPatchSchema = z
  .object({
    mode: z.literal("transfer"),
    ...BaseTransactionPatchFields,
    transferAccountId: z.number().int().positive().optional(),
    transferStatus: z.enum(["u", "c"]).optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.accountId !== undefined && data.transferAccountId !== undefined) {
        return data.accountId !== data.transferAccountId;
      }
      return true;
    },
    {
      message: "Transfer account cannot be the same as the source account",
      path: ["transferAccountId"],
    }
  );

export const SplitTransactionPatchSchema = z
  .object({
    mode: z.literal("split"),
    ...BaseTransactionPatchFields,
    categoryId: z.null().optional(),
    transferAccountId: z.null().optional(),
    transferStatus: z.undefined().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2),
  })
  .strict()
  .refine(
    (data) => {
      if (data.amount !== undefined) {
        const sum = data.subTransactions.reduce((acc, c) => acc + c.amount, 0);
        return sum === data.amount;
      }
      return true;
    },
    {
      message: "Sub-transactions sum must equal total parent amount",
      path: ["subTransactions"],
    }
  );

export const TransactionPatchInputSchema = z.discriminatedUnion("mode", [
  SingleTransactionPatchSchema,
  TransferTransactionPatchSchema,
  SplitTransactionPatchSchema,
]);

export const TransactionPatchSchema = z
  .preprocess(inferTransactionMode, TransactionPatchInputSchema)
  .transform((data) => {
    if (data.cleared !== undefined && data.status === undefined) {
      data.status = data.cleared ? "c" : "u";
    }
    return data;
  });

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

export const TransactionMergePatchSchema = z
  .object({
    accountId: z.number().int().positive().optional(),
    transferAccountId: z.number().int().positive().nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    date: ISODateSchema.optional(),
    payee: z.string().max(255).optional(),
    memo: z.string().max(1000).nullable().optional(),
    amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
    status: z.enum(["u", "c"]).optional(),
    transferStatus: z.enum(["u", "c"]).nullable().optional(),
    flagColor: TransactionFlagSchema.nullable().optional(),
    incomeMonth: ISOMonthSchema.nullable().optional(),
  })
  .strict();

export const TransactionMergeSchema = z
  .object({
    action: z.literal("merge").optional(),
    ids: z.array(z.number().int().positive()).length(2),
    patch: TransactionMergePatchSchema.optional(),
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
    notes: z.string().max(2000).optional().default(""),
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
    notes: z.string().max(2000).optional(),
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
    groupId: z.number().int().positive().optional(),
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

const TRANSFER_PAYEE_RE = /^transfer\s*:/i;
const notTransferPayee = (val: string) => !TRANSFER_PAYEE_RE.test(val.trim());

export const RenameRuleCreateSchema = z
  .object({
    sourcePattern: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }),
    targetPayee: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }),
  })
  .strict();

export const RenameRulePatchSchema = z
  .object({
    id: z.number().int().positive(),
    sourcePattern: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }).optional(),
    targetPayee: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }).optional(),
  })
  .strict();

export const RenameRuleApplySchema = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

export const RenameSuggestionSchema = z
  .object({
    sourcePattern: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }),
    targetPayee: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Rename rules do not apply to transfers (payees like "Transfer : <account>")',
    }),
  })
  .strict();

export type RenameSuggestionInput = z.output<typeof RenameSuggestionSchema>;

/**
 * Accept AI-generated rename suggestions as rules. Each suggestion is
 * folded through the standard rule learner (so `BCF1` + `BCF2` still
 * generalise into `BCF[N]`); `applyToExisting` additionally rewrites
 * already-stored transactions, like applying a rule by hand.
 */
export const RenameSuggestAcceptSchema = z
  .object({
    suggestions: z.array(RenameSuggestionSchema).min(1).max(200),
    applyToExisting: z.boolean().optional().default(false),
  })
  .strict();

export type RenameSuggestAcceptInput = z.output<typeof RenameSuggestAcceptSchema>;

export const PayeePatchSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Payees like "Transfer : <account>" are managed by transfers, not the payee manager',
    }).optional(),
    autoCategoryId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const PayeeCreateSchema = z
  .object({
    name: z.string().min(1).max(255).refine(notTransferPayee, {
      message: 'Payees like "Transfer : <account>" are managed by transfers, not the payee manager',
    }),
    autoCategoryId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const PayeeMergeSchema = z
  .object({
    targetId: z.number().int().positive(),
    sourceIds: z.array(z.number().int().positive()).min(1).max(50),
  })
  .strict();

const BaseRecurringCreateFields = {
  accountId: z.number().int().positive(),
  payee: z.string().max(255).optional().default(""),
  memo: z.string().max(1000).optional().default(""),
  amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }),
  frequency: z.string().min(1).max(50),
  nextDate: ISODateSchema,
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  active: z.boolean().optional().default(true),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable().optional(),
};

export const SingleRecurringCreateSchema = z
  .object({
    mode: z.literal("single"),
    ...BaseRecurringCreateFields,
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.null().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict();

export const TransferRecurringCreateSchema = z
  .object({
    mode: z.literal("transfer"),
    ...BaseRecurringCreateFields,
    transferAccountId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict()
  .refine((data) => data.accountId !== data.transferAccountId, {
    message: "Transfer account cannot be the same as the source account",
    path: ["transferAccountId"],
  });

export const SplitRecurringCreateSchema = z
  .object({
    mode: z.literal("split"),
    ...BaseRecurringCreateFields,
    categoryId: z.null().optional(),
    transferAccountId: z.null().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2),
  })
  .strict()
  .refine(
    (data) => {
      const sum = data.subTransactions.reduce((acc, c) => acc + c.amount, 0);
      return sum === data.amount;
    },
    {
      message: "Sub-transactions sum must equal total parent amount",
      path: ["subTransactions"],
    }
  );

export const RecurringInputSchema = z.discriminatedUnion("mode", [
  SingleRecurringCreateSchema,
  TransferRecurringCreateSchema,
  SplitRecurringCreateSchema,
]);

export const RecurringCreateSchema = z.preprocess(inferTransactionMode, RecurringInputSchema);

const BaseRecurringPatchFields = {
  id: z.number().int().positive(),
  accountId: z.number().int().positive().optional(),
  payee: z.string().max(255).optional(),
  memo: z.string().max(1000).nullable().optional(),
  amount: z.number().int().refine((n) => n !== 0, { message: "Amount cannot be zero" }).optional(),
  frequency: z.string().min(1).max(50).optional(),
  nextDate: ISODateSchema.optional(),
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  active: z.boolean().optional(),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable().optional(),
};

export const SingleRecurringPatchSchema = z
  .object({
    mode: z.literal("single"),
    ...BaseRecurringPatchFields,
    categoryId: z.number().int().positive().nullable().optional(),
    transferAccountId: z.null().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict();

export const TransferRecurringPatchSchema = z
  .object({
    mode: z.literal("transfer"),
    ...BaseRecurringPatchFields,
    transferAccountId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    subTransactions: z.undefined().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.accountId !== undefined && data.transferAccountId !== undefined) {
        return data.accountId !== data.transferAccountId;
      }
      return true;
    },
    {
      message: "Transfer account cannot be the same as the source account",
      path: ["transferAccountId"],
    }
  );

export const SplitRecurringPatchSchema = z
  .object({
    mode: z.literal("split"),
    ...BaseRecurringPatchFields,
    categoryId: z.null().optional(),
    transferAccountId: z.null().optional(),
    subTransactions: z.array(SubTransactionSchema).min(2),
  })
  .strict()
  .refine(
    (data) => {
      if (data.amount !== undefined) {
        const sum = data.subTransactions.reduce((acc, c) => acc + c.amount, 0);
        return sum === data.amount;
      }
      return true;
    },
    {
      message: "Sub-transactions sum must equal total parent amount",
      path: ["subTransactions"],
    }
  );

export const RecurringPatchInputSchema = z.discriminatedUnion("mode", [
  SingleRecurringPatchSchema,
  TransferRecurringPatchSchema,
  SplitRecurringPatchSchema,
]);

export const RecurringPatchSchema = z.preprocess(inferTransactionMode, RecurringPatchInputSchema);

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

// Shared read-side enums (server -> UI may carry the internal "duplicate"
// marker and reconciled "r" status, unlike create/update inputs).
const ResponseFlagSchema = z.enum(["red", "orange", "yellow", "green", "blue", "purple", "duplicate"]);
const ResponseClearedStatus = z.enum(["u", "c", "r"]);

// ---------------------------------------------------------------------------
// Query-string contracts (URL search params).
//
// Hand-rolled Number()/split()/filter() parsing silently drops malformed
// input (e.g. DELETE ?ids=abc became a no-op success). These schemas make
// malformed params a 400 instead.
// ---------------------------------------------------------------------------

/** Comma-separated positive integer id list, e.g. ?ids=1,2,3. */
export const IdListQuerySchema = z.string().min(1).transform((s, ctx) => {
  const ids = s
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    ctx.addIssue({ code: "custom", message: "No valid positive integer ids" });
    return z.NEVER;
  }
  return ids;
});

/** Single positive integer param, e.g. ?id=7. */
export const PositiveIntQuerySchema = z
  .string()
  .regex(/^[1-9]\d*$/, "Expected a positive integer")
  .transform(Number);

export const ReconcileStateQuerySchema = z.object({
  accountId: PositiveIntQuerySchema,
  statementDate: ISODateSchema.optional(),
});

// ---------------------------------------------------------------------------
// Focused mutation/read response contracts for the fetch sites whose fields
// the client actually reads (assignments PUT, recurring autopost, reconcile
// state, duplicate analysis, transaction create). Unlike BudgetData (always
// String()ed money), some mutation routes return raw drizzle rows with
// numeric money — FlexibleMoneyString normalizes those to the string
// convention instead of rejecting real responses.
// ---------------------------------------------------------------------------

const FlexibleMoneyString = z.union([z.string(), z.number()]).transform((v) => String(v));

export const AssignmentMutationResponseSchema = z.looseObject({
  id: z.number().int(),
  categoryId: z.number().int(),
  month: z.string(),
  amount: FlexibleMoneyString,
});

export function parseAssignmentResponse(data: unknown): Assignment {
  const result = AssignmentMutationResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid assignment response: ${formatZodError(result.error)}`);
  }
  return result.data as Assignment;
}

export const RecurringAutoPostResponseSchema = z.looseObject({
  postedCount: z.number().int().nonnegative().optional(),
  failures: z
    .array(z.looseObject({ id: z.number().int(), payee: z.string().optional(), error: z.string() }))
    .optional(),
  capped: z
    .array(
      z.looseObject({
        id: z.number().int(),
        payee: z.string().optional(),
        remainingDue: z.number().int(),
      })
    )
    .optional(),
});

export type RecurringAutoPostResponse = z.output<typeof RecurringAutoPostResponseSchema>;

export function parseRecurringAutoPostResponse(data: unknown): RecurringAutoPostResponse {
  const result = RecurringAutoPostResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid autopost response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export const ReconcileStateResponseSchema = z.looseObject({
  accountId: z.number().int(),
  accountName: z.string(),
  workingBalance: z.number().int(),
  unclearedTotal: z.number().int(),
  unclearedCount: z.number().int(),
  clearedCount: z.number().int(),
  reconciledCount: z.number().int(),
  lastReconciledAt: z.string().nullable(),
  lastReconciledBalance: z.number().nullable(),
});

export function parseReconcileStateResponse(data: unknown): ReconcileState {
  const result = ReconcileStateResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid reconcile response: ${formatZodError(result.error)}`);
  }
  return result.data as ReconcileState;
}

export const DuplicateEntryResponseSchema = z.looseObject({
  id: z.number().int().optional(),
  rowNumber: z.number().int().optional(),
  accountId: z.number().int(),
  accountName: z.string().optional(),
  date: z.string(),
  payee: z.string(),
  memo: z.string(),
  amount: z.number().int(),
  flagColor: ResponseFlagSchema.nullable().optional(),
  status: ResponseClearedStatus.optional(),
  parentId: z.number().int().nullable().optional(),
  transferAccountId: z.number().int().nullable().optional(),
  fitId: z.string().nullable().optional(),
});

export const DuplicateAnalysisResultResponseSchema = z.looseObject({
  groups: z.array(
    z.looseObject({
      fingerprint: z.string(),
      keeper: DuplicateEntryResponseSchema,
      duplicates: z.array(DuplicateEntryResponseSchema),
    })
  ),
  duplicateCount: z.number().int().nonnegative(),
  flaggedCount: z.number().int().nonnegative(),
  alreadyFlaggedCount: z.number().int().nonnegative(),
  lockedCount: z.number().int().nonnegative(),
  clearedCount: z.number().int().nonnegative(),
});

export function parseDuplicateAnalysisResponse(data: unknown): DuplicateAnalysisResult {
  const result = DuplicateAnalysisResultResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid duplicates response: ${formatZodError(result.error)}`);
  }
  return result.data as DuplicateAnalysisResult;
}

const CreatedTransactionResponseSchema = z.looseObject({
  id: z.number().int(),
  amount: FlexibleMoneyString.optional(),
});

const CreatedSplitResponseSchema = z.looseObject({
  parent: CreatedTransactionResponseSchema,
  children: z.array(CreatedTransactionResponseSchema).min(1),
});

export const TransactionMutationResultSchema = z.union([
  CreatedTransactionResponseSchema,
  CreatedSplitResponseSchema,
]);

export type TransactionMutationResult = z.output<typeof TransactionMutationResultSchema>;

export function parseTransactionMutationResult(data: unknown): TransactionMutationResult {
  const result = TransactionMutationResultSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid transaction response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Response contracts (server -> UI).
//
// Request schemas above validate what the UI sends. These validate what the
// server returns, so a server-side shape regression fails fast at the fetch
// boundary instead of flowing silently into budget calculations.
//
// Objects are loose (unknown keys pass through) so the server can add fields
// without breaking older clients; required/typed fields pin the shape the UI
// actually depends on. Money is always a base-unit string on the wire —
// mirroring getBudgetData(), which String()s every integer column.
// ---------------------------------------------------------------------------

const LooseIdEntity = {
  id: z.number().int(),
  entityId: z.string().nullable().optional(),
};

export const AccountResponseSchema = z.looseObject({
  ...LooseIdEntity,
  name: z.string(),
  kind: z.enum(["liquid", "credit", "offbudget"]),
  groupLabel: z.string(),
  balance: z.string(),
  onBudget: z.boolean(),
  sort: z.number().int(),
  lastReconciledAt: z.string().nullable().optional(),
  lastReconciledBalance: z.union([z.string(), z.number()]).nullable().optional(),
  archived: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

export const CategoryGroupResponseSchema = z.looseObject({
  ...LooseIdEntity,
  name: z.string(),
  sort: z.number().int(),
  isCreditCardPayments: z.boolean(),
  isHidden: z.boolean().optional(),
});

export const CategoryResponseSchema = z.looseObject({
  ...LooseIdEntity,
  groupId: z.number().int(),
  name: z.string(),
  sort: z.number().int(),
  carryover: z.string(),
  goalTarget: z.string().nullable(),
  linkedAccountId: z.number().int().nullable(),
  overspendCarriesOver: z.boolean().nullable().optional(),
});

export const AssignmentResponseSchema = z.looseObject({
  ...LooseIdEntity,
  categoryId: z.number().int(),
  month: z.string(),
  amount: z.string(),
});

export const TransactionResponseSchema = z.looseObject({
  ...LooseIdEntity,
  transferEntityId: z.string().nullable().optional(),
  accountId: z.number().int(),
  categoryId: z.number().int().nullable(),
  date: z.string(),
  payee: z.string(),
  memo: z.string(),
  amount: z.string(),
  status: z.enum(["u", "c", "r"]),
  transferStatus: z.enum(["u", "c", "r"]).nullable().optional(),
  flagColor: ResponseFlagSchema.nullable().optional(),
  createdAt: z.string().optional(),
  parentId: z.number().int().nullable().optional(),
  transferAccountId: z.number().int().nullable().optional(),
  isIncome: z.boolean().optional(),
  incomeMonth: z.string().nullable().optional(),
  reconciledAt: z.string().nullable().optional(),
  reconciliationId: z.number().int().nullable().optional(),
  transferReconciledAt: z.string().nullable().optional(),
  transferReconciliationId: z.number().int().nullable().optional(),
  needsReview: z.boolean().optional(),
});

export const RecurringSubTransactionResponseSchema = z.looseObject({
  ...LooseIdEntity,
  recurringId: z.number().int(),
  categoryId: z.number().int().nullable(),
  amount: z.string(),
  memo: z.string(),
  sort: z.number().int(),
  transferAccountId: z.number().int().nullable().optional(),
});

export const RecurringResponseSchema = z.looseObject({
  ...LooseIdEntity,
  accountId: z.number().int(),
  categoryId: z.number().int().nullable(),
  payee: z.string(),
  memo: z.string().optional(),
  amount: z.string(),
  frequency: z.string(),
  nextDate: z.string(),
  anchorDay: z.number().int().nullable().optional(),
  active: z.boolean(),
  transferAccountId: z.number().int().nullable().optional(),
  flagColor: TransactionFlagSchema.nullable().optional(),
  subTransactions: z.array(RecurringSubTransactionResponseSchema),
});

export const RenameRuleResponseSchema = z.looseObject({
  ...LooseIdEntity,
  sourcePattern: z.string(),
  targetPayee: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
});

export type RenameRuleResponse = z.output<typeof RenameRuleResponseSchema>;

/**
 * Validate an unknown payload (e.g. `POST /api/rename-rules` JSON)
 * against the single-rule response contract. Throws a descriptive Error
 * on mismatch. Emits no console output so it is safe in tested fetch paths.
 */
export function parseRenameRuleResponse(data: unknown): RenameRuleResponse {
  const result = RenameRuleResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid rename rule response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export const RenameSuggestStatusResponseSchema = z.looseObject({
  enabled: z.boolean(),
  candidates: z.array(
    z.looseObject({
      payee: z.string(),
      count: z.number(),
    })
  ),
  totalUnique: z.number(),
  truncated: z.boolean(),
});

export type RenameSuggestStatusResponse = z.output<typeof RenameSuggestStatusResponseSchema>;

/**
 * Validate an unknown payload (e.g. `GET /api/rename-rules/suggest`
 * JSON) against the response contract. Throws a descriptive Error on
 * mismatch. Emits no console output so it is safe in tested fetch paths.
 */
export function parseRenameSuggestStatusResponse(data: unknown): RenameSuggestStatusResponse {
  const result = RenameSuggestStatusResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid rename suggest status response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * One page of uncovered payees. The client walks the queue in
 * `RENAME_SUGGEST_BATCH_SIZE` steps; omitting the body (or both fields)
 * keeps the legacy single-shot behavior up to the configured cap.
 */
export const RenameSuggestBatchSchema = z
  .object({
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

export type RenameSuggestBatchInput = z.output<typeof RenameSuggestBatchSchema>;

export const RenameSuggestResponseSchema = z.looseObject({
  suggestions: z.array(
    z.looseObject({
      sourcePattern: z.string(),
      targetPayee: z.string(),
      count: z.number(),
      /** Review evidence: the memos the AI saw for this payee, when any. */
      memos: z.array(z.string()).optional(),
    })
  ),
  skipped: z.array(
    z.looseObject({
      source: z.string(),
      reason: z.string(),
    })
  ),
  model: z.string(),
  /** Distinct payees actually sent to the LLM for this batch. */
  processed: z.number().int().min(0),
});

export type RenameSuggestResponse = z.output<typeof RenameSuggestResponseSchema>;

/**
 * Validate an unknown payload (e.g. `POST /api/rename-rules/suggest`
 * JSON) against the response contract. Throws a descriptive Error on
 * mismatch. Emits no console output so it is safe in tested fetch paths.
 */
export function parseRenameSuggestResponse(data: unknown): RenameSuggestResponse {
  const result = RenameSuggestResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid rename suggest response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export const RenameSuggestAcceptResponseSchema = z.looseObject({
  rules: z.array(RenameRuleResponseSchema),
  applied: z.looseObject({
    updated: z.number(),
    skippedLocked: z.number(),
  }),
  generalised: z.boolean(),
});

export type RenameSuggestAcceptResponse = z.output<typeof RenameSuggestAcceptResponseSchema>;

/**
 * Validate an unknown payload (e.g. `POST
 * /api/rename-rules/suggest?action=accept` JSON) against the response
 * contract. Throws a descriptive Error on mismatch. Emits no console
 * output so it is safe in tested fetch paths.
 */
export function parseRenameSuggestAcceptResponse(data: unknown): RenameSuggestAcceptResponse {
  const result = RenameSuggestAcceptResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid rename suggest accept response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export const PayeeResponseSchema = z.looseObject({
  ...LooseIdEntity,
  name: z.string(),
  autoCategoryId: z.number().int().nullable(),
  createdAt: z.string(),
});

export const SnapshotResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number(),
});

export type SnapshotResponse = z.output<typeof SnapshotResponseSchema>;

export const SnapshotsResponseSchema = z.looseObject({
  snapshots: z.array(SnapshotResponseSchema),
  suggestedName: z.string(),
});

export type SnapshotsResponse = z.output<typeof SnapshotsResponseSchema>;

/**
 * Validate an unknown payload (e.g. `GET /api/snapshots` JSON) against the
 * response contract. Returns the typed payload on success; throws a
 * descriptive Error on mismatch. Emits no console output so it is safe in
 * tested fetch paths.
 */
export function parseSnapshotsResponse(data: unknown): SnapshotsResponse {
  const result = SnapshotsResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid snapshots response: ${formatZodError(result.error)}`);
  }
  return result.data;
}

const NumberRecord = z.record(z.string(), z.number());
const NestedNumberRecord = z.record(z.string(), z.record(z.string(), z.number()));

export const BudgetIndexResponseSchema = z
  .looseObject({
    version: z.number().optional(),
    assignedByMonth: NestedNumberRecord.optional(),
    assignedTotalByMonth: NumberRecord.optional(),
    outflowByMonth: NestedNumberRecord.optional(),
    spendByAccountMonth: NestedNumberRecord.optional(),
    incomeByMonth: NumberRecord.optional(),
    incomeFromFutureByMonth: NumberRecord.optional(),
    incomeFromPastByMonth: NumberRecord.optional(),
    incomeDeferredToFutureByMonth: NumberRecord.optional(),
    incomeDeferredToPastByMonth: NumberRecord.optional(),
    carryoverByMonth: NestedNumberRecord.optional(),
    endingBalanceByMonth: NestedNumberRecord.optional(),
    overspentByMonth: NumberRecord.optional(),
    surplusByMonth: NumberRecord.optional(),
    unfundedPaydownByMonth: NestedNumberRecord.optional(),
  })
  .optional();

export const BudgetDataResponseSchema = z.looseObject({
  accounts: z.array(AccountResponseSchema),
  groups: z.array(CategoryGroupResponseSchema),
  categories: z.array(CategoryResponseSchema),
  assignments: z.array(AssignmentResponseSchema),
  transactions: z.array(TransactionResponseSchema),
  recurring: z.array(RecurringResponseSchema),
  budgetIndex: BudgetIndexResponseSchema,
  renameRules: z.array(RenameRuleResponseSchema).optional(),
  payees: z.array(PayeeResponseSchema).optional(),
});

export type BudgetDataResponse = z.output<typeof BudgetDataResponseSchema>;

/**
 * Validate an unknown payload (e.g. `GET /api/budget` JSON) against the
 * response contract. Returns the payload typed as BudgetData on success;
 * throws a descriptive Error on mismatch. Emits no console output so it is
 * safe in tested fetch paths.
 */
export function parseBudgetDataResponse(data: unknown): BudgetData {
  const result = BudgetDataResponseSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid budget response: ${formatZodError(result.error)}`);
  }
  return result.data as BudgetData;
}
