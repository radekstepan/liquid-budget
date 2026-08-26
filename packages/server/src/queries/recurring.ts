import { and, eq, sql } from "drizzle-orm";
import { isValidRecurringFrequency, nextDateFor, todayISO, type TransactionFlagColor } from "@ynab/logic";
import type { Database } from "../client.js";
import { recurring, recurringSubTransactions } from "../schema.js";
import {
  createSplitWithChildren,
  createTransaction,
  assertValidAmount,
  isAccountOnBudget,
  sanitizeFlagColor,
  type SubTransactionInput as TxnSubTransactionInput,
} from "./transactions.js";

function assertValidFrequency(frequency: unknown): string {
  if (!isValidRecurringFrequency(frequency)) {
    throw new RecurringError(`invalid frequency: ${frequency}`, 422);
  }
  return String(frequency);
}

export type CreateRecurringInput = {
  accountId: number;
  categoryId: number | null;
  payee: string;
  memo?: string;
  amount: number;
  frequency: string;
  nextDate: string;
  active?: boolean;
  flagColor?: TransactionFlagColor | null;
  /**
   * If set, this recurring entry is a transfer: it lives on `accountId`
   * and the corresponding balance movement lands on `transferAccountId`
   * when posted. For boundary-crossing transfers to off-budget accounts,
   * `categoryId` is preserved/required; for same-boundary transfers,
   * `categoryId` is forced to null. `subTransactions` must be omitted.
   */
  transferAccountId?: number | null;
  /**
   * If set, this recurring entry is a split: the parent's amount is
   * informational (sum of children) and only children are applied to
   * account / category balances at post time. Mutually exclusive with
   * `transferAccountId`.
   */
  subTransactions?: TxnSubTransactionInput[];
};

export type UpdateRecurringInput = {
  accountId?: number;
  categoryId?: number | null;
  payee?: string;
  memo?: string;
  amount?: number;
  frequency?: string;
  nextDate?: string;
  active?: boolean;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: number | null;
  /**
   * If the key is present in the patch, the children of this recurring
   * entry are FULLY REPLACED with the supplied list (mirror of how
   * `updateSplit` works for transactions). Omit the key to leave
   * existing children untouched.
   */
  subTransactions?: TxnSubTransactionInput[];
};

/**
 * Thrown by the recurring queries to signal a validation failure that
 * should surface as a 4xx HTTP response (rather than a 5xx).
 */
export class RecurringError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "RecurringError";
  }
}

/**
 * Validate a set of recurring sub-transactions. Mirrors the
 * transaction-side `assertSplitsBalanced`.
 *
 * Children use their *signed* amounts so mixed-sign splits (e.g. a
 * Paycheck with a negative tax deduction) are supported. The signed
 * sum must equal the signed parent amount to the cent.
 */
function assertSplitsBalanced(
  parentAmount: number,
  children: TxnSubTransactionInput[]
): void {
  const validParent = assertValidAmount(parentAmount);
  if (children.length < 2) {
    throw new RecurringError("split must have at least two sub-transactions");
  }
  let sum = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const childAmount = assertValidAmount(c.amount);
    sum += childAmount;
    if (!c.categoryId && !c.transferAccountId && childAmount <= 0) {
      throw new RecurringError(`sub-transaction ${i + 1} must have a category or transfer account`);
    }
  }
  if (sum !== validParent) {
    throw new RecurringError(
      `split children do not sum to parent: ${sum} vs ${validParent}`
    );
  }
}

function normaliseInput(input: CreateRecurringInput | UpdateRecurringInput): {
  isTransfer: boolean;
  isSplit: boolean;
  effectiveCategoryId: number | null | undefined;
  effectiveTransferAccountId: number | null;
  effectiveAccountId: number | null;
  subTransactions: TxnSubTransactionInput[] | undefined;
} {
  const isTransfer =
    "transferAccountId" in input && (input as CreateRecurringInput).transferAccountId != null;
  const isSplit =
    "subTransactions" in input &&
    Array.isArray((input as CreateRecurringInput).subTransactions) &&
    ((input as CreateRecurringInput).subTransactions!.length ?? 0) > 0;

  if (isTransfer && isSplit) {
    throw new RecurringError("recurring cannot be both a transfer and a split");
  }

  const effectiveTransferAccountId = isTransfer
    ? Number((input as CreateRecurringInput).transferAccountId)
    : null;
  const effectiveAccountId =
    "accountId" in input && (input as CreateRecurringInput).accountId != null
      ? Number((input as CreateRecurringInput).accountId)
      : null;

  if (isTransfer && effectiveAccountId != null && effectiveTransferAccountId === effectiveAccountId) {
    throw new RecurringError("transfer account must differ from source account");
  }

  const explicitCategoryId =
    "categoryId" in input ? (input as CreateRecurringInput).categoryId : undefined;
  const effectiveCategoryId =
    isSplit
      ? null
      : explicitCategoryId !== undefined
        ? explicitCategoryId != null
          ? Number(explicitCategoryId)
          : null
        : undefined;

  const subTransactions = isSplit
    ? ((input as CreateRecurringInput).subTransactions as TxnSubTransactionInput[])
    : undefined;

  return {
    isTransfer,
    isSplit,
    effectiveCategoryId,
    effectiveTransferAccountId,
    effectiveAccountId,
    subTransactions,
  };
}

export async function createRecurring(db: Database, input: CreateRecurringInput) {
  const norm = normaliseInput(input);
  const validatedAmount = assertValidAmount(input.amount);
  const validatedFrequency = assertValidFrequency(input.frequency);
  if (norm.isSplit) {
    assertSplitsBalanced(validatedAmount, norm.subTransactions!);
    for (const c of norm.subTransactions!) {
      if (c.transferAccountId != null && Number(c.transferAccountId) === Number(input.accountId)) {
        throw new RecurringError("transfer account must differ from source account");
      }
    }
  }

  db.run(sql`BEGIN`);
  try {
    const srcOnBudget = await isAccountOnBudget(db, input.accountId);
    let categoryId: number | null = null;

    if (norm.isSplit) {
      categoryId = null;
    } else if (norm.isTransfer && norm.effectiveTransferAccountId != null) {
      const destOnBudget = await isAccountOnBudget(db, norm.effectiveTransferAccountId);
      const isBoundaryCrossing = srcOnBudget !== destOnBudget;
      const netOnBudgetDelta = (srcOnBudget ? validatedAmount : 0) + (destOnBudget ? -validatedAmount : 0);

      if (isBoundaryCrossing) {
        if (netOnBudgetDelta < 0) {
          if (norm.effectiveCategoryId == null) {
            throw new RecurringError("Boundary transfer outflow requires a category", 422);
          }
          categoryId = norm.effectiveCategoryId;
        } else {
          categoryId = norm.effectiveCategoryId ?? null;
        }
      } else {
        categoryId = null;
      }
    } else if (!srcOnBudget) {
      categoryId = null;
    } else {
      categoryId = norm.effectiveCategoryId ?? null;
    }

    const [parent] = await db
      .insert(recurring)
      .values({
        accountId: input.accountId,
        categoryId,
        payee: input.payee,
        memo: input.memo ?? "",
        amount: validatedAmount,
        frequency: validatedFrequency,
        nextDate: input.nextDate,
        active: input.active ?? true,
        flagColor: sanitizeFlagColor(input.flagColor),
        transferAccountId: norm.effectiveTransferAccountId,
      })
      .returning();

    if (norm.isSplit && parent) {
      let sort = 0;
      for (const c of norm.subTransactions!) {
        const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
        let categoryId: number | null = null;
        const childAmount = assertValidAmount(c.amount);

        if (transferAccountId) {
          const destOnBudget = await isAccountOnBudget(db, transferAccountId);
          const isBoundaryCrossing = srcOnBudget !== destOnBudget;
          const netOnBudgetDelta = (srcOnBudget ? childAmount : 0) + (destOnBudget ? -childAmount : 0);

          if (isBoundaryCrossing) {
            if (netOnBudgetDelta < 0) {
              if (c.categoryId == null) {
                throw new RecurringError("Boundary transfer outflow requires a category", 422);
              }
              categoryId = Number(c.categoryId);
            } else {
              categoryId = c.categoryId ? Number(c.categoryId) : null;
            }
          } else {
            categoryId = null;
          }
        } else if (!srcOnBudget) {
          categoryId = null;
        } else {
          categoryId = c.categoryId ? Number(c.categoryId) : null;
        }

        await db.insert(recurringSubTransactions).values({
          recurringId: parent.id,
          categoryId,
          amount: childAmount,
          memo: c.memo ?? "",
          sort: sort++,
          transferAccountId,
        });
      }
    }

    db.run(sql`COMMIT`);
    return parent;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function updateRecurring(db: Database, id: number, patch: UpdateRecurringInput) {
  // Read the existing row to support rules that depend on the current state.
  const [existing] = await db.select().from(recurring).where(eq(recurring.id, id));
  if (!existing) return null;

  const norm = normaliseInput(patch);

  const effectiveAccountId =
    "accountId" in patch && patch.accountId != null
      ? Number(patch.accountId)
      : existing.accountId;

  const effectiveTransferAccountId =
    "transferAccountId" in patch
      ? norm.effectiveTransferAccountId
      : existing.transferAccountId;

  const isTransfer = effectiveTransferAccountId != null;

  if (isTransfer && effectiveTransferAccountId === effectiveAccountId) {
    throw new RecurringError("transfer account must differ from source account");
  }

  // Validate split children if supplied.
  if (norm.isSplit) {
    const parentAmount =
      "amount" in patch && (patch as UpdateRecurringInput).amount != null
        ? assertValidAmount((patch as UpdateRecurringInput).amount)
        : assertValidAmount(existing.amount);
    assertSplitsBalanced(parentAmount, norm.subTransactions!);
    for (const c of norm.subTransactions!) {
      if (c.transferAccountId != null && Number(c.transferAccountId) === Number(effectiveAccountId)) {
        throw new RecurringError("transfer account must differ from source account");
      }
    }
  }

  // If neither `subTransactions` nor `transferAccountId` are being
  // changed, but `amount` is — for an existing split entry, the
  // children must still sum to the new amount.
  if (
    !norm.isTransfer &&
    !norm.isSplit &&
    !("subTransactions" in patch) &&
    "amount" in patch &&
    (patch as UpdateRecurringInput).amount != null
  ) {
    const existingChildren = await db
      .select()
      .from(recurringSubTransactions)
      .where(eq(recurringSubTransactions.recurringId, id));
    if (existingChildren.length > 0) {
      assertSplitsBalanced(assertValidAmount((patch as UpdateRecurringInput).amount), existingChildren);
    }
  }

  const effectiveAmount =
    "amount" in patch && patch.amount != null
      ? assertValidAmount(patch.amount)
      : Number(existing.amount);

  const p: Record<string, unknown> = {};
  if (patch.accountId != null) p.accountId = Number(patch.accountId);
  if (patch.payee != null) p.payee = String(patch.payee);
  if ("memo" in patch && patch.memo !== undefined) p.memo = String(patch.memo ?? "");
  if (patch.amount != null) p.amount = effectiveAmount;
  if (patch.frequency != null) p.frequency = assertValidFrequency(patch.frequency);
  if (patch.nextDate != null) p.nextDate = String(patch.nextDate);
  if (patch.active != null) p.active = !!patch.active;
  if ("flagColor" in patch && patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if ("transferAccountId" in patch) p.transferAccountId = norm.effectiveTransferAccountId;

  db.run(sql`BEGIN`);
  try {
    const targetAccountId = (p.accountId as number | undefined) ?? existing.accountId;
    const srcOnBudget = await isAccountOnBudget(db, targetAccountId);

    if (norm.isSplit) {
      p.transferAccountId = null;
      p.categoryId = null;
    } else if (isTransfer) {
      const destOnBudget = await isAccountOnBudget(db, effectiveTransferAccountId!);
      const isBoundaryCrossing = srcOnBudget !== destOnBudget;
      const netOnBudgetDelta = (srcOnBudget ? effectiveAmount : 0) + (destOnBudget ? -effectiveAmount : 0);

      const candidateCatId =
        "categoryId" in patch && norm.effectiveCategoryId !== undefined
          ? norm.effectiveCategoryId
          : existing.categoryId;

      if (isBoundaryCrossing) {
        if (netOnBudgetDelta < 0) {
          if (candidateCatId == null) {
            throw new RecurringError("Boundary transfer outflow requires a category", 422);
          }
          p.categoryId = candidateCatId;
        } else {
          p.categoryId = candidateCatId ?? null;
        }
      } else {
        p.categoryId = null;
      }
    } else if (!srcOnBudget) {
      p.categoryId = null;
    } else if ("categoryId" in patch && norm.effectiveCategoryId !== undefined) {
      p.categoryId = norm.effectiveCategoryId;
    }

    if (Object.keys(p).length > 0) {
      await db.update(recurring).set(p).where(eq(recurring.id, id));
    }

    if (norm.isTransfer || "subTransactions" in patch) {
      await db
        .delete(recurringSubTransactions)
        .where(eq(recurringSubTransactions.recurringId, id));
      if (norm.isSplit) {
        let sort = 0;
        for (const c of norm.subTransactions!) {
          const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
          let categoryId: number | null = null;
          const childAmount = assertValidAmount(c.amount);

          if (transferAccountId) {
            const destOnBudget = await isAccountOnBudget(db, transferAccountId);
            const isBoundaryCrossing = srcOnBudget !== destOnBudget;
            const netOnBudgetDelta = (srcOnBudget ? childAmount : 0) + (destOnBudget ? -childAmount : 0);

            if (isBoundaryCrossing) {
              if (netOnBudgetDelta < 0) {
                if (c.categoryId == null) {
                  throw new RecurringError("Boundary transfer outflow requires a category", 422);
                }
                categoryId = Number(c.categoryId);
              } else {
                categoryId = c.categoryId ? Number(c.categoryId) : null;
              }
            } else {
              categoryId = null;
            }
          } else if (!srcOnBudget) {
            categoryId = null;
          } else {
            categoryId = c.categoryId ? Number(c.categoryId) : null;
          }

          await db.insert(recurringSubTransactions).values({
            recurringId: id,
            categoryId,
            amount: childAmount,
            memo: c.memo ?? "",
            sort: sort++,
            transferAccountId,
          });
        }
      }
    }

    const [row] = await db.select().from(recurring).where(eq(recurring.id, id));
    db.run(sql`COMMIT`);
    return row ?? null;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function deleteRecurring(db: Database, id: number) {
  db.run(sql`BEGIN`);
  try {
    await db.delete(recurring).where(and(eq(recurring.id, id)));
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

/**
 * Materialize a recurring transaction into a real transaction row with full
 * split and transfer integrity, using the scheduled nextDate (or specified postDate),
 * and advance the scheduled nextDate according to its frequency.
 */
export async function postRecurringTransaction(
  db: Database,
  recurringId: number,
  postDate?: string
) {
  const [r] = await db.select().from(recurring).where(eq(recurring.id, recurringId));
  if (!r) throw new RecurringError("Recurring transaction not found", 404);

  const dateToUse = postDate || r.nextDate;
  const children = await db
    .select()
    .from(recurringSubTransactions)
    .where(eq(recurringSubTransactions.recurringId, r.id))
    .orderBy(recurringSubTransactions.sort);

  let postedTxn;
  if (r.transferAccountId != null) {
    postedTxn = await createTransaction(db, {
      accountId: r.accountId,
      categoryId: r.categoryId,
      date: dateToUse,
      payee: r.payee,
      memo: r.memo || "Recurring",
      amount: Number(r.amount),
      status: "c",
      transferAccountId: r.transferAccountId,
      flagColor: sanitizeFlagColor(r.flagColor),
    });
  } else if (children.length > 0) {
    postedTxn = await createSplitWithChildren(
      db,
      {
        accountId: r.accountId,
        date: dateToUse,
        payee: r.payee,
        memo: r.memo || "Recurring",
        amount: Number(r.amount),
        status: "c",
        flagColor: sanitizeFlagColor(r.flagColor),
      },
      children.map((c) => ({
        categoryId: c.categoryId,
        amount: Number(c.amount),
        memo: c.memo || undefined,
        transferAccountId: c.transferAccountId,
      }))
    );
  } else {
    postedTxn = await createTransaction(db, {
      accountId: r.accountId,
      categoryId: r.categoryId,
      date: dateToUse,
      payee: r.payee,
      memo: r.memo || "Recurring",
      amount: Number(r.amount),
      status: "c",
      transferAccountId: null,
      flagColor: sanitizeFlagColor(r.flagColor),
    });
  }

  const normFreq = (r.frequency || "").toLowerCase().replace(/[\s_-]+/g, "");
  const isOneOff = normFreq === "never" || normFreq === "once";
  const next = nextDateFor(r.frequency, r.nextDate);
  const updatePayload: { nextDate: string; active?: boolean } = { nextDate: next };
  if (isOneOff) {
    updatePayload.active = false;
  }
  await db.update(recurring).set(updatePayload).where(eq(recurring.id, r.id));

  return { transaction: postedTxn, nextDate: next, active: isOneOff ? false : r.active };
}

/**
 * Automatically materialize all active recurring transactions whose nextDate <= asOfDate.
 */
export async function autoPostDueRecurringTransactions(
  db: Database,
  asOfDate: string = todayISO()
) {
  const due = await db
    .select()
    .from(recurring)
    .where(and(eq(recurring.active, true), sql`${recurring.nextDate} <= ${asOfDate}`));

  const posted = [];
  for (const r of due) {
    let currentNextDate = r.nextDate;
    while (currentNextDate <= asOfDate) {
      const res = await postRecurringTransaction(db, r.id, currentNextDate);
      posted.push(res.transaction);
      if (!res.active || res.nextDate <= currentNextDate) break;
      currentNextDate = res.nextDate;
    }
  }
  return posted;
}
