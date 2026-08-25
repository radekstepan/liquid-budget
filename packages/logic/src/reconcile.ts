/**
 * Pure reconcile state calculations.
 *
 * Used by both client and server to compute an account's working balance,
 * uncleared balance, and transaction status counts bounded by a statement date.
 */

import { num, todayISO } from "./format.js";
import type { Account, Transaction } from "./types.js";

export type ReconcileState = {
  accountId: number;
  accountName: string;
  /**
   * Sum of every Cleared + Reconciled transaction in the account up to statement date.
   * This is the figure the user compares against their bank's statement.
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

/**
 * Compute the reconcile state for a single account from in-memory transactions,
 * matching the server's `getReconcileState` SQL query behavior:
 *
 *   1. Exclude split parents (rows referenced by any child's `parentId`) so split
 *      amounts are not double counted.
 *   2. Include both source transactions (`t.accountId === account.id`) and inbound
 *      transfers / split transfer legs (`t.transferAccountId === account.id`).
 *   3. Invert the sign of inbound transfer amounts (`-amount`).
 *   4. Filter transactions up to `statementDate` (`t.date <= statementDate`).
 *   5. Derive `workingBalance = clearedSum + reconciledSum` and counts.
 */
export function computeReconcileState(
  account: Pick<Account, "id" | "name"> & {
    lastReconciledAt?: string | null;
    lastReconciledBalance?: number | string | null;
  },
  transactions: Transaction[],
  statementDate: string = todayISO()
): ReconcileState {
  const accountId = account.id;
  const parentIds = new Set<number>();
  for (const t of transactions) {
    if (t.parentId != null) {
      parentIds.add(t.parentId);
    }
  }

  let unclearedSum = 0;
  let unclearedCount = 0;
  let clearedSum = 0;
  let clearedCount = 0;
  let reconciledSum = 0;
  let reconciledCount = 0;

  for (const t of transactions) {
    if (parentIds.has(t.id)) {
      continue;
    }
    const isSource = t.accountId === accountId;
    const isDest = t.transferAccountId === accountId;
    if (!isSource && !isDest) {
      continue;
    }
    if (t.date > statementDate) {
      continue;
    }

    const amt = typeof t.amount === "number" ? Math.round(t.amount) : num(t.amount);
    const delta = isSource ? amt : -amt;

    if (t.status === "u") {
      unclearedSum += delta;
      unclearedCount += 1;
    } else if (t.status === "c") {
      clearedSum += delta;
      clearedCount += 1;
    } else if (t.status === "r") {
      reconciledSum += delta;
      reconciledCount += 1;
    }
  }

  const workingBalance = clearedSum + reconciledSum;

  let lastReconciledBalance: number | null = null;
  if (account.lastReconciledBalance != null) {
    lastReconciledBalance =
      typeof account.lastReconciledBalance === "number"
        ? Math.round(account.lastReconciledBalance)
        : num(account.lastReconciledBalance);
  }

  return {
    accountId,
    accountName: account.name,
    workingBalance,
    unclearedTotal: unclearedSum,
    unclearedCount,
    clearedCount,
    reconciledCount,
    lastReconciledAt: account.lastReconciledAt ?? null,
    lastReconciledBalance,
  };
}
