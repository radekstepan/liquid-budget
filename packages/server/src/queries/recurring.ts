import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { recurring, recurringSubTransactions } from "../schema.js";
import type { SubTransactionInput as TxnSubTransactionInput } from "./transactions.js";

export type CreateRecurringInput = {
  accountId: number;
  categoryId: number | null;
  payee: string;
  amount: number;
  frequency: string;
  nextDate: string;
  active?: boolean;
  /**
   * If set, this recurring entry is a transfer: it lives on `accountId`
   * and the corresponding balance movement lands on `transferAccountId`
   * when posted. `categoryId` is forced to null and `subTransactions`
   * must be omitted.
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
  amount?: number;
  frequency?: string;
  nextDate?: string;
  active?: boolean;
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
  children: TxnSubTransactionInput[],
  isExistingChildren = false
): void {
  if (children.length < 2) {
    throw new RecurringError("split must have at least two sub-transactions");
  }
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!Number.isFinite(Number(c.amount))) {
      throw new RecurringError(`sub-transaction ${i + 1} amount is not a valid number`);
    }
    if (c.categoryId && c.transferAccountId) {
      throw new RecurringError(`sub-transaction ${i + 1} cannot have both a category and transfer account`);
    }
    if (!isExistingChildren && !c.categoryId && !c.transferAccountId) {
      throw new RecurringError(`sub-transaction ${i + 1} must have a category or transfer account`);
    }
  }
  const sum = children.reduce((s, c) => s + Number(c.amount), 0);
  if (sum !== parentAmount) {
    throw new RecurringError(
      `split children do not sum to parent: ${sum} vs ${parentAmount}`
    );
  }
}

function normaliseInput(input: CreateRecurringInput | UpdateRecurringInput): {
  isTransfer: boolean;
  isSplit: boolean;
  effectiveCategoryId: number | null;
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
    isTransfer || isSplit ? null : (explicitCategoryId ?? null);

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
  if (norm.isSplit) {
    assertSplitsBalanced(input.amount, norm.subTransactions!);
  }

  db.run(sql`BEGIN`);
  try {
    const [parent] = await db
      .insert(recurring)
      .values({
        accountId: input.accountId,
        categoryId: norm.effectiveCategoryId,
        payee: input.payee,
        amount: input.amount,
        frequency: input.frequency,
        nextDate: input.nextDate,
        active: input.active ?? true,
        transferAccountId: norm.effectiveTransferAccountId,
      })
      .returning();

    if (norm.isSplit && parent) {
      let sort = 0;
      for (const c of norm.subTransactions!) {
        await db.insert(recurringSubTransactions).values({
          recurringId: parent.id,
          categoryId: c.categoryId,
          amount: c.amount,
          memo: c.memo ?? "",
          sort: sort++,
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

  // Validate split children if supplied.
  if (norm.isSplit) {
    const parentAmount =
      "amount" in patch && (patch as UpdateRecurringInput).amount != null
        ? Number((patch as UpdateRecurringInput).amount)
        : Number(existing.amount);
    assertSplitsBalanced(parentAmount, norm.subTransactions!);
  }

  // If neither `subTransactions` nor `transferAccountId` are being
  // changed, but `amount` is — for an existing split entry, the
  // children must still sum to the new amount.
  if (
    existing.transferAccountId == null &&
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
      assertSplitsBalanced(Number((patch as UpdateRecurringInput).amount), existingChildren, true);
    }
  }

  const p: Record<string, unknown> = {};
  if (patch.accountId != null) p.accountId = Number(patch.accountId);
  if ("categoryId" in patch) p.categoryId = norm.effectiveCategoryId;
  if (patch.payee != null) p.payee = String(patch.payee);
  if (patch.amount != null) p.amount = Number(patch.amount);
  if (patch.frequency != null) p.frequency = String(patch.frequency);
  if (patch.nextDate != null) p.nextDate = String(patch.nextDate);
  if (patch.active != null) p.active = !!patch.active;
  if ("transferAccountId" in patch) p.transferAccountId = norm.effectiveTransferAccountId;

  db.run(sql`BEGIN`);
  try {
    if (Object.keys(p).length > 0) {
      await db.update(recurring).set(p).where(eq(recurring.id, id));
    }

    if ("subTransactions" in patch) {
      await db
        .delete(recurringSubTransactions)
        .where(eq(recurringSubTransactions.recurringId, id));
      if (norm.isSplit) {
        let sort = 0;
        for (const c of norm.subTransactions!) {
          await db.insert(recurringSubTransactions).values({
            recurringId: id,
            categoryId: c.categoryId,
            amount: c.amount,
            memo: c.memo ?? "",
            sort: sort++,
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
