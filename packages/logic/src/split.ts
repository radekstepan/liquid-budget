/**
 * Split / transfer classification helpers.
 *
 * All functions are pure — they read the supplied `Transaction[]` and
 * return derived data, no DB access, no side-effects. Used by both
 * the budget engine and the UI to group / label rows consistently.
 */

import type { Transaction, SubTransaction } from "./types.js";
import { fmt, num } from "./format.js";

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
 * Classify a set of sub-transactions for the UI. Mirrors the
 * server-side `assertSplitsBalanced` — returns an error string or null.
 *
 * Children use their *signed* amounts so mixed-sign splits (e.g. a
 * Paycheck with a negative tax deduction) are supported. The signed
 * sum must equal the parent's signed amount.
 */
export function validateSubTransactions(
  parentAmount: number,
  children: SubTransaction[]
): string | null {
  if (children.length < 2) return "Add at least two sub-transactions.";
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!c.categoryId && !c.transferAccountId) {
      return `Sub-transaction ${i + 1} is missing a category or transfer account.`;
    }
    if (c.categoryId && c.transferAccountId) {
      return `Sub-transaction ${i + 1} cannot have both a category and transfer account.`;
    }
    if (!Number.isFinite(Number(c.amount))) {
      return `Sub-transaction ${i + 1} amount is not a valid number.`;
    }
  }
  const sum = children.reduce((s, c) => s + Number(c.amount), 0);
  if (sum !== parentAmount) {
    return `Sub-transactions sum to ${fmt(sum)} but parent is ${fmt(parentAmount)}.`;
  }
  return null;
}
