import { eq, sql } from "drizzle-orm";
import type {
  BulkUpdateTransactionPatch,
  ClearedStatus,
  TransactionDuplicateFlag,
  TransactionFlagColor,
  TransactionFlagState,
} from "@ynab/logic";
import { TRANSACTION_DUPLICATE_FLAG, TRANSACTION_FLAG_COLORS } from "@ynab/logic";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";
import { learnRenameRuleFromPayees } from "./rename-rules.js";

export type CreateTransactionInput = {
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status?: ClearedStatus;
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
  flagColor?: TransactionFlagColor | null;
  isIncome?: boolean;
  incomeMonth?: string | null;
};

export type SubTransactionInput = {
  /**
   * Category or transfer account for the sub-transaction.
   */
  categoryId?: number | null;
  transferAccountId?: number | null;
  amount: number;
  memo?: string;
};

/**
 * Thrown by the transactions queries to signal a validation failure
 * that should surface as a 4xx HTTP response (rather than a 5xx).
 */
export class TransactionError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "TransactionError";
  }
}

export function assertValidAmount(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new TransactionError("Amount must be a valid number", 400);
  }
  if (!Number.isSafeInteger(Math.round(n)) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new TransactionError("Amount exceeds safe integer range", 400);
  }
  return Math.round(n);
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
): Promise<{ id: number; accountId: number; amount: number; transferAccountId: number | null; categoryId: number | null; memo: string; status: ClearedStatus }[]> {
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      transferAccountId: transactions.transferAccountId,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      status: transactions.status,
    })
    .from(transactions)
    .where(eq(transactions.parentId, parentId));
}

/**
 * Validate that a set of sub-transactions constitutes a balanced split.
 * Throws TransactionError if not. Rules:
 *   - at least 2 children
 *   - every child has a category or transfer account
 *   - the *signed* sum of child amounts matches the *signed* parent amount
 *     to the cent. Mixed signs are allowed (e.g. a Paycheck with a negative
 *     tax deduction) so the children retain their original sign.
 */
export function assertSplitsBalanced(
  parentAmount: number,
  children: SubTransactionInput[]
): void {
  const validParent = assertValidAmount(parentAmount);
  if (children.length < 2) {
    throw new TransactionError("split must have at least two sub-transactions");
  }
  let sum = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!c.categoryId && !c.transferAccountId) {
      throw new TransactionError(`sub-transaction ${i + 1} must have a category or transfer account`);
    }
    sum += assertValidAmount(c.amount);
  }
  if (sum !== validParent) {
    throw new TransactionError(
      `split children do not sum to parent: ${sum} vs ${validParent}`
    );
  }
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
  if (input.status === "r") {
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

  let payee = input.payee;
  if (input.transferAccountId != null && !payee.trim()) {
    const destName = await getAccountName(db, input.transferAccountId);
    payee = `Transfer : ${destName ?? "Unknown"}`;
  }

  db.run(sql`BEGIN`);
  try {
    const onBudget = await isAccountOnBudget(db, input.accountId);
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
      const isBoundaryCrossing = onBudget !== destOnBudget;
      const netOnBudgetDelta =
        (onBudget ? amount : 0) + (destOnBudget ? -amount : 0);

      if (isBoundaryCrossing) {
        if (netOnBudgetDelta > 0) {
          if (input.categoryId != null) {
            categoryId = input.categoryId;
            isIncome = false;
            incomeMonth = null;
          } else {
            categoryId = null;
            isIncome = input.isIncome !== undefined ? Boolean(input.isIncome) : true;
            incomeMonth = isIncome ? (input.incomeMonth ?? null) : null;
          }
        } else {
          categoryId = input.categoryId ?? null;
          isIncome = false;
          incomeMonth = null;
        }
      } else {
        categoryId = null;
        isIncome = false;
        incomeMonth = null;
      }
    } else if (!onBudget) {
      categoryId = null;
      isIncome = false;
      incomeMonth = null;
    } else {
      categoryId = input.categoryId ?? null;
      const isEligibleForIncome =
        categoryId == null &&
        input.parentId == null;
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
        memo: input.memo,
        amount,
        status: input.status ?? "c",
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
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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
  transferAccountId: number
) {
  const amount = assertValidAmount(baseInput.amount);
  if (baseInput.status === "r") {
    throw new TransactionError(
      "cannot directly create a reconciled transaction; use the reconcile flow"
    );
  }
  if (transferAccountId === baseInput.accountId) {
    throw new TransactionError("transfer account must differ from source account");
  }

  let payee = baseInput.payee;
  if (!payee.trim()) {
    const destName = await getAccountName(db, transferAccountId);
    payee = `Transfer : ${destName ?? "Unknown"}`;
  }

  db.run(sql`BEGIN`);
  try {
    const srcOnBudget = await isAccountOnBudget(db, baseInput.accountId);
    const destOnBudget = await isAccountOnBudget(db, transferAccountId);
    const isBoundaryCrossing = srcOnBudget !== destOnBudget;
    const netOnBudgetDelta = (srcOnBudget ? amount : 0) + (destOnBudget ? -amount : 0);

    let categoryId: number | null = null;
    let isIncome = false;
    let incomeMonth: string | null = null;

    if (isBoundaryCrossing) {
      if (netOnBudgetDelta > 0) {
        // Inflow into budget from off-budget
        if (baseInput.categoryId != null) {
          categoryId = baseInput.categoryId;
          isIncome = false;
          incomeMonth = null;
        } else {
          categoryId = null;
          isIncome = baseInput.isIncome !== undefined ? Boolean(baseInput.isIncome) : true;
          incomeMonth = isIncome ? (baseInput.incomeMonth ?? null) : null;
        }
      } else {
        // Outflow from budget to off-budget
        categoryId = baseInput.categoryId ?? null;
        isIncome = false;
        incomeMonth = null;
      }
    } else {
      // Internal transfer between same budget boundary
      categoryId = null;
      isIncome = false;
      incomeMonth = null;
    }

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
        flagColor: sanitizeFlagColor(baseInput.flagColor),
        transferAccountId,
        parentId: baseInput.parentId ?? null,
        isIncome,
        incomeMonth,
      })
      .returning();

    await applyBalance(db, baseInput.accountId, amount);
    await applyBalance(db, transferAccountId, -amount);
    db.run(sql`COMMIT`);
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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
  assertSplitsBalanced(parentAmount, children);

  const parentStatus = parent.status ?? "c";
  if (parentStatus === "r") {
    throw new TransactionError(
      "cannot directly create a reconciled transaction; use the reconcile flow"
    );
  }

  db.run(sql`BEGIN`);
  try {
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

    const srcOnBudget = await isAccountOnBudget(db, parent.accountId);
    const childRows = [];
    for (const c of children) {
      const childAmount = assertValidAmount(c.amount);
      let payee = parent.payee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      let categoryId = c.categoryId ? Number(c.categoryId) : null;
      let isIncome = false;

      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
        const destOnBudget = await isAccountOnBudget(db, transferAccountId);
        const isBoundaryCrossing = srcOnBudget !== destOnBudget;
        const netOnBudgetDelta = (srcOnBudget ? childAmount : 0) + (destOnBudget ? -childAmount : 0);

        if (isBoundaryCrossing) {
          if (netOnBudgetDelta > 0) {
            if (categoryId == null) {
              isIncome = true;
            }
          }
        } else {
          categoryId = null;
        }
      } else {
        if (!srcOnBudget) {
          categoryId = null;
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
    db.run(sql`COMMIT`);
    return { parent: parentRow, children: childRows };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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

  if (patch.status === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }

  if (existing.status === "r") {
    const nonStatusKeys = Object.keys(patch).filter((k) => k !== "status");
    if (nonStatusKeys.length > 0) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile the transaction before editing.",
        422
      );
    }
  }

  if ("parentId" in (patch as Record<string, unknown>)) {
    throw new TransactionError("parentId cannot be changed via update");
  }

  if (
    patch.flagColor !== undefined &&
    existing.flagColor === TRANSACTION_DUPLICATE_FLAG
  ) {
    throw new TransactionError(
      "This transaction is flagged as a duplicate; its flag cannot be changed. Remove the duplicate and rerun the duplicate check.",
      422
    );
  }

  if (
    existing.transferAccountId != null &&
    patch.accountId != null &&
    Number(patch.accountId) === existing.transferAccountId
  ) {
    throw new TransactionError("transfer account must differ from source account");
  }

  const p: Record<string, unknown> = {};
  if (patch.accountId != null) p.accountId = Number(patch.accountId);
  if ("categoryId" in patch) {
    p.categoryId = patch.categoryId ?? null;
  }
  if (patch.date != null) p.date = String(patch.date);
  if (patch.payee != null) p.payee = String(patch.payee);
  if (patch.memo != null) p.memo = String(patch.memo);
  if (patch.amount != null) p.amount = assertValidAmount(patch.amount);
  if (patch.status != null) {
    p.status = patch.status;
    p.reconciledAt = null;
    p.reconciliationId = null;
  }
  if (patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if ("incomeMonth" in patch) p.incomeMonth = patch.incomeMonth ?? null;
  if ("isIncome" in patch) p.isIncome = patch.isIncome;

  const isParent = existing.parentId == null && existing.transferAccountId == null;
  // Always query child count for cleanliness; the count is used to decide
  // whether this row is a split parent. Costs one extra cheap query for
  // non-parent rows but keeps the logic linear.
  const hasChildren = (await childCount(db, id)) > 0;
  const isSplitParent = isParent && hasChildren;

  if (isSplitParent) {
    if ("amount" in p) {
      throw new TransactionError("cannot change amount of a split parent; edit children");
    }
    if ("accountId" in p) {
      throw new TransactionError("cannot change account of a split parent");
    }
  }

  if (existing.parentId != null) {
    if ("accountId" in p) {
      throw new TransactionError("cannot change account of a split child");
    }
  }

  db.run(sql`BEGIN`);
  try {
    const newAccountId = (p.accountId as number | undefined) ?? existing.accountId;
    const newAmount = (p.amount as number | undefined) ?? Number(existing.amount);

    if (existing.transferAccountId != null) {
      await applyBalance(db, existing.accountId, -Number(existing.amount));
      await applyBalance(db, existing.transferAccountId, Number(existing.amount));
      await applyBalance(db, newAccountId, newAmount);
      await applyBalance(db, existing.transferAccountId, -newAmount);
    } else if (!isSplitParent) {
      if (newAccountId !== existing.accountId || newAmount !== Number(existing.amount)) {
        await applyBalance(db, existing.accountId, -Number(existing.amount));
        if (newAccountId !== existing.accountId) {
          await applyBalance(db, newAccountId, newAmount);
        } else {
          await applyBalance(db, newAccountId, newAmount - Number(existing.amount));
        }
      }
    }

    const srcOnBudget = await isAccountOnBudget(db, newAccountId);
    const destOnBudget =
      existing.transferAccountId != null
        ? await isAccountOnBudget(db, existing.transferAccountId)
        : null;

    if (existing.transferAccountId != null) {
      const isBoundaryCrossing = destOnBudget !== null && srcOnBudget !== destOnBudget;
      const netOnBudgetDelta =
        (srcOnBudget ? newAmount : 0) + (destOnBudget ? -newAmount : 0);

      if (isBoundaryCrossing) {
        const finalCatId = "categoryId" in p ? p.categoryId : existing.categoryId;
        if (netOnBudgetDelta > 0) {
          if (finalCatId != null) {
            p.categoryId = finalCatId;
            p.isIncome = false;
            p.incomeMonth = null;
          } else {
            p.categoryId = null;
            const isIncome = "isIncome" in p ? Boolean(p.isIncome) : true;
            p.isIncome = isIncome;
            if (!isIncome) {
              p.incomeMonth = null;
            }
          }
        } else {
          p.categoryId = finalCatId ?? null;
          p.isIncome = false;
          p.incomeMonth = null;
        }
      } else {
        p.categoryId = null;
        p.isIncome = false;
        p.incomeMonth = null;
      }
    } else if (isSplitParent) {
      p.categoryId = null;
      p.isIncome = false;
      p.incomeMonth = null;
    } else if (!srcOnBudget) {
      p.categoryId = null;
      p.incomeMonth = null;
      p.isIncome = false;
    } else {
      const finalCatId = "categoryId" in p ? p.categoryId : existing.categoryId;
      const isEligibleForIncome =
        existing.parentId == null &&
        finalCatId == null;

      const isIncome = isEligibleForIncome
        ? ("isIncome" in p ? Boolean(p.isIncome) : newAmount > 0)
        : false;
      p.isIncome = isIncome;
      if (!isIncome) {
        p.incomeMonth = null;
      }
    }

    const [row] = await db.update(transactions).set(p).where(eq(transactions.id, id)).returning();

    // If this row is a child of a split, verify that the parent is still balanced
    if (existing.parentId != null) {
      const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
      if (parent) {
        const siblings = await getChildren(db, existing.parentId);
        assertSplitsBalanced(Number(parent.amount), siblings);
      }
    }

    db.run(sql`COMMIT`);
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
      try {
        await learnRenameRuleFromPayees(db, existing.payee, String(patch.payee));
      } catch (learnErr) {
        console.error("[transactions] failed to learn rename rule:", learnErr);
      }
    }
    return row;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

/**
 * Full-replace update of a split: validates the new children, reverses
 * the old children's balance, deletes them, optionally updates the
 * parent fields, then inserts the new children. Used by PATCH when the
 * caller passes `subTransactions: []`.
 */
export async function updateSplit(
  db: Database,
  parentId: number,
  parentFields: {
    date?: string;
    payee?: string;
    memo?: string;
    status?: ClearedStatus;
    flagColor?: TransactionFlagColor | null;
  },
  children: SubTransactionInput[]
) {
  if (parentFields.status === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }
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
  if ("flagColor" in parentFields && parentFields.flagColor !== undefined && parent.flagColor === TRANSACTION_DUPLICATE_FLAG) {
    throw new TransactionError(
      "This transaction is flagged as a duplicate; its flag cannot be changed. Remove the duplicate and rerun the duplicate check.",
      422
    );
  }
  if ((await childCount(db, parentId)) === 0) {
    throw new TransactionError("target row has no children; use a regular update");
  }

  const parentAmount = assertValidAmount(parent.amount);
  assertSplitsBalanced(parentAmount, children);

  const oldChildren = await getChildren(db, parentId);
  if (oldChildren.some((c) => c.status === "r")) {
    throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
  }

  db.run(sql`BEGIN`);
  try {
    for (const c of oldChildren) {
      await applyBalance(db, c.accountId, -Number(c.amount));
      if (c.transferAccountId != null) {
        await applyBalance(db, c.transferAccountId, Number(c.amount));
      }
    }
    if (oldChildren.length > 0) {
      await db.delete(transactions).where(eq(transactions.parentId, parentId));
    }

    const pf: Record<string, unknown> = {};
    if (parentFields.date != null) pf.date = String(parentFields.date);
    if (parentFields.payee != null) pf.payee = String(parentFields.payee);
    if (parentFields.memo != null) pf.memo = String(parentFields.memo);
    if (parentFields.status != null) {
      pf.status = parentFields.status;
      pf.reconciledAt = null;
      pf.reconciliationId = null;
    }
    if (parentFields.flagColor !== undefined) pf.flagColor = sanitizeFlagColor(parentFields.flagColor);
    if (Object.keys(pf).length > 0) {
      await db.update(transactions).set(pf).where(eq(transactions.id, parentId));
    }

    const newMemo = (pf.memo as string | undefined) ?? parent.memo;
    const newDate = (pf.date as string | undefined) ?? parent.date;
    const newPayee = (pf.payee as string | undefined) ?? parent.payee;
    const newStatus: ClearedStatus =
      (pf.status as ClearedStatus | undefined) ?? (parent.status as ClearedStatus);

    const srcOnBudget = await isAccountOnBudget(db, parent.accountId);
    const newChildren = [];
    for (const c of children) {
      const childAmount = assertValidAmount(c.amount);
      let payee = newPayee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      let categoryId = c.categoryId ? Number(c.categoryId) : null;
      let isIncome = false;

      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
        const destOnBudget = await isAccountOnBudget(db, transferAccountId);
        const isBoundaryCrossing = srcOnBudget !== destOnBudget;
        const netOnBudgetDelta = (srcOnBudget ? childAmount : 0) + (destOnBudget ? -childAmount : 0);

        if (isBoundaryCrossing) {
          if (netOnBudgetDelta > 0) {
            if (categoryId == null) {
              isIncome = true;
            }
          }
        } else {
          categoryId = null;
        }
      } else {
        if (!srcOnBudget) {
          categoryId = null;
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

    db.run(sql`COMMIT`);
    // Learn a rename rule when a split's display payee is changed.
    if (
      parentFields.payee != null &&
      String(parentFields.payee).trim() !== parent.payee.trim()
    ) {
      try {
        await learnRenameRuleFromPayees(db, parent.payee, String(parentFields.payee));
      } catch (learnErr) {
        console.error("[transactions] failed to learn rename rule:", learnErr);
      }
    }
    return { parent: { ...parent, ...pf }, children: newChildren };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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

  if (existing.status === "r") {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before deleting.",
      422
    );
  }

  db.run(sql`BEGIN`);
  try {
    if (existing.parentId != null) {
      await applyBalance(db, existing.accountId, -Number(existing.amount));
      if (existing.transferAccountId != null) {
        await applyBalance(db, existing.transferAccountId, Number(existing.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));

      // Check remaining children of the split parent.
      // If only 1 child remains, a 1-child split is invalid so delete parent and the remaining child.
      const remaining = await getChildren(db, existing.parentId);
      if (remaining.length === 1) {
        const lastChild = remaining[0]!;
        if (lastChild.status === "r") {
          throw new TransactionError(
            "Transaction is reconciled and locked. Unreconcile before deleting.",
            422
          );
        }
        await applyBalance(db, lastChild.accountId, -Number(lastChild.amount));
        if (lastChild.transferAccountId != null) {
          await applyBalance(db, lastChild.transferAccountId, Number(lastChild.amount));
        }
        await db.delete(transactions).where(eq(transactions.id, lastChild.id));
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
    } else if (existing.transferAccountId != null) {
      await applyBalance(db, existing.accountId, -Number(existing.amount));
      await applyBalance(db, existing.transferAccountId, Number(existing.amount));
      await db.delete(transactions).where(eq(transactions.id, id));
    } else {
      const children = await getChildren(db, id);
      if (children.some((c) => c.status === "r")) {
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
        await applyBalance(db, existing.accountId, -Number(existing.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));
    }

    db.run(sql`COMMIT`);
    return existing;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

/**
 * Bulk delete transactions in an atomic transaction.
 * Reconciled transactions ("r") are rejected with TransactionError (422).
 */
export async function bulkDeleteTransactions(db: Database, ids: number[]) {
  if (!ids || ids.length === 0) return [];
  const deleted: any[] = [];
  db.run(sql`BEGIN`);
  try {
    for (const id of ids) {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;
      if (existing.status === "r") {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before deleting.`,
          422
        );
      }
      if (existing.parentId != null) {
        await applyBalance(db, existing.accountId, -Number(existing.amount));
        if (existing.transferAccountId != null) {
          await applyBalance(db, existing.transferAccountId, Number(existing.amount));
        }
        await db.delete(transactions).where(eq(transactions.id, id));
        deleted.push(existing);

        // Check remaining children of the split parent.
        const remaining = await getChildren(db, existing.parentId);
        if (remaining.length === 1) {
          const lastChild = remaining[0]!;
          if (lastChild.status === "r") {
            throw new TransactionError(
              `Transaction ${lastChild.id} is reconciled and locked. Unreconcile before deleting.`,
              422
            );
          }
          await applyBalance(db, lastChild.accountId, -Number(lastChild.amount));
          if (lastChild.transferAccountId != null) {
            await applyBalance(db, lastChild.transferAccountId, Number(lastChild.amount));
          }
          await db.delete(transactions).where(eq(transactions.id, lastChild.id));
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
        if (children.some((c) => c.status === "r")) {
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
      }
    }
    db.run(sql`COMMIT`);
    return deleted;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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
  if (patch.status === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }
  const updated: any[] = [];
  const renameRulesToLearn: { from: string; to: string }[] = [];

  db.run(sql`BEGIN`);
  try {
    for (const id of ids) {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;
      if (existing.status === "r" && patch.status !== "c" && patch.status !== "u") {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked.`,
          422
        );
      }
      if ("flagColor" in patch && patch.flagColor !== undefined && existing.flagColor === TRANSACTION_DUPLICATE_FLAG) {
        throw new TransactionError(
          `Transaction ${id} is flagged as a duplicate; its flag cannot be changed. Remove the duplicate and rerun the duplicate check.`,
          422
        );
      }

      const isParent = existing.parentId == null && existing.transferAccountId == null;
      const hasChildren = isParent && (await childCount(db, id)) > 0;
      const isSplitParent = isParent && hasChildren;

      if (isSplitParent) {
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
            if (newAccountId !== existing.accountId) {
              await applyBalance(db, newAccountId, newAmount);
            } else {
              await applyBalance(db, newAccountId, newAmount - Number(existing.amount));
            }
          }
        }
      }

      const setFields: Record<string, unknown> = {};
      if (patch.status !== undefined) {
        setFields.status = patch.status;
        setFields.reconciledAt = null;
        setFields.reconciliationId = null;
      }
      if ("categoryId" in patch) {
        setFields.categoryId = patch.categoryId ?? null;
      }
      if ("flagColor" in patch && patch.flagColor !== undefined) {
        setFields.flagColor = sanitizeFlagColor(patch.flagColor);
      }
      if (patch.date != null) setFields.date = String(patch.date);
      if (patch.payee != null) setFields.payee = String(patch.payee);
      if ("memo" in patch) setFields.memo = patch.memo ?? null;
      if (patch.amount != null) setFields.amount = newAmount;
      if (patch.accountId != null) setFields.accountId = newAccountId;
      if ("incomeMonth" in patch) setFields.incomeMonth = patch.incomeMonth ?? null;

      const srcOnBudget = await isAccountOnBudget(db, newAccountId);
      const destOnBudget =
        existing.transferAccountId != null
          ? await isAccountOnBudget(db, existing.transferAccountId)
          : null;

      if (existing.transferAccountId != null) {
        const isBoundaryCrossing = destOnBudget !== null && srcOnBudget !== destOnBudget;
        const netOnBudgetDelta =
          (srcOnBudget ? newAmount : 0) + (destOnBudget ? -newAmount : 0);

        if (isBoundaryCrossing) {
          const finalCatId = "categoryId" in setFields ? setFields.categoryId : existing.categoryId;
          if (netOnBudgetDelta > 0) {
            if (finalCatId != null) {
              setFields.categoryId = finalCatId;
              setFields.isIncome = false;
              setFields.incomeMonth = null;
            } else {
              setFields.categoryId = null;
              setFields.isIncome = true;
            }
          } else {
            setFields.categoryId = finalCatId ?? null;
            setFields.isIncome = false;
            setFields.incomeMonth = null;
          }
        } else {
          setFields.categoryId = null;
          setFields.isIncome = false;
          setFields.incomeMonth = null;
        }
      } else if (isSplitParent) {
        setFields.categoryId = null;
        setFields.isIncome = false;
        setFields.incomeMonth = null;
      } else if (!srcOnBudget) {
        setFields.categoryId = null;
        setFields.incomeMonth = null;
        setFields.isIncome = false;
      } else {
        const finalCatId = "categoryId" in setFields ? setFields.categoryId : existing.categoryId;
        const isEligibleForIncome =
          existing.parentId == null &&
          finalCatId == null;

        if (patch.accountId != null || patch.amount != null || "categoryId" in patch) {
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
        if (row) updated.push(row);
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
    db.run(sql`COMMIT`);

    for (const rule of renameRulesToLearn) {
      try {
        await learnRenameRuleFromPayees(db, rule.from, rule.to);
      } catch (learnErr) {
        console.error("[transactions] failed to learn rename rule in bulk update:", learnErr);
      }
    }

    return updated;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}
