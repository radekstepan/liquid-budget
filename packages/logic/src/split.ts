/**
 * Split / transfer classification helpers.
 *
 * All functions are pure — they read the supplied `Transaction[]` and
 * return derived data, no DB access, no side-effects. Used by both
 * the budget engine and the UI to group / label rows consistently.
 */

import type { Transaction } from "./types.js";
import { num } from "./format.js";

/** A transaction is a child of a split iff its `parentId` is set. */
export function isSplitChild(t: Transaction): boolean {
  return t.parentId != null;
}

/**
 * A transaction is a split parent iff it has no `parentId` of its own
 * and at least one other row in the dataset references it as `parentId`.
 */
export function isSplitParent(t: Transaction, all: Transaction[]): boolean {
  if (t.parentId != null) return false;
  return all.some((x) => x.parentId === t.id);
}

/** A transaction is a transfer iff its `transferAccountId` is set. */
export function isTransfer(t: Transaction): boolean {
  return t.transferAccountId != null;
}

/**
 * Get the children of a split parent. Returns rows in the order they
 * appear in `all` (caller is responsible for any sorting).
 */
export function getSplitChildren(
  all: Transaction[],
  parentId: number
): Transaction[] {
  return all.filter((t) => t.parentId === parentId);
}

/**
 * Reverse lookup: given a child row, return its parent (or undefined
 * if the child is orphaned or the parent isn't in `all`).
 */
export function getSplitParent(
  all: Transaction[],
  child: Transaction
): Transaction | undefined {
  if (child.parentId == null) return undefined;
  return all.find((t) => t.id === child.parentId);
}

/**
 * Compute the total amount of a split's children. Returns 0 when there
 * are no children.
 */
export function splitChildrenTotal(all: Transaction[], parentId: number): number {
  return getSplitChildren(all, parentId).reduce((s, c) => s + num(c.amount), 0);
}

/**
 * Minimal shape of a split child accepted by {@link assertSplitsBalanced}.
 * Covers transaction `SubTransactionInput`s, recurring
 * `RecurringSubTransaction`s and the UI's live sub-row drafts.
 */
export type SplitChildLike = {
  categoryId?: number | null;
  transferAccountId?: number | null;
  amount: number;
};

/**
 * The single source of truth for split-balance validation (BUG-18.3).
 * Used by the UI (transaction + recurring modals) and by the server's
 * transaction and recurring queries, which convert the thrown error via
 * the `errorFactory` parameter (e.g. `(m) => new TransactionError(m, 400)`).
 *
 * Rules (children use their *signed* amounts so mixed-sign splits — e.g.
 * a Paycheck with a negative tax deduction — are supported):
 *
 *   - parent amount must be a valid non-zero number (rounded to the cent)
 *   - at least 2 children
 *   - every child has a valid non-zero amount
 *   - every child has a category or transfer account (unless it is a
 *     positive inflow, which is a legitimate income leg)
 *   - the signed sum of children equals the signed parent amount to the cent
 *
 * Throws the error produced by `errorFactory` (default: plain `Error`).
 */
export function assertSplitsBalanced(
  parentAmount: number,
  children: SplitChildLike[],
  errorFactory: (message: string) => unknown = (message) => new Error(message)
): void {
  const fail = (message: string): never => {
    throw errorFactory(message);
  };

  const toCents = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return fail("Amount must be a valid number");
    }
    if (!Number.isSafeInteger(Math.round(n)) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
      return fail("Amount exceeds safe integer range");
    }
    return Math.round(n);
  };

  const parent = toCents(parentAmount);
  if (parent === 0) {
    return fail("Amount cannot be zero");
  }
  if (children.length < 2) {
    return fail("split must have at least two sub-transactions");
  }
  let sum = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const childAmount = toCents(c.amount);
    if (childAmount === 0) {
      return fail("Amount cannot be zero");
    }
    if (!c.categoryId && !c.transferAccountId && childAmount <= 0) {
      return fail(`sub-transaction ${i + 1} must have a category or transfer account`);
    }
    sum += childAmount;
  }
  if (sum !== parent) {
    return fail(`split children do not sum to parent: ${sum} vs ${parent}`);
  }
}
