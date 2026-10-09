/**
 * Pure reconcile state calculations.
 *
 * Used by both client and server to compute an account's working balance,
 * uncleared balance, and transaction status counts bounded by a statement date.
 */

import { num, todayISO } from "./format.js";
import type { Account, Transaction } from "./types.js";

/**
 * Sentinel payee/memo used on the auto-generated adjustment row that
 * `reconcileAccount` creates when the statement balance does not match
 * the working balance. Single-sourced here so the server and the
 * client's optimistic reconcile preview agree byte-for-byte.
 */
export const RECONCILE_ADJUSTMENT_MEMO = "Reconciliation balance";

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
  const parentMap = new Map<number, Transaction>();
  for (const t of transactions) {
    if (t.parentId != null) {
      parentIds.add(t.parentId);
    }
  }
  for (const t of transactions) {
    if (parentIds.has(t.id)) {
      parentMap.set(t.id, t);
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
    const parent = t.parentId != null ? parentMap.get(t.parentId) : undefined;
    const date = t.date ?? parent?.date;
    if (date != null && date > statementDate) {
      continue;
    }

    const amt = typeof t.amount === "number" ? Math.round(t.amount) : num(t.amount);
    const delta = isSource ? amt : -amt;
    const effStatus = isSource
      ? (parent?.status ?? t.status)
      : (t.transferStatus ?? parent?.transferStatus ?? t.status ?? "c");

    if (effStatus === "u") {
      unclearedSum += delta;
      unclearedCount += 1;
    } else if (effStatus === "c") {
      clearedSum += delta;
      clearedCount += 1;
    } else if (effStatus === "r") {
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

/**
 * Optimistically flip an account's in-scope Cleared rows to Reconciled,
 * mirroring the server `reconcileAccount` flip predicates exactly:
 *
 *   1. Source rows (`t.accountId === accountId`, `status === "c"`,
 *      `date <= statementDate`, not a split parent) flip `status` to "r".
 *   2. Inbound transfer legs (`t.transferAccountId === accountId`,
 *      `transferStatus === "c"` — or `transferStatus == null` with
 *      `status === "c"` — `date <= statementDate`, not a split parent)
 *      flip `transferStatus` to "r".
 *   3. Split parents on the account flip `status` to "r" only when every
 *      child is "r" after steps 1–2 (children win over the parent's own
 *      status, same as the server's post-flip parent sweep).
 *
 * Flipped rows also clear `needsReview`, matching the server. Server-stamped
 * fields (`reconciledAt`, `reconciliationId`, …) are left untouched — the
 * round id is only known after the POST, and the confirming reload fills
 * them in. Rows outside the predicates are returned by reference, so
 * callers can diff by identity to find the affected set.
 */
export function applyOptimisticReconcileFlips(
  transactions: Transaction[],
  accountId: number,
  statementDate: string
): Transaction[] {
  const parentIds = new Set<number>();
  for (const t of transactions) {
    if (t.parentId != null) {
      parentIds.add(t.parentId);
    }
  }

  const flipped = transactions.map((t) => {
    if (parentIds.has(t.id)) {
      return t;
    }
    if (t.date > statementDate) {
      return t;
    }
    if (t.accountId === accountId && t.status === "c") {
      return { ...t, status: "r" as const, needsReview: false };
    }
    if (
      t.transferAccountId === accountId &&
      (t.transferStatus === "c" || (t.transferStatus == null && t.status === "c"))
    ) {
      return { ...t, transferStatus: "r" as const, needsReview: false };
    }
    return t;
  });

  const statusById = new Map<number, Transaction["status"]>();
  for (const t of flipped) {
    statusById.set(t.id, t.status);
  }
  const childrenByParent = new Map<number, number[]>();
  for (const t of flipped) {
    if (t.parentId != null) {
      const list = childrenByParent.get(t.parentId) ?? [];
      list.push(t.id);
      childrenByParent.set(t.parentId, list);
    }
  }

  return flipped.map((t) => {
    if (!parentIds.has(t.id)) {
      return t;
    }
    if (t.accountId !== accountId || t.status !== "c" || t.date > statementDate) {
      return t;
    }
    const children = childrenByParent.get(t.id) ?? [];
    if (children.length > 0 && children.every((id) => statusById.get(id) === "r")) {
      return { ...t, status: "r" as const, needsReview: false };
    }
    return t;
  });
}
