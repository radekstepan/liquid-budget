import { eq, or, sql } from "drizzle-orm";
import type {
  BulkUpdateTransactionPatch,
  ClearedStatus,
  TransactionDuplicateFlag,
  TransactionFlagColor,
  TransactionFlagState,
} from "@ynab/logic";
import {
  assertSplitsBalanced,
  classifyBoundaryTransfer,
  isValidISODate,
  isValidISOMonth,
  TRANSACTION_DUPLICATE_FLAG,
  TRANSACTION_FLAG_COLORS,
  TransactionError,
} from "@ynab/logic";
import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
import { accounts, transactions } from "../schema.js";
import { learnRenameRuleFromPayees } from "./rename-rules.js";

export type CreateTransactionInput = {
  accountId: number;
  categoryId?: number | null;
  date: string;
  payee?: string;
  memo?: string;
  amount: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  /** YNAB4-style flag color; null/undefined leaves the row unflagged. */
  flagColor?: TransactionFlagColor | null;
  /**
   * If set, this row is one half of a transfer. The other side is the
   * destination account identified by `transferAccountId`; no row is
   * created there, but its balance is updated in the opposite direction
   * so the destination's running total stays accurate. The `categoryId`
   * is forced to null for transfers.
   */
  transferAccountId?: number | null;
  /**
   * If set, this row is a child of a split transaction. The parent's
   * `amount` is informational (the sum of children) and is not applied
   * to balance; each child IS applied to balance independently.
   */
  parentId?: number | null;
  /**
   * Suppress the balance update for this insert. Used for split parents,
   * whose balance effect is the sum of their children. Has no effect on
   * child rows (children always apply their own balance).
   */
  skipBalance?: boolean;
  isIncome?: boolean;
  incomeMonth?: string | null;
};

export type UpdateTransactionInput = {
  accountId?: number;
  categoryId?: number | null;
  date?: string;
  payee?: string;
  memo?: string;
  amount?: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  isIncome?: boolean;
  incomeMonth?: string | null;
};

export type SubTransactionInput = {
  id?: number | null;
  /**
   * Category or transfer account for the sub-transaction.
   */
  categoryId?: number | null;
  transferAccountId?: number | null;
  transferStatus?: ClearedStatus;
  amount: number;
  memo?: string;
  payee?: string;
};

export { TransactionError };

export function assertValidISODate(date: unknown, fieldName: string = "date"): string {
  if (!isValidISODate(date)) {
    throw new TransactionError(`Invalid calendar date for ${fieldName}: ${date}`, 400);
  }
  return date;
}

export function assertValidISOMonth(month: unknown, fieldName: string = "month"): string {
  if (!isValidISOMonth(month)) {
    throw new TransactionError(`Invalid month format for ${fieldName}: ${month}`, 400);
  }
  return month;
}

export function assertValidAmount(amount: unknown, options: { allowZero?: boolean } = {}): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new TransactionError("Amount must be a valid number", 400);
  }
  if (!Number.isSafeInteger(Math.round(n)) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new TransactionError("Amount exceeds safe integer range", 400);
  }
  const rounded = Math.round(n);
  if (!options.allowZero && rounded === 0) {
    throw new TransactionError("Amount cannot be zero", 400);
  }
  return rounded;
}

/**
 * Coerce an arbitrary value into a valid user-facing flag color (or null).
 * Unknown values — including the internal "duplicate" marker — are treated
 * as "no flag" so rogue payloads never crash the register or trip the DB
 * CHECK. The duplicate marker is never writable through the transaction API.
 */
export function sanitizeFlagColor(value: unknown): TransactionFlagColor | null {
  if (typeof value !== "string") return null;
  return (TRANSACTION_FLAG_COLORS as readonly string[]).includes(value)
    ? (value as TransactionFlagColor)
    : null;
}

/**
 * Read-side coerce that additionally accepts the internal "duplicate"
 * marker the duplicate analyzer writes. Used when loading budget data so
 * the register can render the D badge without crashing on the value.
 */
export function sanitizeFlagState(value: unknown): TransactionFlagState {
  if (typeof value !== "string") return null;
  if (value === TRANSACTION_DUPLICATE_FLAG) return value as TransactionDuplicateFlag;
  return (TRANSACTION_FLAG_COLORS as readonly string[]).includes(value)
    ? (value as TransactionFlagColor)
    : null;
}

async function applyBalance(db: Database, accountId: number, delta: number) {
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${Math.round(delta)}` })
    .where(eq(accounts.id, accountId));
}

async function getAccountName(db: Database, accountId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.name ?? null;
}

export async function isAccountOnBudget(db: Database, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ onBudget: accounts.onBudget })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.onBudget ?? true;
}

export async function getAccountInfo(
  db: Database,
  accountId: number
): Promise<{ onBudget: boolean; kind: string } | null> {
  const [row] = await db
    .select({ onBudget: accounts.onBudget, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) return null;
  const onBudget = row.onBudget ?? true;
  const kind = row.kind ?? (onBudget ? "liquid" : "offbudget");
  return { onBudget, kind };
}

async function childCount(db: Database, parentId: number): Promise<number> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.parentId, parentId));
  return rows.length;
}

async function getChildren(
  db: Database,
  parentId: number
): Promise<{
  id: number;
  accountId: number;
  amount: number;
  transferAccountId: number | null;
  categoryId: number | null;
  memo: string;
  payee: string;
  payeeId: number | null;
  flagColor: string | null;
  status: ClearedStatus;
  transferStatus: ClearedStatus | null;
}[]> {
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      transferAccountId: transactions.transferAccountId,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      payee: transactions.payee,
      payeeId: transactions.payeeId,
      flagColor: transactions.flagColor,
      status: transactions.status,
      transferStatus: transactions.transferStatus,
    })
    .from(transactions)
    .where(eq(transactions.parentId, parentId));
}

/**
 * Validate that a set of sub-transactions constitutes a balanced split.
 * The rules are single-sourced in `@ynab/logic`'s `assertSplitsBalanced`
 * (BUG-18.3); this wrapper only converts the thrown error into a
 * `TransactionError` so API routes surface it as a 4xx response.
 */
function assertSplitsBalancedOr4xx(
  parentAmount: number,
  children: SubTransactionInput[]
): void {
  assertSplitsBalanced(parentAmount, children, (message) => new TransactionError(message, 400));
}

/**
 * Insert a single transaction row. Branches on `transferAccountId` to
 * perform a transfer (one row, mirrored balance updates) versus a plain
 * insert. For a transfer the row's `categoryId` is forced to null and
 * the `payee` is auto-set to "Transfer : <other account name>" if blank.
 *
 * Reconciled status is never set by direct insert — only the reconcile
 * flow may set `"r"`. This keeps a single source of truth for the
 * "lastReconciledAt" account metadata and prevents orphan-R rows.
 */
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
    const onBudget = srcAccount?.onBudget ?? true;
    const kind = srcAccount?.kind ?? "liquid";
    const isSplitParent = input.parentId == null && input.skipBalance === true;
    const isTransfer = input.transferAccountId != null;

    let categoryId: number | null = null;
    let isIncome = false;
    let incomeMonth: string | null = null;

    if (isSplitParent) {
      categoryId = null;
      isIncome = false;
      incomeMonth = null;
    } else if (isTransfer) {
      const destOnBudget = await isAccountOnBudget(db, input.transferAccountId!);
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
      // Uncategorized positive inflow = income, regardless of split
      // nesting — this matches `createSplitWithChildren`'s child
      // semantics (BUG-18.2). Split children honour an explicit
      // `isIncome` override just like top-level rows do.
      const isEligibleForIncome = categoryId == null;
      isIncome = isEligibleForIncome
        ? (input.isIncome !== undefined ? Boolean(input.isIncome) : amount > 0)
        : false;
      incomeMonth = isIncome ? (input.incomeMonth ?? null) : null;
    }

    const [row] = await db
      .insert(transactions)
      .values({
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
  if (destAccountId === baseInput.accountId) {
    throw new TransactionError("transfer account must differ from source account");
  }

  let payee = baseInput.payee || "";
  if (!payee.trim()) {
    const destName = await getAccountName(db, destAccountId);
    payee = `Transfer : ${destName ?? "Unknown"}`;
  }

  return withTransaction(db, async () => {
    const srcOnBudget = await isAccountOnBudget(db, baseInput.accountId);
    const destOnBudget = await isAccountOnBudget(db, destAccountId);
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

  for (const c of children) {
    if (c.transferStatus === "r") {
      throw new TransactionError(
        "cannot directly create a reconciled transaction; use the reconcile flow"
      );
    }
    if (c.transferAccountId != null && Number(c.transferAccountId) === parent.accountId) {
      throw new TransactionError("transfer account must differ from source account");
    }
  }

  return withTransaction(db, async () => {
    const [parentRow] = await db
      .insert(transactions)
      .values({
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
      })
      .returning();

    const srcAccount = await getAccountInfo(db, parent.accountId);
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
        const destOnBudget = await isAccountOnBudget(db, transferAccountId);
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
          isIncome = categoryId == null && childAmount > 0;
        }
      }

      const [child] = await db
        .insert(transactions)
        .values({
          accountId: parent.accountId,
          categoryId,
          date: parent.date,
          payee,
          memo: c.memo ?? "",
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
 *   - Transfers may not change `transferAccountId` (would require
 *     re-routing the mirrored balance). Use delete + recreate.
 *
 * Balance accounting:
 *   - regular: reverse old, apply new
 *   - child of a split: reverse old, apply new (own balance only)
 *   - split parent: no balance effect
 *   - transfer: reverse both source and destination, then apply both
 */
export async function updateTransaction(db: Database, id: number, patch: UpdateTransactionInput) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;

  if (patch.status === "r" || patch.transferStatus === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }

  const touchesStructuralFields =
    patch.accountId !== undefined ||
    patch.categoryId !== undefined ||
    patch.date !== undefined ||
    patch.payee !== undefined ||
    patch.memo !== undefined ||
    patch.amount !== undefined ||
    patch.incomeMonth !== undefined ||
    patch.isIncome !== undefined;

  const isUnreconciling = patch.status === "u";
  const isUnreconcilingTransfer = patch.transferStatus === "u";

  if (existing.status === "r" && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before editing.",
      422
    );
  }

  if (existing.transferStatus === "r" && !isUnreconcilingTransfer && (patch.transferStatus !== undefined || touchesStructuralFields)) {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before editing.",
      422
    );
  }

  if (existing.parentId != null) {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
    if (parent && (parent.status === "r" || parent.transferStatus === "r") && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }
  }

  if ("parentId" in (patch as Record<string, unknown>)) {
    throw new TransactionError("parentId cannot be changed via update");
  }

  if (
    existing.transferAccountId != null &&
    patch.accountId != null &&
    Number(patch.accountId) !== existing.accountId
  ) {
    throw new TransactionError("cannot change account of a transfer; delete and recreate");
  }

  const p: Record<string, unknown> = {};
  if (patch.accountId !== undefined && patch.accountId != null) p.accountId = Number(patch.accountId);
  if (patch.categoryId !== undefined) {
    p.categoryId = patch.categoryId ?? null;
  }
  if (patch.date !== undefined && patch.date != null) p.date = assertValidISODate(patch.date, "date");
  if (patch.payee !== undefined && patch.payee != null) p.payee = String(patch.payee);
  if (patch.memo !== undefined) p.memo = patch.memo == null ? "" : String(patch.memo);
  if (patch.amount !== undefined && patch.amount != null) p.amount = assertValidAmount(patch.amount);
  if (patch.status !== undefined && patch.status != null) {
    p.status = patch.status;
    p.reconciledAt = null;
    p.reconciliationId = null;
  }
  if (patch.transferStatus !== undefined && patch.transferStatus != null) {
    p.transferStatus = patch.transferStatus;
    p.transferReconciledAt = null;
    p.transferReconciliationId = null;
  }
  if (patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if (patch.incomeMonth !== undefined) {
    p.incomeMonth = patch.incomeMonth ? assertValidISOMonth(patch.incomeMonth, "incomeMonth") : null;
  }
  if (patch.isIncome !== undefined) p.isIncome = patch.isIncome;

  let shouldLearnRenameRule = false;
  let oldPayee = "";
  let newPayee = "";

  const row = await withTransaction(db, async () => {
    // Re-read inside the transaction for an authoritative snapshot
    const [current] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!current) return null;

    if (current.status === "r" && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }

    if (current.transferStatus === "r" && !isUnreconcilingTransfer && (patch.transferStatus !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }

    if (current.transferAccountId != null && "accountId" in p && p.accountId !== current.accountId) {
      throw new TransactionError("cannot change account of a transfer; delete and recreate");
    }

    const isParent = current.parentId == null && current.transferAccountId == null;
    const hasChildren = (await childCount(db, id)) > 0;
    const isSplitParent = isParent && hasChildren;

    if (isSplitParent) {
      const children = await getChildren(db, id);
      if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
        throw new TransactionError(
          "Transaction is reconciled and locked. Unreconcile before editing.",
          422
        );
      }
      if ("amount" in p) {
        throw new TransactionError("cannot change amount of a split parent; edit children");
      }
      if ("accountId" in p) {
        throw new TransactionError("cannot change account of a split parent");
      }
    }

    if (current.parentId != null) {
      if ("accountId" in p) {
        throw new TransactionError("cannot change account of a split child");
      }
      if ("amount" in p) {
        throw new TransactionError("cannot change amount of a split child; edit the split");
      }
    }

    const newAccountId = (p.accountId as number | undefined) ?? current.accountId;
    const newAmount = (p.amount as number | undefined) ?? Number(current.amount);

    if (current.transferAccountId != null) {
      await applyBalance(db, current.accountId, -Number(current.amount));
      await applyBalance(db, current.transferAccountId, Number(current.amount));
      await applyBalance(db, newAccountId, newAmount);
      await applyBalance(db, current.transferAccountId, -newAmount);
    } else if (!isSplitParent) {
      if (newAccountId !== current.accountId || newAmount !== Number(current.amount)) {
        await applyBalance(db, current.accountId, -Number(current.amount));
        await applyBalance(db, newAccountId, newAmount);
      }
    }

    const srcAccount = await getAccountInfo(db, newAccountId);
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";
    const destOnBudget =
      current.transferAccountId != null
        ? await isAccountOnBudget(db, current.transferAccountId)
        : null;

    if (current.transferAccountId != null) {
      if (patch.payee !== undefined && !String(patch.payee).trim()) {
        const destName = await getAccountName(db, current.transferAccountId);
        p.payee = `Transfer : ${destName ?? "Unknown"}`;
      }
      const finalCatId = "categoryId" in p ? (p.categoryId as number | null) : current.categoryId;
      const incMonth = "incomeMonth" in p ? (p.incomeMonth as string | null) : (current.incomeMonth ?? null);
      const classification = classifyBoundaryTransfer({
        srcOnBudget,
        destOnBudget: destOnBudget ?? true,
        amount: newAmount,
        categoryId: finalCatId,
        incomeMonth: incMonth,
      });
      p.categoryId = classification.categoryId;
      p.isIncome = classification.isIncome;
      p.incomeMonth = classification.incomeMonth;
    } else if (isSplitParent) {
      p.categoryId = null;
      p.isIncome = false;
      p.incomeMonth = null;
    } else if (!srcOnBudget) {
      p.categoryId = null;
      p.incomeMonth = null;
      p.isIncome = false;
    } else if (srcKind === "credit") {
      if ("categoryId" in p) {
        p.categoryId = p.categoryId;
      }
      p.incomeMonth = null;
      p.isIncome = false;
    } else {
      const finalCatId = "categoryId" in p ? p.categoryId : current.categoryId;
      // Matches `createSplitWithChildren` / createSplit update semantics:
      // an uncategorized positive inflow is income even when it is a
      // split child (BUG-18.2).
      const isEligibleForIncome = finalCatId == null;

      const isIncome = isEligibleForIncome
        ? ("isIncome" in p ? Boolean(p.isIncome) : newAmount > 0)
        : false;
      p.isIncome = isIncome;
      if (!isIncome) {
        p.incomeMonth = null;
      }
    }

    const [updatedRow] = await db.update(transactions).set(p).where(eq(transactions.id, id)).returning();

    // If this row is a split parent and date changed, propagate date to children
    if (isSplitParent && "date" in p && p.date != null) {
      await db
        .update(transactions)
        .set({ date: String(p.date) })
        .where(eq(transactions.parentId, id));
    }

    // If this row is a child of a split and date changed, propagate date to parent and siblings
    if (current.parentId != null && "date" in p && p.date != null) {
      await db
        .update(transactions)
        .set({ date: String(p.date) })
        .where(or(eq(transactions.id, current.parentId), eq(transactions.parentId, current.parentId)));
    }

    // If this row is a split parent and status changed, propagate status to children
    if (isSplitParent && "status" in p && p.status != null) {
      await db
        .update(transactions)
        .set({ status: p.status as ClearedStatus, reconciledAt: null, reconciliationId: null })
        .where(eq(transactions.parentId, id));
    }

    // If this row is a child of a split and status changed, propagate status to parent and siblings
    if (current.parentId != null && "status" in p && p.status != null) {
      await db
        .update(transactions)
        .set({ status: p.status as ClearedStatus, reconciledAt: null, reconciliationId: null })
        .where(or(eq(transactions.id, current.parentId), eq(transactions.parentId, current.parentId)));
    }

    // Learn an automatic rename rule from a deliberate payee rename on a
    // plain regular transaction. Runs after the commit so a rule-learning
    // failure never rolls back (or blocks) the transaction edit itself.
    if (
      patch.payee != null &&
      String(patch.payee).trim() !== existing.payee.trim() &&
      existing.transferAccountId == null &&
      existing.parentId == null &&
      !isSplitParent
    ) {
      shouldLearnRenameRule = true;
      oldPayee = existing.payee;
      newPayee = String(patch.payee);
    }
    return updatedRow;
  });

  if (shouldLearnRenameRule) {
    try {
      await learnRenameRuleFromPayees(db, oldPayee, newPayee);
    } catch (learnErr) {
      console.error("[transactions] failed to learn rename rule:", learnErr);
    }
  }

  return row;
}

/**
 * Full-replace update of a split: validates the new children, reverses
 * the old children's balance, deletes them, optionally updates the
 * parent fields, then inserts the new children. Used by PATCH when the
 * caller passes `subTransactions: []`.
 */
export type UpdateSplitParentFields = {
  amount?: number;
  date?: string;
  payee?: string;
  memo?: string;
  status?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
};

export async function updateSplit(
  db: Database,
  parentId: number,
  parentFields: UpdateSplitParentFields,
  children: SubTransactionInput[]
) {
  if (parentFields.status === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }

  let shouldLearnRenameRule = false;
  let learnedOldPayee = "";
  let learnedNewPayee = "";

  const res = await withTransaction(db, async () => {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, parentId));
    if (!parent) {
      throw new TransactionError("split parent not found", 404);
    }
    if (parent.status === "r") {
      throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
    }
    if (parent.parentId != null || parent.transferAccountId != null) {
      throw new TransactionError("target row is not a split parent");
    }
    if (parentFields.date !== undefined && parentFields.date != null) {
      assertValidISODate(parentFields.date, "date");
    }
    const parentAmount =
      parentFields.amount !== undefined && parentFields.amount != null
        ? assertValidAmount(parentFields.amount)
        : assertValidAmount(parent.amount);
    assertSplitsBalancedOr4xx(parentAmount, children);

    for (const c of children) {
      if (c.transferAccountId != null && Number(c.transferAccountId) === parent.accountId) {
        throw new TransactionError("transfer account must differ from source account");
      }
    }

    const oldChildren = await getChildren(db, parentId);
    if (oldChildren.some((c) => c.status === "r" || c.transferStatus === "r")) {
      throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
    }

    if (oldChildren.length > 0) {
      for (const c of oldChildren) {
        await applyBalance(db, c.accountId, -Number(c.amount));
        if (c.transferAccountId != null) {
          await applyBalance(db, c.transferAccountId, Number(c.amount));
        }
      }
      await db.delete(transactions).where(eq(transactions.parentId, parentId));
    } else {
      // Converting a single transaction to a split: reverse the single transaction's balance
      await applyBalance(db, parent.accountId, -Number(parent.amount));
    }

    const pf: Record<string, unknown> = {};
    if (parentFields.amount !== undefined && parentFields.amount != null) pf.amount = parentAmount;
    if (parentFields.date !== undefined && parentFields.date != null) pf.date = String(parentFields.date);
    if (parentFields.payee !== undefined && parentFields.payee != null) pf.payee = String(parentFields.payee);
    if (parentFields.memo !== undefined) pf.memo = parentFields.memo == null ? "" : String(parentFields.memo);
    if (parentFields.status !== undefined && parentFields.status != null) {
      pf.status = parentFields.status;
      pf.reconciledAt = null;
      pf.reconciliationId = null;
    }
    if (parentFields.flagColor !== undefined) pf.flagColor = sanitizeFlagColor(parentFields.flagColor);
    if (oldChildren.length === 0) {
      pf.categoryId = null;
      pf.isIncome = false;
      pf.incomeMonth = null;
    }
    if (Object.keys(pf).length > 0) {
      await db.update(transactions).set(pf).where(eq(transactions.id, parentId));
    }

    const newMemo = (pf.memo as string | undefined) ?? parent.memo;
    const newDate = (pf.date as string | undefined) ?? parent.date;
    const newPayee = (pf.payee as string | undefined) ?? parent.payee;
    const newStatus: ClearedStatus =
      (pf.status as ClearedStatus | undefined) ?? (parent.status as ClearedStatus);

    const srcAccount = await getAccountInfo(db, parent.accountId);
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";
    const newChildren = [];
    const usedOldIndices = new Set<number>();

    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      const childAmount = assertValidAmount(c.amount);
      let payee = newPayee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      let categoryId = c.categoryId ? Number(c.categoryId) : null;
      let isIncome = false;

      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
        const destOnBudget = await isAccountOnBudget(db, transferAccountId);
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
        if (c.payee !== undefined && c.payee !== null && c.payee !== "") {
          payee = String(c.payee);
        } else {
          // Attempt to match with an existing child by client-supplied ID to preserve custom payee (BUG-34)
          let matchedOldChild: (typeof oldChildren)[0] | undefined;
          if (c.id != null) {
            const childId = Number(c.id);
            const foundIdx = oldChildren.findIndex(
              (oc, idx) => !usedOldIndices.has(idx) && oc.id === childId
            );
            if (foundIdx !== -1) {
              usedOldIndices.add(foundIdx);
              matchedOldChild = oldChildren[foundIdx];
            }
          }

          if (
            matchedOldChild &&
            matchedOldChild.transferAccountId == null &&
            matchedOldChild.payee &&
            matchedOldChild.payee !== parent.payee
          ) {
            payee = matchedOldChild.payee;
          } else {
            payee = newPayee;
          }
        }

        if (!srcOnBudget) {
          categoryId = null;
          isIncome = false;
        } else if (srcKind === "credit") {
          categoryId = c.categoryId ? Number(c.categoryId) : null;
          isIncome = false;
        } else {
          isIncome = categoryId == null && childAmount > 0;
        }
      }

      const [row] = await db
        .insert(transactions)
        .values({
          accountId: parent.accountId,
          categoryId,
          date: newDate,
          payee,
          // Children inherit the parent's memo unless they have their own.
          memo: c.memo ?? newMemo ?? "",
          amount: childAmount,
          status: newStatus,
          transferStatus: transferAccountId ? (c.transferStatus ?? newStatus) : null,
          transferAccountId,
          parentId,
          isIncome,
        })
        .returning();
      await applyBalance(db, parent.accountId, childAmount);
      if (transferAccountId) {
        await applyBalance(db, transferAccountId, -childAmount);
      }
      newChildren.push(row);
    }

    // Learn a rename rule when a split's display payee is changed.
    if (
      parentFields.payee != null &&
      String(parentFields.payee).trim() !== parent.payee.trim()
    ) {
      shouldLearnRenameRule = true;
      learnedOldPayee = parent.payee;
      learnedNewPayee = String(parentFields.payee);
    }
    return { parent: { ...parent, ...pf }, children: newChildren };
  });

  if (shouldLearnRenameRule) {
    try {
      await learnRenameRuleFromPayees(db, learnedOldPayee, learnedNewPayee);
    } catch (learnErr) {
      console.error("[transactions] failed to learn rename rule:", learnErr);
    }
  }

  return res;
}

/**
 * Delete a transaction. Cascade in the schema handles removing children
 * of a split parent when the parent is deleted, but we must still
 * reverse the children's balance effects beforehand.
 *
 *   - split parent: reverse each child's balance, then cascade deletes them
 *   - split child: reverse only its own balance (and if only 1 child remains, clean up parent)
 *   - transfer: reverse both source and destination balances
 *   - regular: reverse its own balance
 */
export async function deleteTransaction(db: Database, id: number) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;

  if (existing.status === "r" || existing.transferStatus === "r") {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before deleting.",
      422
    );
  }

  if (existing.parentId != null) {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
    if (parent && (parent.status === "r" || parent.transferStatus === "r")) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before deleting.",
        422
      );
    }
  }

  return withTransaction(db, async () => {
    const [current] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!current) return null;

    if (current.parentId != null) {
      await applyBalance(db, current.accountId, -Number(current.amount));
      if (current.transferAccountId != null) {
        await applyBalance(db, current.transferAccountId, Number(current.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));

      // Check remaining children of the split parent.
      // If only 1 child remains, flatten the remaining child into a regular transaction and delete the parent.
      const remaining = await getChildren(db, current.parentId);
      if (remaining.length === 1) {
        const lastChild = remaining[0]!;
        const [parent] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, current.parentId));

        const childPayee =
          lastChild.payee && lastChild.payee.trim() !== ""
            ? lastChild.payee
            : (parent?.payee ?? "");
        const childFlagColor = lastChild.flagColor ?? (parent?.flagColor ?? null);
        const childPayeeId = lastChild.payeeId ?? (parent?.payeeId ?? null);

        await db
          .update(transactions)
          .set({
            parentId: null,
            payee: childPayee,
            payeeId: childPayeeId,
            flagColor: childFlagColor,
          })
          .where(eq(transactions.id, lastChild.id));

        await db.delete(transactions).where(eq(transactions.id, current.parentId));
      } else if (remaining.length === 0) {
        await db.delete(transactions).where(eq(transactions.id, current.parentId));
      } else {
        const newTotal = remaining.reduce((sum, c) => sum + Number(c.amount), 0);
        await db
          .update(transactions)
          .set({ amount: newTotal })
          .where(eq(transactions.id, current.parentId));
      }
    } else if (current.transferAccountId != null) {
      await applyBalance(db, current.accountId, -Number(current.amount));
      await applyBalance(db, current.transferAccountId, Number(current.amount));
      await db.delete(transactions).where(eq(transactions.id, id));
    } else {
      const children = await getChildren(db, id);
      if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
        throw new TransactionError(
          "Reconciled split transaction cannot be deleted. Unreconcile before deleting.",
          422
        );
      }
      if (children.length > 0) {
        for (const c of children) {
          await applyBalance(db, c.accountId, -Number(c.amount));
          if (c.transferAccountId != null) {
            await applyBalance(db, c.transferAccountId, Number(c.amount));
          }
        }
      } else {
        await applyBalance(db, current.accountId, -Number(current.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));
    }

    return existing;
  });
}

/**
 * Bulk delete transactions in an atomic transaction.
 * Reconciled transactions ("r") are rejected with TransactionError (422).
 */
export async function bulkDeleteTransactions(db: Database, ids: number[]) {
  if (!ids || ids.length === 0) return [];
  return withTransaction(db, async () => {
    const deleted: any[] = [];
    const deletedIds = new Set<number>();
    for (const id of ids) {
      if (deletedIds.has(id)) continue;
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;
      if (existing.status === "r" || existing.transferStatus === "r") {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before deleting.`,
          422
        );
      }
      if (existing.parentId != null) {
        const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
        if (parent && (parent.status === "r" || parent.transferStatus === "r")) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before deleting.`,
            422
          );
        }
        await applyBalance(db, existing.accountId, -Number(existing.amount));
        if (existing.transferAccountId != null) {
          await applyBalance(db, existing.transferAccountId, Number(existing.amount));
        }
        await db.delete(transactions).where(eq(transactions.id, id));
        deleted.push(existing);
        deletedIds.add(id);

        // Check remaining children of the split parent.
        const remaining = await getChildren(db, existing.parentId);
        if (remaining.length === 1) {
          const lastChild = remaining[0]!;
          const childPayee =
            lastChild.payee && lastChild.payee.trim() !== ""
              ? lastChild.payee
              : (parent?.payee ?? "");
          const childFlagColor = lastChild.flagColor ?? (parent?.flagColor ?? null);
          const childPayeeId = lastChild.payeeId ?? (parent?.payeeId ?? null);

          await db
            .update(transactions)
            .set({
              parentId: null,
              payee: childPayee,
              payeeId: childPayeeId,
              flagColor: childFlagColor,
            })
            .where(eq(transactions.id, lastChild.id));

          await db.delete(transactions).where(eq(transactions.id, existing.parentId));
        } else if (remaining.length === 0) {
          await db.delete(transactions).where(eq(transactions.id, existing.parentId));
        } else {
          const newTotal = remaining.reduce((sum, c) => sum + Number(c.amount), 0);
          await db
            .update(transactions)
            .set({ amount: newTotal })
            .where(eq(transactions.id, existing.parentId));
        }
      } else {
        const children = await getChildren(db, id);
        if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
          throw new TransactionError(
            `Reconciled split transaction ${id} cannot be deleted. Unreconcile before deleting.`,
            422
          );
        }
        if (children.length > 0) {
          for (const c of children) {
            await applyBalance(db, c.accountId, -Number(c.amount));
            if (c.transferAccountId != null) {
              await applyBalance(db, c.transferAccountId, Number(c.amount));
            }
            deleted.push(c);
            deletedIds.add(c.id);
          }
          await db.delete(transactions).where(eq(transactions.parentId, id));
        } else {
          await applyBalance(db, existing.accountId, -Number(existing.amount));
          if (existing.transferAccountId != null) {
            await applyBalance(db, existing.transferAccountId, Number(existing.amount));
          }
        }
        await db.delete(transactions).where(eq(transactions.id, id));
        deleted.push(existing);
        deletedIds.add(id);
      }
    }
    return deleted;
  });
}

/**
 * Bulk update transactions in an atomic transaction.
 */
export async function bulkUpdateTransactions(
  db: Database,
  ids: number[],
  patch: BulkUpdateTransactionPatch
) {
  if (!ids || ids.length === 0) return [];
  if (patch.date !== undefined && patch.date != null) {
    assertValidISODate(patch.date, "date");
  }
  if (patch.incomeMonth !== undefined && patch.incomeMonth != null) {
    assertValidISOMonth(patch.incomeMonth, "incomeMonth");
  }
  if (patch.status === "r" || patch.transferStatus === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }
  const renameRulesToLearn: { from: string; to: string }[] = [];

  const updated = await withTransaction(db, async () => {
    const updatedRows: any[] = [];
    const familyIntents = new Map<number, { date?: string; status?: ClearedStatus }>();
    for (const id of ids) {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;

      const touchesStructural =
        patch.accountId !== undefined ||
        patch.categoryId !== undefined ||
        patch.date !== undefined ||
        patch.payee !== undefined ||
        patch.memo !== undefined ||
        patch.amount !== undefined ||
        patch.incomeMonth !== undefined;

      if (existing.status === "r" && (patch.status !== undefined || touchesStructural)) {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }

      if (existing.transferStatus === "r" && (patch.transferStatus !== undefined || touchesStructural)) {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }

      if (existing.parentId != null) {
        const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
        if (parent && (parent.status === "r" || parent.transferStatus === "r") && (patch.status !== undefined || touchesStructural)) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
            422
          );
        }
      }

      const isParent = existing.parentId == null && existing.transferAccountId == null;
      const hasChildren = isParent && (await childCount(db, id)) > 0;
      const isSplitParent = isParent && hasChildren;

      if (isSplitParent) {
        const children = await getChildren(db, id);
        if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
            422
          );
        }
        if ("amount" in patch && patch.amount !== undefined) {
          throw new TransactionError("cannot change amount of a split parent; edit children");
        }
        if ("accountId" in patch && patch.accountId !== undefined) {
          throw new TransactionError("cannot change account of a split parent");
        }
      }

      if (existing.parentId != null && patch.accountId !== undefined) {
        throw new TransactionError("cannot change account of a split child");
      }
      if (existing.parentId != null && patch.amount !== undefined) {
        throw new TransactionError("cannot change amount of a split child; edit the split");
      }

      if (
        existing.transferAccountId != null &&
        patch.accountId != null &&
        Number(patch.accountId) !== existing.accountId
      ) {
        throw new TransactionError("cannot change account of a transfer; delete and recreate");
      }

      const newAccountId = patch.accountId != null ? Number(patch.accountId) : existing.accountId;
      const newAmount = patch.amount != null ? assertValidAmount(patch.amount) : Number(existing.amount);

      if (patch.accountId != null || patch.amount != null) {
        if (existing.transferAccountId != null) {
          await applyBalance(db, existing.accountId, -Number(existing.amount));
          await applyBalance(db, existing.transferAccountId, Number(existing.amount));
          await applyBalance(db, newAccountId, newAmount);
          await applyBalance(db, existing.transferAccountId, -newAmount);
        } else if (!isSplitParent) {
          if (newAccountId !== existing.accountId || newAmount !== Number(existing.amount)) {
            await applyBalance(db, existing.accountId, -Number(existing.amount));
            await applyBalance(db, newAccountId, newAmount);
          }
        }
      }

      const setFields: Record<string, unknown> = {};
      if (patch.status !== undefined && patch.status != null) {
        setFields.status = patch.status;
        setFields.reconciledAt = null;
        setFields.reconciliationId = null;
      }
      if (patch.transferStatus !== undefined && patch.transferStatus != null) {
        setFields.transferStatus = patch.transferStatus;
        setFields.transferReconciledAt = null;
        setFields.transferReconciliationId = null;
      }
      if (patch.categoryId !== undefined) {
        setFields.categoryId = patch.categoryId ?? null;
      }
      if (patch.flagColor !== undefined) {
        setFields.flagColor = sanitizeFlagColor(patch.flagColor);
      }
      if (patch.date !== undefined && patch.date != null) setFields.date = String(patch.date);
      if (patch.payee !== undefined && patch.payee != null) {
        if (existing.transferAccountId != null && !String(patch.payee).trim()) {
          const destName = await getAccountName(db, existing.transferAccountId);
          setFields.payee = `Transfer : ${destName ?? "Unknown"}`;
        } else {
          setFields.payee = String(patch.payee);
        }
      }
      if (patch.memo !== undefined) setFields.memo = patch.memo == null ? "" : String(patch.memo);
      if (patch.amount !== undefined && patch.amount != null) setFields.amount = newAmount;
      if (patch.accountId !== undefined && patch.accountId != null) setFields.accountId = newAccountId;
      if (patch.incomeMonth !== undefined) setFields.incomeMonth = patch.incomeMonth ?? null;

      const srcAccount = await getAccountInfo(db, newAccountId);
      const srcOnBudget = srcAccount?.onBudget ?? true;
      const srcKind = srcAccount?.kind ?? "liquid";
      const destOnBudget =
        existing.transferAccountId != null
          ? await isAccountOnBudget(db, existing.transferAccountId)
          : null;

      if (existing.transferAccountId != null) {
        const finalCatId = "categoryId" in setFields ? (setFields.categoryId as number | null) : existing.categoryId;
        const incMonth =
          "incomeMonth" in setFields
            ? (setFields.incomeMonth as string | null)
            : (existing.incomeMonth ?? null);
        const classification = classifyBoundaryTransfer({
          srcOnBudget,
          destOnBudget: destOnBudget ?? true,
          amount: newAmount,
          categoryId: finalCatId,
          incomeMonth: incMonth,
        });
        setFields.categoryId = classification.categoryId;
        setFields.isIncome = classification.isIncome;
        setFields.incomeMonth = classification.incomeMonth;
      } else if (isSplitParent) {
        setFields.categoryId = null;
        setFields.isIncome = false;
        setFields.incomeMonth = null;
      } else if (!srcOnBudget) {
        setFields.categoryId = null;
        setFields.incomeMonth = null;
        setFields.isIncome = false;
      } else if (srcKind === "credit") {
        if ("categoryId" in patch) {
          setFields.categoryId = patch.categoryId ?? null;
        }
        setFields.incomeMonth = null;
        setFields.isIncome = false;
      } else {
        const finalCatId = "categoryId" in setFields ? setFields.categoryId : existing.categoryId;
        const isEligibleForIncome = finalCatId == null;

        if (patch.accountId != null || patch.amount != null || patch.categoryId !== undefined) {
          const isIncome = isEligibleForIncome && newAmount > 0;
          setFields.isIncome = isIncome;
          if (!isIncome) {
            setFields.incomeMonth = null;
          }
        } else if (!isEligibleForIncome && existing.isIncome) {
          setFields.isIncome = false;
          setFields.incomeMonth = null;
        }

        if (!isEligibleForIncome && "incomeMonth" in setFields) {
          setFields.incomeMonth = null;
        }
      }

      if (Object.keys(setFields).length > 0) {
        const [row] = await db
          .update(transactions)
          .set(setFields)
          .where(eq(transactions.id, id))
          .returning();
        if (row) updatedRows.push(row);

        const familyRoot = isSplitParent ? id : existing.parentId;
        if (familyRoot != null) {
          const intent = familyIntents.get(familyRoot) ?? {};
          if ("date" in setFields && setFields.date != null) {
            intent.date = String(setFields.date);
          }
          if ("status" in setFields && setFields.status != null) {
            intent.status = setFields.status as ClearedStatus;
          }
          familyIntents.set(familyRoot, intent);
        }
      }

      if (
        patch.payee != null &&
        String(patch.payee).trim() !== existing.payee.trim() &&
        existing.transferAccountId == null &&
        existing.parentId == null &&
        !isSplitParent
      ) {
        renameRulesToLearn.push({ from: existing.payee, to: String(patch.payee) });
      }
    }

    for (const [familyRoot, intent] of familyIntents) {
      const familyFilter = or(
        eq(transactions.id, familyRoot),
        eq(transactions.parentId, familyRoot)
      );
      const familyRows = await db.select().from(transactions).where(familyFilter);
      if (familyRows.some((row) => row.status === "r" || row.transferStatus === "r")) {
        throw new TransactionError(
          `Transaction ${familyRoot} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }
      if (intent.date != null) {
        await db.update(transactions).set({ date: intent.date }).where(familyFilter);
      }
      if (intent.status != null) {
        await db
          .update(transactions)
          .set({ status: intent.status, reconciledAt: null, reconciliationId: null })
          .where(familyFilter);
      }
    }

    return updatedRows;
  });

  for (const rule of renameRulesToLearn) {
    try {
      await learnRenameRuleFromPayees(db, rule.from, rule.to);
    } catch (learnErr) {
      console.error("[transactions] failed to learn rename rule in bulk update:", learnErr);
    }
  }

  return updated;
}
