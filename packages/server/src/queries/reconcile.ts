import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, categories, reconciliations, transactions } from "../schema.js";
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
   * Sum of every Cleared + Reconciled transaction in the account up to statement date.
   * This is the figure the user compares against their bank's
   * statement to find the missing/extra transaction(s).
   */
  workingBalance: number;
  /** Sum of every Uncleared transaction in the account up to statement date. */
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
  statementDate?: string;
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
   * Always exactly 0 on success.
   */
  finalDiff: number;
  /** Echoed back for the API layer to update the UI. */
  lastReconciledAt: string;
};

/**
 * Compute the working balance and counts for a single account bounded
 * by the statement date. Used by the UI to render the Reconcile modal's
 * read-only summary.
 */
export async function getReconcileState(
  db: Database,
  accountId: number,
  statementDate: string = todayISO()
): Promise<ReconcileState> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) {
    throw new TransactionError(`Account ${accountId} not found`, 404);
  }

  const [agg] = await db
    .select({
      unclearedSum: sql<number>`coalesce(sum(case when status = 'u' and date <= ${statementDate} then amount else 0 end), 0)`,
      unclearedCount: sql<number>`coalesce(sum(case when status = 'u' and date <= ${statementDate} then 1 else 0 end), 0)`,
      clearedSum: sql<number>`coalesce(sum(case when status = 'c' and date <= ${statementDate} then amount else 0 end), 0)`,
      clearedCount: sql<number>`coalesce(sum(case when status = 'c' and date <= ${statementDate} then 1 else 0 end), 0)`,
      reconciledSum: sql<number>`coalesce(sum(case when status = 'r' and date <= ${statementDate} then amount else 0 end), 0)`,
      reconciledCount: sql<number>`coalesce(sum(case when status = 'r' and date <= ${statementDate} then 1 else 0 end), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));

  const unclearedTotal = Number(agg?.unclearedSum ?? 0);
  const clearedSum = Number(agg?.clearedSum ?? 0);
  const reconciledSum = Number(agg?.reconciledSum ?? 0);
  const workingBalance = Number(acct.balance ?? 0) - unclearedTotal;

  return {
    accountId,
    accountName: acct.name,
    workingBalance,
    unclearedTotal,
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
 *   1. Compute the working balance (cleared + reconciled total up to statementDate).
 *   2. Diff = workingBalance − statementBalance.
 *   3. If diff ≠ 0, validate adjustmentCategoryId.
 *   4. Create a record in `reconciliations` tracking round metadata.
 *   5. If diff ≠ 0, post a balancing transaction with `amount = -diff`, `status = 'r'`,
 *      `reconciliation_id = roundId`, and the user-chosen category.
 *   6. Flip every currently-`"c"` row in the account with date <= statementDate to `"r"`
 *      and stamp `reconciledAt` + `reconciliationId`.
 *   7. Stamp `lastReconciledAt` / `lastReconciledBalance` on the account.
 */
export async function reconcileAccount(
  db: Database,
  input: ReconcileInput
): Promise<ReconcileResult> {
  const statementDate = input.statementDate ?? todayISO();
  const state = await getReconcileState(db, input.accountId, statementDate);
  const diff = state.workingBalance - input.statementBalance;

  if (diff !== 0) {
    if (input.adjustmentCategoryId == null) {
      throw new TransactionError(
        "Statement balance does not match the working balance; provide an adjustment category to absorb the difference.",
        422
      );
    }
    const [cat] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, input.adjustmentCategoryId));
    if (!cat) {
      throw new TransactionError("Invalid adjustment category", 422);
    }
  }

  const today = todayISO();

  db.run(sql`BEGIN`);
  try {
    const [rec] = await db
      .insert(reconciliations)
      .values({
        accountId: input.accountId,
        reconciledAt: today,
        statementDate,
        statementBalance: input.statementBalance,
      })
      .returning();

    let adjustmentTransactionId: number | null = null;
    if (diff !== 0) {
      adjustmentTransactionId = await postAdjustment(
        db,
        input.accountId,
        -diff,
        input.adjustmentCategoryId!,
        statementDate,
        rec!.id
      );
      await db
        .update(reconciliations)
        .set({ adjustmentTransactionId })
        .where(eq(reconciliations.id, rec!.id));
    }

    // Flip every Cleared row in the account dated on or before statementDate to Reconciled.
    const flip = await db
      .update(transactions)
      .set({ status: "r", reconciledAt: today, reconciliationId: rec!.id })
      .where(
        and(
          eq(transactions.accountId, input.accountId),
          eq(transactions.status, "c"),
          sql`${transactions.date} <= ${statementDate}`
        )
      )
      .returning({ id: transactions.id });

    await db
      .update(accounts)
      .set({ lastReconciledAt: today, lastReconciledBalance: input.statementBalance })
      .where(eq(accounts.id, input.accountId));

    db.run(sql`COMMIT`);
    return {
      reconciledCount: flip.length + (adjustmentTransactionId ? 1 : 0),
      adjustmentTransactionId,
      finalDiff: 0,
      lastReconciledAt: today,
    };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

async function postAdjustment(
  db: Database,
  accountId: number,
  amount: number,
  categoryId: number,
  date: string,
  reconciliationId: number
): Promise<number> {
  const today = todayISO();
  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      categoryId,
      date,
      payee: RECONCILE_ADJUSTMENT_MEMO,
      memo: RECONCILE_ADJUSTMENT_MEMO,
      amount,
      status: "r",
      transferAccountId: null,
      parentId: null,
      isIncome: false,
      reconciledAt: today,
      reconciliationId,
    })
    .returning();

  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${Math.round(amount)}` })
    .where(eq(accounts.id, accountId));

  return row!.id;
}

/**
 * Reverse the most recent reconciliation round precisely using `reconciliation_id`.
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

  const [lastRec] = await db
    .select()
    .from(reconciliations)
    .where(eq(reconciliations.accountId, accountId))
    .orderBy(desc(reconciliations.id))
    .limit(1);

  db.run(sql`BEGIN`);
  try {
    let flippedCount = 0;
    let deletedAdjustmentId: number | null = null;

    if (lastRec) {
      const flipped = await db
        .update(transactions)
        .set({ status: "c", reconciledAt: null, reconciliationId: null })
        .where(
          and(
            eq(transactions.accountId, accountId),
            eq(transactions.status, "r"),
            eq(transactions.reconciliationId, lastRec.id)
          )
        )
        .returning({ id: transactions.id });
      flippedCount = flipped.length;

      if (lastRec.adjustmentTransactionId) {
        const [adjTxn] = await db
          .select({ id: transactions.id, amount: transactions.amount })
          .from(transactions)
          .where(eq(transactions.id, lastRec.adjustmentTransactionId));
        if (adjTxn) {
          await db
            .update(accounts)
            .set({ balance: sql`${accounts.balance} - ${Math.round(Number(adjTxn.amount))}` })
            .where(eq(accounts.id, accountId));
          await db.delete(transactions).where(eq(transactions.id, adjTxn.id));
          deletedAdjustmentId = adjTxn.id;
        }
      }

      await db.delete(reconciliations).where(eq(reconciliations.id, lastRec.id));

      const [prevRec] = await db
        .select()
        .from(reconciliations)
        .where(eq(reconciliations.accountId, accountId))
        .orderBy(desc(reconciliations.id))
        .limit(1);

      await db
        .update(accounts)
        .set({
          lastReconciledAt: prevRec?.reconciledAt ?? null,
          lastReconciledBalance: prevRec?.statementBalance ?? null,
        })
        .where(eq(accounts.id, accountId));
    } else {
      const lastDate = acct.lastReconciledAt;
      const flipped = await db
        .update(transactions)
        .set({ status: "c", reconciledAt: null, reconciliationId: null })
        .where(
          and(
            eq(transactions.accountId, accountId),
            eq(transactions.status, "r"),
            sql`(${transactions.reconciledAt} = ${lastDate} or (${transactions.reconciledAt} is null and ${transactions.date} <= ${lastDate}))`
          )
        )
        .returning({ id: transactions.id });
      flippedCount = flipped.length;

      const adjustmentRows = await db
        .select({ id: transactions.id, amount: transactions.amount })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            eq(transactions.memo, RECONCILE_ADJUSTMENT_MEMO),
            sql`(${transactions.reconciledAt} = ${lastDate} or (${transactions.reconciledAt} is null and ${transactions.date} <= ${lastDate}))`
          )
        )
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(1);
      const adjustment = adjustmentRows[0];

      if (adjustment) {
        await db
          .update(accounts)
          .set({ balance: sql`${accounts.balance} - ${Math.round(Number(adjustment.amount))}` })
          .where(eq(accounts.id, accountId));
        await db.delete(transactions).where(eq(transactions.id, adjustment.id));
        deletedAdjustmentId = adjustment.id;
      }

      await db
        .update(accounts)
        .set({ lastReconciledAt: null, lastReconciledBalance: null })
        .where(eq(accounts.id, accountId));
    }

    db.run(sql`COMMIT`);
    return { flipped: flippedCount, deletedAdjustmentId };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}
