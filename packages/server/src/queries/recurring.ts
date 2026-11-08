import { and, eq, sql } from "drizzle-orm";
import {
  assertSplitsBalanced,
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
import { recurring, recurringSubTransactions, scheduledPostings, transactions } from "../schema.js";
import {
  createSplitWithChildren,
  createTransaction,
  closedAccountMessage,
  getAccountInfo,
  getTransferTargetInfo,
  assertValidAmount,
  sanitizeFlagColor,
  TransactionError,
  assertEntityInvariants,
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
  /**
   * Frozen YNAB4 `twiceAMonthStartDay` for twice-a-month schedules
   * (`ScheduledTransactionVO`, G-08). Pins the first leg while posting
   * (YNAB4 freezes it via `updateTwiceAMonthStartDay = false`); the
   * importer writes it verbatim and the exporter reads it back. When
   * omitted on a twice-a-month create it is derived from `nextDate`
   * (`day <= 15 ? day : day - 15`, mirroring
   * `resetTwiceAMonthStartDay`); ignored for other frequencies.
   */
  secondAnchorDay?: number | null;
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
  /**
   * Explicit override of the frozen twice-a-month start day (see
   * `CreateRecurringInput.secondAnchorDay`). Omit to leave it alone,
   * except that hand-editing `nextDate` on a twice-a-month rule
   * re-derives it from the new date and switching frequency away from
   * twice-a-month clears it — both mirroring YNAB4's
   * `resetTwiceAMonthStartDay`.
   */
  secondAnchorDay?: number | null;
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
 * Validate a set of recurring sub-transactions. The rules are
 * single-sourced in `@ynab/logic`'s `assertSplitsBalanced` (BUG-18.3);
 * this wrapper only converts the thrown error into a `RecurringError`
 * so API routes surface it as a 4xx response.
 */
function assertSplitsBalancedOr4xx(
  parentAmount: number,
  children: TxnSubTransactionInput[]
): void {
  assertSplitsBalanced(parentAmount, children, (message) => new RecurringError(message, 400));
}

function normaliseFrequency(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

function isTwiceAMonthFrequency(value: unknown): boolean {
  const norm = normaliseFrequency(value);
  return norm === "twiceamonth" || norm === "semimonthly";
}

/**
 * YNAB4 `ScheduledTransaction.resetTwiceAMonthStartDay`: derive the frozen
 * twice-a-month start day from a date (`day <= 15 ? day : day - 15`).
 */
function deriveTwiceAMonthStartDay(dateISO: string): number {
  const day = parseInt(dateISO.slice(8, 10), 10);
  return day <= 15 ? day : day - 15;
}

function assertValidSecondAnchorDay(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 31) {
    throw new RecurringError("secondAnchorDay must be an integer between 1 and 31", 422);
  }
  return n;
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

  const effectiveTransferAccountId =
    input.transferAccountId !== undefined
      ? (input.transferAccountId != null ? Number(input.transferAccountId) : null)
      : undefined;
  const effectiveAccountId =
    input.accountId !== undefined
      ? (input.accountId != null ? Number(input.accountId) : null)
      : undefined;

  const subTransactions = isSplit
    ? (input.subTransactions as TxnSubTransactionInput[])
    : undefined;

  assertEntityInvariants({
    accountId: effectiveAccountId,
    transferAccountId: effectiveTransferAccountId,
    subTransactions,
  });

  const explicitCategoryId = input.categoryId;
  const effectiveCategoryId =
    isSplit
      ? null
      : explicitCategoryId !== undefined
        ? explicitCategoryId != null
          ? Number(explicitCategoryId)
          : null
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
    assertSplitsBalancedOr4xx(validatedAmount, norm.subTransactions!);
    for (const c of norm.subTransactions!) {
      if (c.transferAccountId != null) {
        assertEntityInvariants({
          accountId: input.accountId,
          transferAccountId: Number(c.transferAccountId),
        });
      }
    }
  }
  return withTransaction(db, async () => {
    const srcInfo = await getAccountInfo(db, input.accountId);
    const closedSrc = closedAccountMessage(srcInfo, input.accountId);
    if (closedSrc) {
      throw new RecurringError(closedSrc, 422);
    }
    const srcOnBudget = srcInfo?.onBudget ?? true;
    let categoryId: number | null = null;

    if (norm.isSplit) {
      categoryId = null;
    } else if (norm.isTransfer && norm.effectiveTransferAccountId != null) {
      const destInfo = await getTransferTargetInfo(db, norm.effectiveTransferAccountId);
      const closedDest = closedAccountMessage(destInfo, norm.effectiveTransferAccountId);
      if (closedDest) {
        throw new RecurringError(closedDest, 422);
      }
      const destOnBudget = destInfo?.onBudget ?? true;
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

    // Freeze the twice-a-month start day at create time (YNAB4 derives it
    // from the date and then pins it while posting). An explicit value is
    // validated; otherwise it derives from `nextDate`. Other frequencies
    // never carry one.
    let secondAnchorDay: number | null = null;
    if (isTwiceAMonthFrequency(validatedFrequency)) {
      secondAnchorDay =
        input.secondAnchorDay !== undefined && input.secondAnchorDay !== null
          ? assertValidSecondAnchorDay(input.secondAnchorDay)
          : deriveTwiceAMonthStartDay(validatedNextDate);
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
        nextDate: validatedNextDate,
        anchorDay,
        secondAnchorDay,
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
          const destInfo = await getTransferTargetInfo(db, transferAccountId);
          const closedDest = closedAccountMessage(destInfo, transferAccountId);
          if (closedDest) {
            throw new RecurringError(closedDest, 422);
          }
          const destOnBudget = destInfo?.onBudget ?? true;
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

  assertEntityInvariants({
    accountId: effectiveAccountId,
    transferAccountId: effectiveTransferAccountId,
    subTransactions: norm.isSplit ? norm.subTransactions : undefined,
  });

  // Moving a schedule (or its transfer leg) onto a closed account is blocked
  // at post time below; pure field edits on closed-account schedules stay
  // allowed (e.g. deactivating). Replaced split children introduce new
  // destinations, so those are always checked.
  const movesAccount =
    patch.accountId !== undefined && patch.accountId != null && Number(patch.accountId) !== existing.accountId;
  const movesTransfer =
    patch.transferAccountId !== undefined &&
    (norm.effectiveTransferAccountId ?? null) !== existing.transferAccountId;

  // Validate split children if supplied.
  if (norm.isSplit) {
    const parentAmount =
      patch.amount !== undefined && patch.amount != null
        ? assertValidAmount(patch.amount)
        : assertValidAmount(existing.amount);
    assertSplitsBalancedOr4xx(parentAmount, norm.subTransactions!);
    for (const c of norm.subTransactions!) {
      if (c.transferAccountId != null) {
        assertEntityInvariants({
          accountId: effectiveAccountId,
          transferAccountId: Number(c.transferAccountId),
        });
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
      assertSplitsBalancedOr4xx(assertValidAmount(patch.amount), existingChildren);
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
  } else if (isMonthBasedFrequency(effectiveFreq)) {
    if (patch.nextDate !== undefined) {
      const newDay = parseInt((p.nextDate as string).slice(8, 10), 10);
      if (existing.anchorDay == null || newDay > existing.anchorDay) {
        p.anchorDay = newDay;
      }
    } else if (p.frequency !== undefined && existing.anchorDay == null) {
      const dateForAnchor = (p.nextDate as string | undefined) ?? existing.nextDate;
      p.anchorDay = parseInt(dateForAnchor.slice(8, 10), 10);
    }
  }
  if (patch.secondAnchorDay !== undefined) {
    p.secondAnchorDay =
      patch.secondAnchorDay === null ? null : assertValidSecondAnchorDay(patch.secondAnchorDay);
  } else if (isTwiceAMonthFrequency(effectiveFreq)) {
    if (
      patch.nextDate !== undefined ||
      (patch.frequency !== undefined && existing.secondAnchorDay == null)
    ) {
      const dateForDerive = (p.nextDate as string | undefined) ?? existing.nextDate;
      p.secondAnchorDay = deriveTwiceAMonthStartDay(dateForDerive);
    }
  } else if (patch.frequency !== undefined) {
    p.secondAnchorDay = null;
  }
  if (patch.active !== undefined && patch.active != null) p.active = !!patch.active;
  if (patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if (patch.transferAccountId !== undefined) p.transferAccountId = norm.effectiveTransferAccountId ?? null;

  return withTransaction(db, async () => {
    const targetAccountId = (p.accountId as number | undefined) ?? existing.accountId;
    const targetInfo = await getAccountInfo(db, targetAccountId);
    if (movesAccount) {
      const closedTarget = closedAccountMessage(targetInfo, targetAccountId);
      if (closedTarget) {
        throw new RecurringError(closedTarget, 422);
      }
    }
    const srcOnBudget = targetInfo?.onBudget ?? true;

    if (norm.isSplit) {
      p.transferAccountId = null;
      p.categoryId = null;
    } else if (isTransfer) {
      const destInfo = await getTransferTargetInfo(db, effectiveTransferAccountId!);
      if (movesTransfer) {
        const closedDest = closedAccountMessage(destInfo, effectiveTransferAccountId!);
        if (closedDest) {
          throw new RecurringError(closedDest, 422);
        }
      }
      const destOnBudget = destInfo?.onBudget ?? true;
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

    const touchesStructure =
      patch.transferAccountId !== undefined ||
      patch.subTransactions !== undefined ||
      patch.categoryId !== undefined ||
      norm.isSplit ||
      norm.isTransfer;

    if (touchesStructure) {
      await db
        .delete(recurringSubTransactions)
        .where(eq(recurringSubTransactions.recurringId, id));
      if (norm.isSplit && norm.subTransactions) {
        let sort = 0;
        for (const c of norm.subTransactions) {
          const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
          let categoryId: number | null = null;
          const childAmount = assertValidAmount(c.amount);

          if (transferAccountId) {
            const destInfo = await getTransferTargetInfo(db, transferAccountId);
            const closedDest = closedAccountMessage(destInfo, transferAccountId);
            if (closedDest) {
              throw new RecurringError(closedDest, 422);
            }
            const destOnBudget = destInfo?.onBudget ?? true;
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

export async function deleteRecurringSubTransactions(db: Database, recurringId: number): Promise<void> {
  await db
    .delete(recurringSubTransactions)
    .where(eq(recurringSubTransactions.recurringId, recurringId));
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
 *
 * Posted identity is deterministic (YNAB4 `ScheduledTransaction.addToRegister`
 * + `YNABGuidCreator.createTransactionIdForEnteredScheduledTransaction`):
 * the same (schedule, date) occurrence always yields the same entity id
 * (`<schedule>_<yyyy-MM-dd>_<count>`, bumping `count` while taken), and a
 * deleted-then-re-posted occurrence restores the SAME integer row id via the
 * `scheduled_postings` lineage table, which outlives the posted row.
 */
async function isScheduledEntityIdTaken(db: Database, candidate: string): Promise<boolean> {
  // Only the transactions namespace is probed. A posted id
  // (`<schedule>_<date>_<count>`) can never collide with a rule entity id
  // by construction (rule ids come from imports/app state, never from the
  // posted-id mint), so probing `recurring` here would cost an extra query
  // per candidate with no production benefit.
  const [txHit] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.entityId, candidate))
    .limit(1);
  return Boolean(txHit);
}

/**
 * Mint the deterministic posted entity id for a (schedule, date)
 * occurrence: `<scheduleEntityId>_<yyyy-MM-dd>_<count>`, bumping `count`
 * while the id is taken — the integer-PK analogue of YNAB4's
 * `createTransactionIdForEnteredScheduledTransaction`. When re-posting a
 * deleted occurrence, the recorded lineage entity id is preferred so the
 * restored row is byte-identical to the deleted one.
 */
async function claimScheduledEntityId(
  db: Database,
  base: string,
  reusePreferred?: string | null
): Promise<string> {
  if (reusePreferred && !(await isScheduledEntityIdTaken(db, reusePreferred))) {
    return reusePreferred;
  }
  let count = 0;
  for (;;) {
    const candidate = `${base}_${count}`;
    if (!(await isScheduledEntityIdTaken(db, candidate))) return candidate;
    count++;
  }
}

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

    // Deterministic posted identity for this (schedule, date) occurrence.
    // A re-post after delete restores the recorded row id + entity id;
    // a re-post while the row still lives bumps the count suffix, exactly
    // like YNAB4's conflict loop.
    const [lineage] = await db
      .select()
      .from(scheduledPostings)
      .where(
        and(
          eq(scheduledPostings.recurringId, r.id),
          eq(scheduledPostings.occurrenceDate, dateToUse)
        )
      );
    const entityBase = `${r.entityId || `sched-${r.id}`}_${dateToUse}`;
    let reuseId: number | null = null;
    let scheduledEntityId: string;
    if (lineage) {
      const [stillPosted] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.id, lineage.transactionId));
      if (!stillPosted) {
        reuseId = lineage.transactionId;
        scheduledEntityId = await claimScheduledEntityId(db, entityBase, lineage.entityId);
      } else {
        scheduledEntityId = await claimScheduledEntityId(db, entityBase);
      }
    } else {
      scheduledEntityId = await claimScheduledEntityId(db, entityBase);
    }

    let postedTxn;
    let postedParentId: number;
    // Scheduled occurrences enter as Uncleared + needsReview so they
    // stand out in the register (bold, counted as "new") exactly like
    // freshly imported rows, until the user reviews them.
    if (r.transferAccountId != null) {
      postedTxn = await createTransaction(db, {
        id: reuseId,
        entityId: scheduledEntityId,
        accountId: r.accountId,
        categoryId: r.categoryId,
        date: dateToUse,
        payee: r.payee,
        memo: r.memo || "",
        amount: Number(r.amount),
        status: "u",
        needsReview: true,
        transferAccountId: r.transferAccountId,
        flagColor: sanitizeFlagColor(r.flagColor),
      });
      postedParentId = (postedTxn as { id: number }).id;
    } else if (children.length > 0) {
      const splitResult = await createSplitWithChildren(
        db,
        {
          id: reuseId,
          entityId: scheduledEntityId,
          accountId: r.accountId,
          date: dateToUse,
          payee: r.payee,
          memo: r.memo || "",
          amount: Number(r.amount),
          status: "u",
          needsReview: true,
          flagColor: sanitizeFlagColor(r.flagColor),
        },
        children.map((c) => ({
          categoryId: c.categoryId,
          amount: Number(c.amount),
          memo: c.memo || undefined,
          transferAccountId: c.transferAccountId,
        }))
      );
      postedTxn = splitResult;
      postedParentId = splitResult.parent!.id;
    } else {
      postedTxn = await createTransaction(db, {
        id: reuseId,
        entityId: scheduledEntityId,
        accountId: r.accountId,
        categoryId: r.categoryId,
        date: dateToUse,
        payee: r.payee,
        memo: r.memo || "",
        amount: Number(r.amount),
        status: "u",
        needsReview: true,
        transferAccountId: null,
        flagColor: sanitizeFlagColor(r.flagColor),
      });
      postedParentId = (postedTxn as { id: number }).id;
    }

    const normFreq = normaliseFrequency(r.frequency);
    const isOneOff = normFreq === "never" || normFreq === "once";
    const anchor = r.anchorDay ?? parseInt(r.nextDate.slice(8, 10), 10);
    const next = nextDateFor(r.frequency, r.nextDate, anchor, r.secondAnchorDay ?? undefined);
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

    if (!lineage) {
      await db.insert(scheduledPostings).values({
        recurringId: r.id,
        occurrenceDate: dateToUse,
        transactionId: postedParentId,
        entityId: scheduledEntityId,
      });
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

export type AutoPostResult = {
  posted: any[];
  failures: AutoPostFailure[];
  capped: AutoPostCapped[];
};

/**
 * Automatically materialize all active recurring transactions whose nextDate <= asOfDate.
 * Each due rule is isolated so that a single corrupted or un-postable rule
 * does not block or roll back valid due rules. Failing rules are recorded in
 * failures and marked inactive (active = false).
 * Like YNAB4's `enterDueOccurrences`, every due occurrence posts (unbounded
 * by default); pass `maxOccurrencesPerRule` to opt into a per-rule
 * anti-runaway cap, with the parked remainder reported in `capped`.
 */
export async function autoPostDueRecurringTransactions(
  db: Database,
  asOfDate: string = todayISO(),
  options?: { maxOccurrencesPerRule?: number }
): Promise<AutoPostResult> {
  const validatedAsOfDate = assertValidISODate(asOfDate, "asOfDate");
  const due = await db
    .select()
    .from(recurring)
    .where(and(eq(recurring.active, true), sql`${recurring.nextDate} <= ${validatedAsOfDate}`));

  const posted: any[] = [];
  const failures: AutoPostFailure[] = [];
  const capped: AutoPostCapped[] = [];
  const maxPerRule = options?.maxOccurrencesPerRule;
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

      if (maxPerRule != null && maxPerRule > 0 && occurrencesForThisRule >= maxPerRule) {
        let remainingDue = 0;
        let tempDate = currentNextDate;
        const anchor = r.anchorDay ?? parseInt(r.nextDate.slice(8, 10), 10);
        const normFreq = normaliseFrequency(r.frequency);
        const isOneOff = normFreq === "never" || normFreq === "once";
        while (tempDate <= validatedAsOfDate) {
          remainingDue++;
          if (isOneOff) break;
          const nextTemp = nextDateFor(r.frequency, tempDate, anchor, r.secondAnchorDay ?? undefined);
          if (nextTemp <= tempDate) break;
          tempDate = nextTemp;
        }
        capped.push({
          id: r.id,
          payee: r.payee,
          remainingDue,
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
        const isConcurrency409 = (err instanceof RecurringError && err.status === 409) || err?.status === 409;
        const isDomainValidationError =
          (err instanceof RecurringError ||
            err instanceof TransactionError ||
            (typeof err?.status === "number" && err.status >= 400 && err.status < 500)) &&
          !isConcurrency409;

        failures.push({
          id: r.id,
          payee: r.payee,
          error: err instanceof Error ? err.message : String(err),
        });

        // Only deactivate the recurring rule if it is a permanent domain / validation error (4xx client error other than 409).
        // Transient/system errors (e.g. database locks, SQLite busy, IO errors, unexpected runtime exceptions) leave the rule
        // active so it can retry on the next cycle.
        if (isDomainValidationError) {
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

  return {
    posted,
    failures,
    capped,
  };
}

export const createRecurringTransaction = createRecurring;
export const updateRecurringTransaction = updateRecurring;


