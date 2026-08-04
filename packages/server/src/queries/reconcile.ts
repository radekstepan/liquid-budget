import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";
import { TransactionError } from "./transactions.js";
import { todayISO } from "@ynab/logic";

/**
 * Sentinel memo used on the auto-generated adjustment row that
 * `reconcileAccount` creates when the user's statement balance does
 * not match the working balance. `unreconcileAccount` looks for this
 * exact string to identify the synthetic row to delete.
 */
export const RECONCILE_ADJUSTMENT_MEMO = "Reconciliation balance";

export type ReconcileState = {
  accountId: number;
  accountName: string;
  /**
   * Sum of every Cleared + Reconciled transaction in the account.
   * This is the figure the user compares against their bank's
   * statement to find the missing/extra transaction(s).
   */
  workingBalance: number;
  /** Sum of every Uncleared transaction in the account. */
  unclearedTotal: number;
  unclearedCount: number;
  clearedCount: number;
  reconciledCount: number;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
};

export type ReconcileInput = {
  accountId: number;
  statementBalance: number;
  /**
   * Required when `statementBalance !== workingBalance`. The
   * adjustment transaction is posted against this category.
   */
  adjustmentCategoryId?: number | null;
};

export type ReconcileResult = {
  /** How many Cleared rows were flipped to Reconciled. */
  reconciledCount: number;
  /** ID of the auto-created balancing transaction, or null if not needed. */
  adjustmentTransactionId: number | null;
  /**
   * Working balance minus statement balance AFTER the operation.
   * Always exactly 0 on success; non-zero only if a sub-cent
   * rounding residual is left, in which case `reconcileAccount`
   * throws.
   */
  finalDiff: number;
  /** Echoed back for the API layer to update the UI. */
  lastReconciledAt: string;
};

/**
 * Compute the working balance and counts for a single account. Used
 * by the UI to render the Reconcile modal's read-only summary
 * ("Working Balance: $X, 7 cleared, 3 uncleared, 12 reconciled").
 */
export async function getReconcileState(
  db: Database,
  accountId: number
): Promise<ReconcileState> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) {
    throw new TransactionError(`Account ${accountId} not found`, 404);
  }

  const [agg] = await db
    .select({
      unclearedSum: sql<number>`coalesce(sum(case when status = 'u' then amount else 0 end), 0)`,
      unclearedCount: sql<number>`coalesce(sum(case when status = 'u' then 1 else 0 end), 0)`,
      clearedCount: sql<number>`coalesce(sum(case when status = 'c' then 1 else 0 end), 0)`,
      reconciledCount: sql<number>`coalesce(sum(case when status = 'r' then 1 else 0 end), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));

  const unclearedTotal = Number(agg?.unclearedSum ?? 0);
  const currentBalance = Number(acct.balance);
  // Working balance = current account balance − sum of uncleared
  // amounts. This is the figure the bank statement should match.
  const workingBalance = round2(currentBalance - unclearedTotal);

  return {
    accountId,
    accountName: acct.name,
    workingBalance,
    unclearedTotal: round2(unclearedTotal),
    unclearedCount: Number(agg?.unclearedCount ?? 0),
    clearedCount: Number(agg?.clearedCount ?? 0),
    reconciledCount: Number(agg?.reconciledCount ?? 0),
    lastReconciledAt: acct.lastReconciledAt ?? null,
    lastReconciledBalance:
      acct.lastReconciledBalance != null ? Number(acct.lastReconciledBalance) : null,
  };
}

/**
 * Reconcile an account against a bank statement. Steps:
 *
 *   1. Compute the working balance (cleared + reconciled total).
 *   2. Diff = workingBalance − statementBalance.
 *   3. If diff ≠ 0 and the caller did not pass an
 *      `adjustmentCategoryId`, throw 422 — the user must either fix
 *      a missing transaction in the register or pick a category for
 *      the auto-adjustment.
 *   4. If diff ≠ 0, post a balancing transaction with
 *      `amount = -diff`, `status = 'c'`, memo = RECONCILE_ADJUSTMENT_MEMO,
 *      and the user-chosen category. The working balance now matches
 *      the statement.
 *   5. Flip every currently-`"c"` row in the account to `"r"`. The
 *      just-created adjustment is itself cleared and will be picked
 *      up on the next reconciliation.
 *   6. Stamp `lastReconciledAt` / `lastReconciledBalance` on the account.
 *
 * Returns counts so the UI can render "Marked 7 transactions Reconciled".
 */
export async function reconcileAccount(
  db: Database,
  input: ReconcileInput
): Promise<ReconcileResult> {
  const state = await getReconcileState(db, input.accountId);
  const diff = round2(state.workingBalance - input.statementBalance);

  let adjustmentTransactionId: number | null = null;
  if (Math.abs(diff) >= 0.005) {
    if (input.adjustmentCategoryId == null) {
      throw new TransactionError(
        "Statement balance does not match the working balance; provide an adjustment category to absorb the difference.",
        422
      );
    }
    adjustmentTransactionId = await postAdjustment(
      db,
      input.accountId,
      -diff,
      input.adjustmentCategoryId
    );
  }

  // Flip every Cleared row in the account to Reconciled. The just-
  // created adjustment is itself Cleared and stays that way until the
  // next reconciliation.
  const flip = await db
    .update(transactions)
    .set({ status: "r" })
    .where(
      and(eq(transactions.accountId, input.accountId), eq(transactions.status, "c"))
    )
    .returning({ id: transactions.id });

  const today = todayISO();
  await db
    .update(accounts)
    .set({ lastReconciledAt: today, lastReconciledBalance: input.statementBalance })
    .where(eq(accounts.id, input.accountId));

  return {
    reconciledCount: flip.length,
    adjustmentTransactionId,
    finalDiff: 0,
    lastReconciledAt: today,
  };
}

async function postAdjustment(
  db: Database,
  accountId: number,
  amount: number,
  categoryId: number
): Promise<number> {
  // Inserted directly (bypassing createTransaction) because that
  // helper is overkill for a single row that does its own balance
  // update. We still write `status: "c"` so the next reconciliation
  // picks it up if the user has not yet added the missing txn.
  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      categoryId,
      date: todayISO(),
      payee: RECONCILE_ADJUSTMENT_MEMO,
      memo: RECONCILE_ADJUSTMENT_MEMO,
      amount,
      status: "c",
      transferAccountId: null,
      parentId: null,
    })
    .returning();

  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${round2(amount).toFixed(2)}` })
    .where(eq(accounts.id, accountId));

  return row!.id;
}

/**
 * Reverse the most recent reconciliation. Specifically:
 *
 *   - Flip every Reconciled row with `date <= lastReconciledAt` back
 *     to Cleared.
 *   - Delete the auto-generated adjustment row (memo =
 *     RECONCILE_ADJUSTMENT_MEMO) if it is still Cleared/Reconciled
 *     within the same window, reversing its balance effect.
 *   - Clear `lastReconciledAt` / `lastReconciledBalance` on the account.
 *
 * Throws 404 if the account has never been reconciled.
 */
export async function unreconcileAccount(
  db: Database,
  accountId: number
): Promise<{ flipped: number; deletedAdjustmentId: number | null }> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) {
    throw new TransactionError(`Account ${accountId} not found`, 404);
  }
  if (!acct.lastReconciledAt) {
    throw new TransactionError("This account has never been reconciled", 404);
  }

  const lastDate = acct.lastReconciledAt;

  const flipped = await db
    .update(transactions)
    .set({ status: "c" })
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.status, "r"),
        // SQLite stores dates as text; lexical compare is correct for
        // YYYY-MM-DD format.
        sql`${transactions.date} <= ${lastDate}`
      )
    )
    .returning({ id: transactions.id });

  // Find the synthetic adjustment row to delete. Match on memo and
  // date in the same window so a user-typed transaction with the
  // same memo (e.g. they manually re-typed the words "Reconciliation
  // balance") is left alone. Take only the first hit — in practice
  // there is at most one per reconciliation.
  const adjustmentRows = await db
    .select({ id: transactions.id, amount: transactions.amount })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.memo, RECONCILE_ADJUSTMENT_MEMO),
        sql`${transactions.date} <= ${lastDate}`
      )
    );
  const adjustment = adjustmentRows[0];

  let deletedAdjustmentId: number | null = null;
  if (adjustment) {
    await db
      .update(accounts)
      .set({ balance: sql`${accounts.balance} - ${Number(adjustment.amount).toFixed(2)}` })
      .where(eq(accounts.id, accountId));
    await db.delete(transactions).where(eq(transactions.id, adjustment.id));
    deletedAdjustmentId = adjustment.id;
  }

  await db
    .update(accounts)
    .set({ lastReconciledAt: null, lastReconciledBalance: null })
    .where(eq(accounts.id, accountId));

  return { flipped: flipped.length, deletedAdjustmentId };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
