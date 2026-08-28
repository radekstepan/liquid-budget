import { and, eq, sql } from "drizzle-orm";
import {
  classifyBoundaryTransfer,
  isMonthBasedFrequency,
  isValidISODate,
  isValidRecurringFrequency,
  nextDateFor,
  todayISO,
  type TransactionFlagColor,
} from "@ynab/logic";
import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
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

function assertValidISODate(date: unknown, fieldName: string = "date"): string {
  if (!isValidISODate(date)) {
    throw new RecurringError(`Invalid calendar date for ${fieldName}: ${date}`, 400);
  }
  return String(date);
}

export type CreateRecurringInput = {
  accountId: number;
  categoryId: number | null;
  payee: string;
  memo?: string;
  amount: number;
  frequency: string;
  nextDate: string;
  anchorDay?: number | null;
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
  anchorDay?: number | null;
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
  effectiveTransferAccountId: number | null | undefined;
  effectiveAccountId: number | null | undefined;
  subTransactions: TxnSubTransactionInput[] | undefined;
} {
  const isTransfer =
    input.transferAccountId !== undefined && input.transferAccountId != null;
  const isSplit =
    input.subTransactions !== undefined && input.subTransactions !== null;

  if (isTransfer && isSplit) {
    throw new RecurringError("recurring cannot be both a transfer and a split");
  }

  const effectiveTransferAccountId =
    input.transferAccountId !== undefined
      ? (input.transferAccountId != null ? Number(input.transferAccountId) : null)
      : undefined;
  const effectiveAccountId =
    input.accountId !== undefined
      ? (input.accountId != null ? Number(input.accountId) : null)
      : undefined;

  if (isTransfer && effectiveAccountId != null && effectiveTransferAccountId === effectiveAccountId) {
    throw new RecurringError("transfer account must differ from source account");
  }

  const explicitCategoryId = input.categoryId;
  const effectiveCategoryId =
    isSplit
      ? null
      : explicitCategoryId !== undefined
        ? explicitCategoryId != null
          ? Number(explicitCategoryId)
          : null
        : undefined;

  const subTransactions = isSplit
    ? (input.subTransactions as TxnSubTransactionInput[])
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
  const validatedNextDate = assertValidISODate(input.nextDate, "nextDate");
  if (norm.isSplit) {
    assertSplitsBalanced(validatedAmount, norm.subTransactions!);
    for (const c of norm.subTransactions!) {
      if (c.transferAccountId != null && Number(c.transferAccountId) === Number(input.accountId)) {
        throw new RecurringError("transfer account must differ from source account");
      }
    }
  }

  return withTransaction(db, async () => {
    const srcOnBudget = await isAccountOnBudget(db, input.accountId);
    let categoryId: number | null = null;

    if (norm.isSplit) {
      categoryId = null;
    } else if (norm.isTransfer && norm.effectiveTransferAccountId != null) {
      const destOnBudget = await isAccountOnBudget(db, norm.effectiveTransferAccountId);
      const classification = classifyBoundaryTransfer({
        srcOnBudget,
        destOnBudget,
        amount: validatedAmount,
        categoryId: norm.effectiveCategoryId,
        errorFactory: (msg) => new RecurringError(msg, 422),
      });
      categoryId = classification.categoryId;
    } else if (!srcOnBudget) {
      categoryId = null;
    } else {
      categoryId = norm.effectiveCategoryId ?? null;
    }

    const anchorDay =
      input.anchorDay !== undefined && input.anchorDay !== null
        ? Number(input.anchorDay)
        : parseInt(validatedNextDate.slice(8, 10), 10);

    const [parent] = await db
      .insert(recurring)
      .values({
        accountId: input.accountId,
        categoryId,
        payee: input.payee,
        memo: input.memo ?? "",
        amount: validatedAmount,
        frequency: validatedFrequency,
        nextDate: validatedNextDate,
        anchorDay,
        active: input.active ?? true,
        flagColor: sanitizeFlagColor(input.flagColor),
        transferAccountId: norm.effectiveTransferAccountId ?? null,
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
          const classification = classifyBoundaryTransfer({
            srcOnBudget,
            destOnBudget,
            amount: childAmount,
            categoryId: c.categoryId ? Number(c.categoryId) : null,
            errorFactory: (msg) => new RecurringError(msg, 422),
          });
          categoryId = classification.categoryId;
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

    return parent;
  });
}

export async function updateRecurring(db: Database, id: number, patch: UpdateRecurringInput) {
  // Read the existing row to support rules that depend on the current state.
  const [existing] = await db.select().from(recurring).where(eq(recurring.id, id));
  if (!existing) return null;

  const norm = normaliseInput(patch);

  const effectiveAccountId =
    patch.accountId !== undefined && patch.accountId != null
      ? Number(patch.accountId)
      : existing.accountId;

  const effectiveTransferAccountId =
    patch.transferAccountId !== undefined
      ? (norm.effectiveTransferAccountId ?? null)
      : existing.transferAccountId;

  const isTransfer = effectiveTransferAccountId != null;

  if (isTransfer && effectiveTransferAccountId === effectiveAccountId) {
    throw new RecurringError("transfer account must differ from source account");
  }

  // Validate split children if supplied.
  if (norm.isSplit) {
    const parentAmount =
      patch.amount !== undefined && patch.amount != null
        ? assertValidAmount(patch.amount)
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
    patch.subTransactions === undefined &&
    patch.amount !== undefined &&
    patch.amount != null
  ) {
    const existingChildren = await db
      .select()
      .from(recurringSubTransactions)
      .where(eq(recurringSubTransactions.recurringId, id));
    if (existingChildren.length > 0) {
      assertSplitsBalanced(assertValidAmount(patch.amount), existingChildren);
    }
  }

  const effectiveAmount =
    patch.amount !== undefined && patch.amount != null
      ? assertValidAmount(patch.amount)
      : Number(existing.amount);

  const p: Record<string, unknown> = {};
  if (patch.accountId !== undefined && patch.accountId != null) p.accountId = Number(patch.accountId);
  if (patch.payee !== undefined && patch.payee != null) p.payee = String(patch.payee);
  if (patch.memo !== undefined) p.memo = String(patch.memo ?? "");
  if (patch.amount !== undefined && patch.amount != null) p.amount = effectiveAmount;
  if (patch.frequency !== undefined && patch.frequency != null) p.frequency = assertValidFrequency(patch.frequency);
  if (patch.nextDate !== undefined && patch.nextDate != null) p.nextDate = assertValidISODate(patch.nextDate, "nextDate");
  const effectiveFreq = p.frequency !== undefined ? String(p.frequency) : existing.frequency;
  if (patch.anchorDay !== undefined) {
    if (patch.anchorDay === null) {
      if (isMonthBasedFrequency(effectiveFreq)) {
        throw new RecurringError("anchorDay cannot be null for month-based frequencies", 422);
      }
      p.anchorDay = null;
    } else {
      const numAnchor = Math.floor(Number(patch.anchorDay));
      if (isNaN(numAnchor) || numAnchor < 1 || numAnchor > 31) {
        throw new RecurringError("anchorDay must be an integer between 1 and 31", 422);
      }
      p.anchorDay = numAnchor;
    }
  } else if (p.frequency !== undefined && isMonthBasedFrequency(effectiveFreq) && existing.anchorDay == null) {
    const dateForAnchor = (p.nextDate as string | undefined) ?? existing.nextDate;
    p.anchorDay = parseInt(dateForAnchor.slice(8, 10), 10);
  }
  if (patch.active !== undefined && patch.active != null) p.active = !!patch.active;
  if (patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if (patch.transferAccountId !== undefined) p.transferAccountId = norm.effectiveTransferAccountId ?? null;

  return withTransaction(db, async () => {
    const targetAccountId = (p.accountId as number | undefined) ?? existing.accountId;
    const srcOnBudget = await isAccountOnBudget(db, targetAccountId);

    if (norm.isSplit) {
      p.transferAccountId = null;
      p.categoryId = null;
    } else if (isTransfer) {
      const destOnBudget = await isAccountOnBudget(db, effectiveTransferAccountId!);
      const candidateCatId =
        patch.categoryId !== undefined && norm.effectiveCategoryId !== undefined
          ? norm.effectiveCategoryId
          : existing.categoryId;

      const classification = classifyBoundaryTransfer({
        srcOnBudget,
        destOnBudget,
        amount: effectiveAmount,
        categoryId: candidateCatId,
        errorFactory: (msg) => new RecurringError(msg, 422),
      });
      p.categoryId = classification.categoryId;
    } else if (!srcOnBudget) {
      p.categoryId = null;
    } else if (patch.categoryId !== undefined && norm.effectiveCategoryId !== undefined) {
      p.categoryId = norm.effectiveCategoryId;
    }

    if (Object.keys(p).length > 0) {
      await db.update(recurring).set(p).where(eq(recurring.id, id));
    }

    if ((patch.transferAccountId !== undefined && norm.isTransfer) || (patch.subTransactions !== undefined)) {
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
            const classification = classifyBoundaryTransfer({
              srcOnBudget,
              destOnBudget,
              amount: childAmount,
              categoryId: c.categoryId ? Number(c.categoryId) : null,
              errorFactory: (msg) => new RecurringError(msg, 422),
            });
            categoryId = classification.categoryId;
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
    return row ?? null;
  });
}

export async function deleteRecurring(db: Database, id: number): Promise<boolean> {
  return withTransaction(db, async () => {
    const deleted = await db.delete(recurring).where(and(eq(recurring.id, id))).returning({ id: recurring.id });
    return Boolean(deleted && deleted.length > 0);
  });
}

/**
 * Materialize a recurring transaction into a real transaction row with full
 * split and transfer integrity, using the scheduled nextDate (or specified postDate),
 * and advance the scheduled nextDate according to its frequency.
 */
export async function postRecurringTransaction(
  db: Database,
  recurringId: number,
  postDate?: string,
  allowEarly = false
) {
  const validatedPostDate = postDate ? assertValidISODate(postDate, "date") : undefined;
  return withTransaction(db, async () => {
    const [r] = await db.select().from(recurring).where(eq(recurring.id, recurringId));
    if (!r) throw new RecurringError("Recurring transaction not found", 404);
    if (!r.active) throw new RecurringError("Recurring transaction is inactive", 400);
    if (!allowEarly && validatedPostDate && validatedPostDate < r.nextDate) {
      throw new RecurringError(`Recurring transaction occurrence for ${validatedPostDate} has already been posted`, 409);
    }
    const dateToUse = validatedPostDate || r.nextDate;
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
        memo: r.memo || "",
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
          memo: r.memo || "",
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
        memo: r.memo || "",
        amount: Number(r.amount),
        status: "c",
        transferAccountId: null,
        flagColor: sanitizeFlagColor(r.flagColor),
      });
    }

    const normFreq = (r.frequency || "").toLowerCase().replace(/[\s_-]+/g, "");
    const isOneOff = normFreq === "never" || normFreq === "once";
    const anchor = r.anchorDay ?? parseInt(r.nextDate.slice(8, 10), 10);
    const next = nextDateFor(r.frequency, r.nextDate, anchor);
    const updatePayload: { nextDate: string; active?: boolean; anchorDay?: number } = { nextDate: next };
    if (isOneOff) {
      updatePayload.active = false;
    }
    if (r.anchorDay == null && isMonthBasedFrequency(r.frequency)) {
      updatePayload.anchorDay = anchor;
    }
    const [updated] = await db
      .update(recurring)
      .set(updatePayload)
      .where(
        and(
          eq(recurring.id, r.id),
          eq(recurring.nextDate, r.nextDate),
          eq(recurring.active, true)
        )
      )
      .returning();

    if (!updated) {
      throw new RecurringError("Recurring transaction schedule mismatch or inactive", 409);
    }

    return { transaction: postedTxn, nextDate: next, active: isOneOff ? false : r.active };
  });
}

export type AutoPostFailure = {
  id: number;
  payee: string;
  error: string;
};

export type AutoPostCapped = {
  id: number;
  payee: string;
  remainingDue: number;
};

/**
 * Automatically materialize all active recurring transactions whose nextDate <= asOfDate.
 * Each due rule is isolated so that a single corrupted or un-postable rule
 * does not block or roll back valid due rules. Failing rules are recorded in
 * failures and marked inactive (active = false).
 * Catch-up occurrences are capped per rule (default maxOccurrencesPerRule: 5) to prevent
 * runaway mass materialization when databases are opened after long gaps.
 */
export async function autoPostDueRecurringTransactions(
  db: Database,
  asOfDate: string = todayISO(),
  options?: { maxOccurrencesPerRule?: number }
) {
  const validatedAsOfDate = assertValidISODate(asOfDate, "asOfDate");
  const due = await db
    .select()
    .from(recurring)
    .where(and(eq(recurring.active, true), sql`${recurring.nextDate} <= ${validatedAsOfDate}`));

  const posted: any[] = [];
  const failures: AutoPostFailure[] = [];
  const capped: AutoPostCapped[] = [];
  const maxPerRule = options?.maxOccurrencesPerRule !== undefined ? options.maxOccurrencesPerRule : 5;
  // In-process idempotency guard: prevents re-attempting the same (ruleId, nextDate)
  // within a single call, which can happen when concurrent callers race and
  // the loser receives a 409 and should re-read rather than retry.
  const attemptedKeys = new Set<string>();

  for (const r of due) {
    let currentNextDate = r.nextDate;
    let occurrencesForThisRule = 0;
    while (currentNextDate <= validatedAsOfDate) {
      const key = `${r.id}:${currentNextDate}`;
      if (attemptedKeys.has(key)) break;
      attemptedKeys.add(key);

      if (maxPerRule > 0 && occurrencesForThisRule >= maxPerRule) {
        capped.push({
          id: r.id,
          payee: r.payee,
          remainingDue: 1,
        });
        break;
      }
      try {
        const res = await postRecurringTransaction(db, r.id, currentNextDate);
        posted.push(res.transaction);
        occurrencesForThisRule++;
        if (!res.active || res.nextDate <= currentNextDate) break;
        currentNextDate = res.nextDate;
      } catch (err: any) {
        const isConcurrency409 = err instanceof RecurringError && err.status === 409;
        failures.push({
          id: r.id,
          payee: r.payee,
          error: err instanceof Error ? err.message : String(err),
        });
        // 409 = schedule mismatch / already posted (concurrent runner won).
        // Do NOT deactivate — the rule is healthy, just beat by another process.
        if (!isConcurrency409) {
          // Deactivate the broken recurring rule so it doesn't repeatedly fail on every cycle
          try {
            await db
              .update(recurring)
              .set({ active: false })
              .where(eq(recurring.id, r.id));
          } catch {
            // Ignore secondary update errors
          }
        }
        break;
      }
    }
  }

  (posted as any).failures = failures;
  (posted as any).capped = capped;
  return posted;
}

export const createRecurringTransaction = createRecurring;
export const updateRecurringTransaction = updateRecurring;


