/**
 * Helpers for working with `Recurring` rows and their flavours.
 *
 * `Recurring` mirrors `Transaction`'s discriminator convention:
 *
 *   - Single:   `transferAccountId` is null and no children exist.
 *   - Transfer: `transferAccountId` is set; `categoryId` should be null.
 *               The recurring lives on the source account; the destination
 *               sees the corresponding balance movement when the entry
 *               is posted (no separate row is created there).
 *   - Split:    no `transferAccountId`; the `recurring_sub_transactions`
 *               child table holds N children. The parent's `amount` is
 *               informational (matches the sum of children); only
 *               children contribute to category outflows at post time.
 */

import type { Recurring, RecurringSubTransaction } from "./types.js";
import { num } from "./format.js";

export type RecurringFlavour = "single" | "transfer" | "split";

/**
 * Classify a `Recurring` row. `children` is the array of
 * `RecurringSubTransaction` rows whose `recurringId` matches.
 */
export function recurringFlavour(
  r: Recurring,
  children: RecurringSubTransaction[]
): RecurringFlavour {
  if (r.transferAccountId != null) return "transfer";
  if (children.length > 0) return "split";
  return "single";
}

/** Filter the children of one recurring entry from the full list. */
export function getRecurringChildren(
  all: RecurringSubTransaction[],
  recurringId: number
): RecurringSubTransaction[] {
  return all
    .filter((s) => s.recurringId === recurringId)
    .slice()
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

/**
 * The amount that a recurring entry contributes to monthly net flow
 * for summary / projection purposes.
 *
 *   - Single:  the row's amount (signed).
 *   - Transfer: 0 (the source and destination balance movements cancel).
 *   - Split:   the sum of children (which equals the parent's |amount|).
 */
export function netMonthlyAmount(
  r: Recurring,
  children: RecurringSubTransaction[]
): number {
  if (r.transferAccountId != null) return 0;
  if (children.length > 0) {
    return children.reduce((s, c) => s + num(c.amount), 0);
  }
  return num(r.amount);
}

/**
 * Validate a set of recurring sub-transactions. Mirrors
 * `validateSubTransactions` and the server-side `assertSplitsBalanced`:
 *
 *   - at least 2 children
 *   - every child has a category
 *   - the signed sum of children equals the signed parent amount to the cent
 *     (mixed signs allowed: e.g. +5000 gross, -1000 taxes → +4000 net parent)
 */
export function validateRecurringSubTransactions(
  parentAmount: number,
  children: { categoryId: number | null; amount: number; transferAccountId?: number | null }[]
): string | null {
  if (children.length < 2) {
    return "Add at least two sub-transactions.";
  }
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!c.categoryId && !c.transferAccountId) {
      return `Sub-transaction ${i + 1} is missing a category or transfer account.`;
    }
  }
  const sum = children.reduce((s, c) => s + Number(c.amount) || 0, 0);
  if (Math.abs(sum - parentAmount) > 0.005) {
    return `Sub-transactions sum to ${sum.toFixed(2)} but parent is ${parentAmount.toFixed(2)}.`;
  }
  return null;
}
