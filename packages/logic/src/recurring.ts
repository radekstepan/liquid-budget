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

import type { Account, Recurring, RecurringSubTransaction } from "./types.js";
import { fmt, num } from "./format.js";

export type RecurringFlavour = "single" | "transfer" | "split";

export const RECURRING_FREQUENCIES: { value: string; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "everyotherweek", label: "Every Other Week" },
  { value: "twiceamonth", label: "Twice a Month" },
  { value: "every4weeks", label: "Every 4 Weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "everyothermonth", label: "Every Other Month" },
  { value: "every3months", label: "Every 3 Months" },
  { value: "every4months", label: "Every 4 Months" },
  { value: "twiceayear", label: "Twice a Year" },
  { value: "yearly", label: "Yearly" },
  { value: "every2years", label: "Every 2 Years" },
];

export function frequencyLabel(freq: string): string {
  const norm = (freq || "").toLowerCase().replace(/[\s_-]+/g, "");
  switch (norm) {
    case "never":
    case "once":
      return "Never";
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "biweekly":
    case "everyotherweek":
      return "Every Other Week";
    case "twiceamonth":
    case "semimonthly":
      return "Twice a Month";
    case "every4weeks":
      return "Every 4 Weeks";
    case "monthly":
      return "Monthly";
    case "everyothermonth":
    case "bimonthly":
      return "Every Other Month";
    case "every3months":
    case "quarterly":
      return "Every 3 Months";
    case "every4months":
      return "Every 4 Months";
    case "twiceayear":
    case "semiannually":
      return "Twice a Year";
    case "yearly":
    case "annually":
      return "Yearly";
    case "every2years":
      return "Every 2 Years";
    default:
      return freq || "Monthly";
  }
}

/**
 * Returns the average monthly multiplier for a given recurring frequency.
 * E.g. "twiceamonth" -> 2, "monthly" -> 1, "biweekly" -> 26/12 (~2.1667),
 * "weekly" -> 52/12 (~4.3333), "yearly" -> 1/12 (~0.0833).
 */
export function frequencyMonthlyMultiplier(frequency: string): number {
  const norm = (frequency || "").toLowerCase().replace(/[\s_-]+/g, "");
  switch (norm) {
    case "daily":
      return 365 / 12;
    case "weekly":
      return 52 / 12;
    case "biweekly":
    case "everyotherweek":
      return 26 / 12;
    case "twiceamonth":
    case "semimonthly":
      return 2;
    case "every4weeks":
      return 13 / 12;
    case "monthly":
      return 1;
    case "everyothermonth":
    case "bimonthly":
      return 0.5;
    case "every3months":
    case "quarterly":
      return 1 / 3;
    case "every4months":
      return 0.25;
    case "twiceayear":
    case "semiannually":
      return 2 / 12;
    case "yearly":
    case "annually":
      return 1 / 12;
    case "every2years":
      return 1 / 24;
    case "never":
    case "once":
      return 0;
    default:
      return 1;
  }
}

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
 * Calculate the net impact of a single recurring entry occurrence on the
 * total liquid account balance (Checking, Cash, Savings), taking into account
 * transfer directions between liquid, credit, and off-budget accounts.
 */
export function recurringLiquidFlow(
  r: Recurring,
  children: RecurringSubTransaction[],
  accounts: Account[] | Map<number, { kind: string }>
): number {
  const accMap =
    accounts instanceof Map
      ? accounts
      : new Map(accounts.map((a) => [a.id, a]));

  const sourceKind = accMap.get(r.accountId)?.kind;

  // Split recurring
  if (children.length > 0) {
    return children.reduce((s, c) => {
      const amt = num(c.amount);
      if (c.transferAccountId != null) {
        const destKind = accMap.get(c.transferAccountId)?.kind;
        if (sourceKind === "liquid" && destKind !== "liquid") {
          return s + amt;
        }
        if (sourceKind !== "liquid" && destKind === "liquid") {
          return s - amt;
        }
        return s;
      }
      if (sourceKind === "liquid") {
        return s + amt;
      }
      return s;
    }, 0);
  }

  // Transfer recurring
  if (r.transferAccountId != null) {
    const destKind = accMap.get(r.transferAccountId)?.kind;
    if (sourceKind === "liquid" && destKind === "liquid") {
      // Transfer within liquid pool has 0 net effect on overall liquid cash
      return 0;
    }
    if (sourceKind === "liquid" && destKind !== "liquid") {
      // Money leaving liquid (e.g. transfer to credit card, loan, or investment)
      return num(r.amount);
    }
    if (sourceKind !== "liquid" && destKind === "liquid") {
      // Money entering liquid from offbudget / external account
      return -num(r.amount);
    }
    return 0;
  }

  // Single recurring
  if (sourceKind === "liquid") {
    return num(r.amount);
  }
  return 0;
}

/**
 * The amount that a recurring entry contributes to monthly net flow
 * for summary / projection purposes.
 *
 *   - When accounts is provided: uses account-aware liquid flow.
 *   - When accounts is omitted:
 *       - Single:  the row's amount (signed).
 *       - Transfer: 0 (the source and destination balance movements cancel).
 *       - Split:   the sum of children (which equals the parent's |amount|).
 */
export function netMonthlyAmount(
  r: Recurring,
  children: RecurringSubTransaction[],
  accounts?: Account[] | Map<number, { kind: string }>
): number {
  if (accounts) {
    return recurringLiquidFlow(r, children, accounts);
  }
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
 *   - every child has a category or transfer account (mutually exclusive)
 *   - every child has a valid finite amount
 *   - the signed sum of children equals the signed parent amount
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
