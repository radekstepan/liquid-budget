/**
 * Split / transfer classification helpers.
 *
 * All functions are pure — they read the supplied `Transaction[]` and
 * return derived data, no DB access, no side-effects. Used by both
 * the budget engine and the UI to group / label rows consistently.
 */

import type { Transaction, SubTransaction } from "./types.js";
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
 * Returns true if the split's children sum to the parent's amount to
 * the cent. A parent with no children is considered "unbalanced" for
 * the purposes of this check (since splits must have >= 2 children).
 */
export function isSplitBalanced(parent: Transaction, all: Transaction[]): boolean {
  const children = getSplitChildren(all, parent.id);
  if (children.length < 2) return false;
  return Math.abs(splitChildrenTotal(all, parent.id) - num(parent.amount)) < 0.005;
}

/**
 * Classify a set of sub-transactions for the UI. Mirrors the
 * server-side `assertSplitsBalanced` — returns an error string or null.
 *
 * Children use their *signed* amounts so mixed-sign splits (e.g. a
 * Paycheck with a negative tax deduction) are supported. The signed
 * sum must equal the parent's signed amount to the cent.
 */
export function validateSubTransactions(
  parentAmount: number,
  children: SubTransaction[]
): string | null {
  if (children.length < 2) return "Add at least two sub-transactions.";
  for (let i = 0; i < children.length; i++) {
    if (!children[i]!.categoryId) {
      return `Sub-transaction ${i + 1} is missing a category.`;
    }
  }
  const sum = children.reduce((s, c) => s + Number(c.amount) || 0, 0);
  if (Math.abs(sum - parentAmount) > 0.005) {
    return `Sub-transactions sum to ${sum.toFixed(2)} but parent is ${parentAmount.toFixed(2)}.`;
  }
  return null;
}
