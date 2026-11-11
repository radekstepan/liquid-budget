import type { ClearedStatus, TransactionFlagColor } from "@ynab/logic";
import { classifyBoundaryTransfer, inferUncategorizedInflowIncome, TransactionError } from "@ynab/logic";
import { assertEntityInvariants } from "../../invariants.js";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { transactions } from "../../schema.js";
import { assertValidISODate, assertValidISOMonth, assertValidAmount, sanitizeFlagColor } from "./validation.js";
import { getAccountInfo, getTransferTargetInfo, closedAccountMessage } from "./accounts.js";
import { applyBalance, getAccountName, assertSplitsBalancedOr4xx } from "./shared.js";
import type { CreateTransactionInput, SubTransactionInput } from "./types.js";

export async function createTransaction(db: Database, input: CreateTransactionInput) {
  const amount = assertValidAmount(input.amount);
  assertValidISODate(input.date, "date");
  if (input.incomeMonth) {
    assertValidISOMonth(input.incomeMonth, "incomeMonth");
  }
  if (input.status === "r" || input.transferStatus === "r") {
    throw new TransactionError(
      "cannot directly create a reconciled transaction; use the reconcile flow"
    );
  }
  const isSplitParent = input.parentId == null && input.skipBalance === true;
  assertEntityInvariants({
    accountId: input.accountId,
    transferAccountId: input.transferAccountId,
    parentId: input.parentId,
    subTransactions: isSplitParent && input.transferAccountId != null ? [{ amount }] : undefined,
  });
  if (input.transferAccountId != null) {
    if (input.transferAccountId === input.accountId) {
      throw new TransactionError("transfer account must differ from source account");
    }
    if (input.parentId == null) {
      return createTransfer(db, { ...input, amount }, input.transferAccountId);
    }
  }

  let payee = input.payee ?? "";
  if (input.transferAccountId != null && !payee.trim()) {
    const destName = await getAccountName(db, input.transferAccountId);
    payee = `Transfer : ${destName ?? "Unknown"}`;
  }

  return withTransaction(db, async () => {
    const srcAccount = await getAccountInfo(db, input.accountId);
    const closedSrc = closedAccountMessage(srcAccount, input.accountId);
    if (closedSrc) {
      throw new TransactionError(closedSrc, 422);
    }
    const onBudget = srcAccount?.onBudget ?? true;
    const kind = srcAccount?.kind ?? "liquid";
    const isTransfer = input.transferAccountId != null;

    let categoryId: number | null = null;
    let isIncome = false;
    let incomeMonth: string | null = null;

    if (isSplitParent) {
      categoryId = null;
      isIncome = false;
      incomeMonth = null;
    } else if (isTransfer) {
      const destInfo = await getTransferTargetInfo(db, input.transferAccountId!);
      const closedDest = closedAccountMessage(destInfo, input.transferAccountId!);
      if (closedDest) {
        throw new TransactionError(closedDest, 422);
      }
      const destOnBudget = destInfo?.onBudget ?? true;
      const classification = classifyBoundaryTransfer({
        srcOnBudget: onBudget,
        destOnBudget,
        amount,
        categoryId: input.categoryId,
        incomeMonth: input.incomeMonth,
      });
      categoryId = classification.categoryId;
      isIncome = classification.isIncome;
      incomeMonth = classification.incomeMonth;
    } else if (!onBudget) {
      categoryId = null;
      isIncome = false;
      incomeMonth = null;
    } else if (kind === "credit") {
      categoryId = input.categoryId ?? null;
      isIncome = false;
      incomeMonth = null;
    } else {
      categoryId = input.categoryId ?? null;
      // Uncategorized positive inflows default to income on liquid
      // on-budget accounts (shared helper — see optimistic planner).
      const inferred = inferUncategorizedInflowIncome({
        categoryId,
        amountCents: amount,
        explicitIsIncome: input.isIncome !== undefined ? Boolean(input.isIncome) : undefined,
        incomeMonth: input.incomeMonth ?? null,
      });
      isIncome = inferred.isIncome;
      incomeMonth = inferred.incomeMonth;
    }

    const [row] = await db
      .insert(transactions)
      .values({
        ...(input.id != null ? { id: input.id } : {}),
        accountId: input.accountId,
        categoryId,
        date: input.date,
        payee,
        memo: input.memo ?? "",
        amount,
        status: input.status ?? "c",
        transferStatus: input.transferAccountId != null ? (input.transferStatus ?? input.status ?? "c") : null,
        flagColor: sanitizeFlagColor(input.flagColor),
        transferAccountId: input.transferAccountId ?? null,
        parentId: input.parentId ?? null,
        isIncome,
        incomeMonth,
        needsReview: input.needsReview ?? false,
        entityId: input.entityId ?? null,
      })
      .returning();

    // Children and regular rows apply their own balance; split parents do not.
    // `skipBalance` is only honoured for parents (parentId == null). Children
    // always apply their own balance, regardless of any `skipBalance` flag.
    if (!isSplitParent) {
      await applyBalance(db, input.accountId, amount);
      if (input.transferAccountId != null) {
        await applyBalance(db, input.transferAccountId, -amount);
      }
    }
    return row;
  });
}

/**
 * Insert a transfer row and update both account balances. The row
 * stores the source account and the destination via `transferAccountId`;
 * YNAB4's convention is a single row per transfer (the destination's
 * register sees the same transfer via the `transferAccountId` linkage).
 */

export async function createTransfer(
  db: Database,
  baseInput: CreateTransactionInput,
  transferAccountId?: number
) {
  const destAccountId = transferAccountId ?? (baseInput.transferAccountId != null ? Number(baseInput.transferAccountId) : undefined);
  if (destAccountId == null) {
    throw new TransactionError("transfer requires a transferAccountId");
  }
  const amount = assertValidAmount(baseInput.amount);
  if (baseInput.status === "r" || baseInput.transferStatus === "r") {
    throw new TransactionError(
      "cannot directly create a reconciled transaction; use the reconcile flow"
    );
  }
  assertEntityInvariants({
    accountId: baseInput.accountId,
    transferAccountId: destAccountId,
    parentId: baseInput.parentId,
  });
  if (destAccountId === baseInput.accountId) {
    throw new TransactionError("transfer account must differ from source account");
  }

  let payee = baseInput.payee || "";
  if (!payee.trim()) {
    const destName = await getAccountName(db, destAccountId);
    payee = `Transfer : ${destName ?? "Unknown"}`;
  }

  return withTransaction(db, async () => {
    const srcInfo = await getAccountInfo(db, baseInput.accountId);
    const closedSrc = closedAccountMessage(srcInfo, baseInput.accountId);
    if (closedSrc) {
      throw new TransactionError(closedSrc, 422);
    }
    const destInfo = await getTransferTargetInfo(db, destAccountId);
    const closedDest = closedAccountMessage(destInfo, destAccountId);
    if (closedDest) {
      throw new TransactionError(closedDest, 422);
    }
    const srcOnBudget = srcInfo?.onBudget ?? true;
    const destOnBudget = destInfo?.onBudget ?? true;
    const classification = classifyBoundaryTransfer({
      srcOnBudget,
      destOnBudget,
      amount,
      categoryId: baseInput.categoryId,
      incomeMonth: baseInput.incomeMonth,
    });
    const categoryId = classification.categoryId;
    const isIncome = classification.isIncome;
    const incomeMonth = classification.incomeMonth;

    const [row] = await db
      .insert(transactions)
      .values({
        ...(baseInput.id != null ? { id: baseInput.id } : {}),
        accountId: baseInput.accountId,
        categoryId,
        date: baseInput.date,
        payee,
        memo: baseInput.memo,
        amount,
        status: baseInput.status ?? "c",
        transferStatus: baseInput.transferStatus ?? baseInput.status ?? "c",
        flagColor: sanitizeFlagColor(baseInput.flagColor),
        transferAccountId: destAccountId,
        parentId: baseInput.parentId ?? null,
        isIncome,
        incomeMonth,
        needsReview: baseInput.needsReview ?? false,
        entityId: baseInput.entityId ?? null,
      })
      .returning();

    await applyBalance(db, baseInput.accountId, amount);
    await applyBalance(db, destAccountId, -amount);
    return row;
  });
}

/**
 * Atomically create a split parent + N sub-rows. The parent's amount
 * is informational (matches the sum of children) and is NOT applied
 * to balance; only the children are. Returns the parent and children
 * rows in their inserted order.
 */

export async function createSplitWithChildren(
  db: Database,
  parent: {
    accountId: number;
    date: string;
    payee: string;
    memo: string;
    amount: number;
    status?: ClearedStatus;
    flagColor?: TransactionFlagColor | null;
    needsReview?: boolean;
    /** Explicit parent row id — scheduled-posting re-post reuse only. */
    id?: number | null;
    /** Deterministic entity id — scheduled-posting path only. */
    entityId?: string | null;
    /** Rejected for splits, but checked defensively for untyped callers. */
    transferAccountId?: number | null;
  },
  children: SubTransactionInput[]
) {
  const parentAmount = assertValidAmount(parent.amount);
  assertValidISODate(parent.date, "date");
  assertSplitsBalancedOr4xx(parentAmount, children);

  const parentStatus = parent.status ?? "c";
  if (parentStatus === "r") {
    throw new TransactionError(
      "cannot directly create a reconciled transaction; use the reconcile flow"
    );
  }

  assertEntityInvariants({
    accountId: parent.accountId,
    transferAccountId: parent.transferAccountId ?? null,
    subTransactions: children,
  });

  for (const c of children) {
    if (c.transferStatus === "r") {
      throw new TransactionError(
        "cannot directly create a reconciled transaction; use the reconcile flow"
      );
    }
    if (c.transferAccountId != null) {
      assertEntityInvariants({
        accountId: parent.accountId,
        transferAccountId: Number(c.transferAccountId),
      });
    }
    if (c.transferAccountId != null && Number(c.transferAccountId) === parent.accountId) {
      throw new TransactionError("transfer account must differ from source account");
    }
  }

  return withTransaction(db, async () => {
    const [parentRow] = await db
      .insert(transactions)
      .values({
        ...(parent.id != null ? { id: parent.id } : {}),
        accountId: parent.accountId,
        categoryId: null,
        date: parent.date,
        payee: parent.payee,
        memo: parent.memo,
        amount: parentAmount,
        status: parentStatus,
        flagColor: sanitizeFlagColor(parent.flagColor),
        transferAccountId: null,
        parentId: null,
        isIncome: false,
        needsReview: parent.needsReview ?? false,
        entityId: parent.entityId ?? null,
      })
      .returning();

    const srcAccount = await getAccountInfo(db, parent.accountId);
    const closedSrc = closedAccountMessage(srcAccount, parent.accountId);
    if (closedSrc) {
      throw new TransactionError(closedSrc, 422);
    }
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";
    const childRows = [];
    for (const c of children) {
      const childAmount = assertValidAmount(c.amount);
      let payee = c.payee !== undefined && c.payee !== null && c.payee !== "" ? String(c.payee) : parent.payee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      let categoryId = c.categoryId ? Number(c.categoryId) : null;
      let isIncome = false;

      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
        const destInfo = await getTransferTargetInfo(db, transferAccountId);
        const closedDest = closedAccountMessage(destInfo, transferAccountId);
        if (closedDest) {
          throw new TransactionError(closedDest, 422);
        }
        const destOnBudget = destInfo?.onBudget ?? true;
        const classification = classifyBoundaryTransfer({
          srcOnBudget,
          destOnBudget,
          amount: childAmount,
          categoryId,
          incomeMonth: null,
        });
        categoryId = classification.categoryId;
        isIncome = classification.isIncome;
      } else {
        if (!srcOnBudget) {
          categoryId = null;
          isIncome = false;
        } else if (srcKind === "credit") {
          categoryId = c.categoryId ? Number(c.categoryId) : null;
          isIncome = false;
        } else {
          isIncome = inferUncategorizedInflowIncome({
            categoryId,
            amountCents: childAmount,
          }).isIncome;
        }
      }

      const [child] = await db
        .insert(transactions)
        .values({
          accountId: parent.accountId,
          categoryId,
          date: parent.date,
          payee,
          // Children inherit the parent's memo unless they have their own
          // (mirrors updateSplit; an explicit "" stays empty).
          memo: c.memo ?? parent.memo ?? "",
          amount: childAmount,
          status: parentStatus,
          transferStatus: transferAccountId ? (c.transferStatus ?? parentStatus) : null,
          transferAccountId,
          parentId: parentRow!.id,
          isIncome,
        })
        .returning();
      await applyBalance(db, parent.accountId, childAmount);
      if (transferAccountId) {
        await applyBalance(db, transferAccountId, -childAmount);
      }
      childRows.push(child);
    }
    return { parent: parentRow, children: childRows };
  });
}

/**
 * Update a single transaction. Restrictions:
 *   - `parentId` is immutable after creation (split structure is set at
 *     insert time).
 *   - Split parents may not change `amount` (derived from children) or
 *     `accountId` (the whole split lives on one account).
 *   - Split children may not change `accountId` (the whole split lives on
 *     one account).
 *   - Transfers may change `transferAccountId` (re-routes both source
 *     and destination balances).
 *
 * Balance accounting:
 *   - regular: reverse old, apply new
 *   - child of a split: reverse old, apply new (own balance only)
 *   - split parent: no balance effect
 *   - transfer: reverse both source and destination, then apply both
 */
