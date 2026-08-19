import { eq, sql } from "drizzle-orm";
import type { ClearedStatus } from "@ynab/logic";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";

export type CreateTransactionInput = {
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status?: ClearedStatus;
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

async function isAccountOnBudget(db: Database, accountId: number): Promise<boolean> {
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
  assertValidAmount(parentAmount);
  if (children.length < 2) {
    throw new TransactionError("split must have at least two sub-transactions");
  }
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!c.categoryId && !c.transferAccountId) {
      throw new TransactionError(`sub-transaction ${i + 1} must have a category or transfer account`);
    }
    assertValidAmount(c.amount);
  }
  const sum = children.reduce((s, c) => s + Number(c.amount), 0);
  if (sum !== parentAmount) {
    throw new TransactionError(
      `split children do not sum to parent: ${sum} vs ${parentAmount}`
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
  assertValidAmount(input.amount);
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
      return createTransfer(db, input, input.transferAccountId);
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
    const isIncome = input.isIncome !== undefined ? input.isIncome : (!isTransfer && !isSplitParent && input.parentId == null && input.categoryId == null && input.amount > 0 && onBudget);

    const [row] = await db
      .insert(transactions)
      .values({
        accountId: input.accountId,
        categoryId: input.categoryId ?? null,
        date: input.date,
        payee,
        memo: input.memo,
        amount: input.amount,
        status: input.status ?? "c",
        transferAccountId: input.transferAccountId ?? null,
        parentId: input.parentId ?? null,
        isIncome,
        incomeMonth: input.incomeMonth ?? null,
      })
      .returning();

    // Children and regular rows apply their own balance; split parents do not.
    // `skipBalance` is only honoured for parents (parentId == null). Children
    // always apply their own balance, regardless of any `skipBalance` flag.
    if (!isSplitParent) {
      await applyBalance(db, input.accountId, input.amount);
      if (input.transferAccountId != null) {
        await applyBalance(db, input.transferAccountId, -input.amount);
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
  assertValidAmount(baseInput.amount);
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
    const [row] = await db
      .insert(transactions)
      .values({
        accountId: baseInput.accountId,
        categoryId: baseInput.categoryId ?? null,
        date: baseInput.date,
        payee,
        memo: baseInput.memo,
        amount: baseInput.amount,
        status: baseInput.status ?? "c",
        transferAccountId,
        parentId: baseInput.parentId ?? null,
        isIncome: false,
      })
      .returning();

    await applyBalance(db, baseInput.accountId, baseInput.amount);
    await applyBalance(db, transferAccountId, -baseInput.amount);
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
  },
  children: SubTransactionInput[]
) {
  assertSplitsBalanced(parent.amount, children);

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
        amount: parent.amount,
        status: parentStatus,
        transferAccountId: null,
        parentId: null,
        isIncome: false,
      })
      .returning();

    const onBudget = await isAccountOnBudget(db, parent.accountId);
    const childRows = [];
    for (const c of children) {
      let payee = parent.payee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      const categoryId = c.categoryId ? Number(c.categoryId) : null;
      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
      }
      const isIncome = transferAccountId == null && categoryId == null && c.amount > 0 && onBudget;

      const [child] = await db
        .insert(transactions)
        .values({
          accountId: parent.accountId,
          categoryId,
          date: parent.date,
          payee,
          memo: c.memo ?? "",
          amount: c.amount,
          status: parentStatus,
          transferAccountId,
          parentId: parentRow!.id,
          isIncome,
        })
        .returning();
      await applyBalance(db, parent.accountId, c.amount);
      if (transferAccountId) {
        await applyBalance(db, transferAccountId, -c.amount);
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

  if (existing.status === "r") {
    const nonStatusKeys = Object.keys(patch).filter((k) => k !== "status");
    if (nonStatusKeys.length > 0 || patch.status === "r") {
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
  if (patch.status != null) p.status = patch.status;
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

    const onBudget = await isAccountOnBudget(db, newAccountId);
    const finalCatId = "categoryId" in p ? p.categoryId : existing.categoryId;
    const isIncome = "isIncome" in p ? p.isIncome : (
      existing.transferAccountId == null &&
      !isSplitParent &&
      existing.parentId == null &&
      finalCatId == null &&
      newAmount > 0 &&
      onBudget
    );
    p.isIncome = isIncome;

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
  },
  children: SubTransactionInput[]
) {
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
  if ((await childCount(db, parentId)) === 0) {
    throw new TransactionError("target row has no children; use a regular update");
  }

  assertSplitsBalanced(parent.amount, children);

  const oldChildren = await getChildren(db, parentId);
  if (oldChildren.some((c) => c.status === "r")) {
    throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
  }

  db.run(sql`BEGIN`);
  try {
    for (const c of oldChildren) {
      await applyBalance(db, parent.accountId, -Number(c.amount));
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
    if (parentFields.status != null) pf.status = parentFields.status;
    if (Object.keys(pf).length > 0) {
      await db.update(transactions).set(pf).where(eq(transactions.id, parentId));
    }

    const newMemo = (pf.memo as string | undefined) ?? parent.memo;
    const newDate = (pf.date as string | undefined) ?? parent.date;
    const newPayee = (pf.payee as string | undefined) ?? parent.payee;
    const newStatus: ClearedStatus =
      (pf.status as ClearedStatus | undefined) ?? (parent.status as ClearedStatus);

    const onBudget = await isAccountOnBudget(db, parent.accountId);
    const newChildren = [];
    for (const c of children) {
      let payee = newPayee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      const categoryId = c.categoryId ? Number(c.categoryId) : null;
      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
      }
      const isIncome = transferAccountId == null && categoryId == null && c.amount > 0 && onBudget;

      const [row] = await db
        .insert(transactions)
        .values({
          accountId: parent.accountId,
          categoryId,
          date: newDate,
          payee,
          // Children inherit the parent's memo unless they have their own.
          memo: c.memo ?? newMemo ?? "",
          amount: c.amount,
          status: newStatus,
          transferAccountId,
          parentId,
          isIncome,
        })
        .returning();
      await applyBalance(db, parent.accountId, c.amount);
      if (transferAccountId) {
        await applyBalance(db, transferAccountId, -c.amount);
      }
      newChildren.push(row);
    }

    db.run(sql`COMMIT`);
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
        await applyBalance(db, lastChild.accountId, -Number(lastChild.amount));
        if (lastChild.transferAccountId != null) {
          await applyBalance(db, lastChild.transferAccountId, Number(lastChild.amount));
        }
        await db.delete(transactions).where(eq(transactions.id, lastChild.id));
        await db.delete(transactions).where(eq(transactions.id, existing.parentId));
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
          await applyBalance(db, existing.accountId, -Number(c.amount));
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
            await applyBalance(db, existing.accountId, -Number(c.amount));
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

export type BulkUpdateTransactionPatch = {
  status?: "u" | "c" | "r";
  categoryId?: number | null;
};

/**
 * Bulk update transactions in an atomic transaction.
 */
export async function bulkUpdateTransactions(
  db: Database,
  ids: number[],
  patch: BulkUpdateTransactionPatch
) {
  if (!ids || ids.length === 0) return [];
  const updated: any[] = [];
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
      const setFields: Record<string, unknown> = {};
      if (patch.status !== undefined) setFields.status = patch.status;
      if (patch.categoryId !== undefined) {
        setFields.categoryId = patch.categoryId;
      }
      if (Object.keys(setFields).length > 0) {
        const [row] = await db
          .update(transactions)
          .set(setFields)
          .where(eq(transactions.id, id))
          .returning();
        if (row) updated.push(row);
      }
    }
    db.run(sql`COMMIT`);
    return updated;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}
