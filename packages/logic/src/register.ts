/**
 * Per-row running balance for the register view.
 *
 * For a transaction row in a single account, the running balance at that
 * row is the account's balance *immediately after* the row is applied —
 * the same value the YNAB4 register shows in its rightmost "Balance"
 * column. This is the "will it bounce" projection: it includes uncleared
 * and split-child transactions so a forecasted overdraft surfaces before
 * payday.
 *
 * Algorithm:
 *   1. Identify split parents: rows that have at least one child row in
 *      the input referencing them as `parentId`. Split parents are
 *      skipped during the walk — their `amount` is informational only;
 *      only children carry the balance effect (same invariant the
 *      server's `applyBalance` enforces).
 *   2. For each account (or for the single anchor account), walk the
 *      non-parent rows in *date-descending* order, starting at the
 *      account's current balance. At each step: record the current
 *      balance as the row's running balance, then "undo" the row by
 *      subtracting its signed amount — moving backward in time to the
 *      next-older row. The newest row therefore anchors at the account's
 *      current balance; older rows accumulate the signed amounts of all
 *      newer rows.
 *   3. For the destination side of a transfer row, the row's amount is
 *      applied with the *opposite* sign — the source's outflow is the
 *      destination's inflow, mirroring the server's
 *      `applyBalance(accountId, -amount)` in `createTransfer`.
 *   4. Split parent rows mirror the running balance of the
 *      chronologically-newest child in their cluster (the *first* child
 *      in the date-descending sort) so the cluster reads as a single
 *      balance line — the "balance after this cluster".
 *
 * The function is pure: same inputs always produce same outputs, no
 * database, no React.
 */

import type { Transaction } from "./types.js";

export type RegisterRow = Omit<Transaction, "amount"> & {
  amount: number;
  /**
   * Balance of the relevant account (the anchor, or the row's own
   * `accountId` when no anchor) *after* this row is applied. For
   * split-parent rows this is copied from the chronologically-newest
   * child of the same parent so the cluster reads as a single balance
   * line.
   */
  runningBalance: number;
};

/** Row with `amount` parsed to a number — used internally during the walk. */
type ParsedTxn = Omit<Transaction, "amount"> & { amount: number };

/**
 * Input row shape accepted by `computeRunningBalances`. `amount` may
 * be the string form stored in the DB, or already parsed to a number
 * (e.g. when the caller has done `num(t.amount)` for its own purposes).
 */
export type RegisterInputRow = Transaction | ParsedTxn;

/**
 * Compute a running balance for every input row.
 *
 * @param rows        Pre-filtered, already date-sorted rows. `amount`
 *                    may be the string-typed `Transaction.amount` — it
 *                    is parsed via `num` here for convenience.
 * @param accountBalances  Current (most recent) balance per account.
 *                    Used as the anchor for the newest row of each
 *                    account. Missing accounts default to 0.
 * @param anchorAccountId  When set, every row's running balance is
 *                    computed *for that account only* — the typical
 *                    "single-account register" view. When undefined,
 *                    each row's running balance is computed for its own
 *                    `accountId` — the "All Transactions" view.
 */
export function computeRunningBalances(
  rows: RegisterInputRow[],
  accountBalances: Map<number, number>,
  anchorAccountId?: number
): RegisterRow[] {
  if (rows.length === 0) return [];

  // Parse amounts up-front so we never re-parse during the walk.
  const parsed: ParsedTxn[] = rows.map((t) => ({ ...t, amount: numSafe(t.amount) }));

  // Identify split parents: rows referenced as `parentId` by another row.
  const parentIds = new Set<number>();
  for (const r of parsed) {
    if (r.parentId != null) parentIds.add(r.parentId);
  }

  // Per-account (or single-anchor) backward walk.
  const runningBalanceById = new Map<number, number>();

  if (anchorAccountId != null) {
    walkAccount(
      parsed,
      parentIds,
      (r) =>
        r.accountId === anchorAccountId ||
        r.transferAccountId === anchorAccountId,
      (r) => (r.accountId === anchorAccountId ? r.amount : -r.amount),
      accountBalances.get(anchorAccountId) ?? 0,
      runningBalanceById
    );
  } else {
    const accountIds = new Set<number>();
    for (const r of parsed) accountIds.add(r.accountId);
    for (const acctId of accountIds) {
      walkAccount(
        parsed,
        parentIds,
        (r) => r.accountId === acctId,
        (r) => r.amount,
        accountBalances.get(acctId) ?? 0,
        runningBalanceById
      );
    }
  }

  // Mirror split parents to the post-cluster value of their first
  // (date-descending) child — the chronologically-newest child, which
  // carries the "balance after the entire cluster" reading.
  const firstChildByParent = new Map<number, number>();
  for (const r of parsed) {
    if (r.parentId == null) continue;
    if (!firstChildByParent.has(r.parentId)) {
      // First occurrence in `parsed` is the first in the date-desc
      // sort (sort is stable; same-date ties keep input order).
      firstChildByParent.set(r.parentId, r.id);
    }
  }
  for (const [parentId, childId] of firstChildByParent) {
    const childBal = runningBalanceById.get(childId);
    if (childBal != null) runningBalanceById.set(parentId, childBal);
  }

  // Assemble output, falling back to the row's own account balance for
  // any row that didn't participate in a walk (e.g. a row on account X
  // passed in alongside an anchor on account Y, with no transfer link).
  return parsed.map((r) => {
    const runningBalance =
      runningBalanceById.get(r.id) ?? accountBalances.get(r.accountId) ?? 0;
    return { ...r, runningBalance };
  });
}

/* ---------------- internal helpers ---------------- */

function walkAccount(
  parsed: ParsedTxn[],
  parentIds: Set<number>,
  filterFn: (r: ParsedTxn) => boolean,
  deltaFn: (r: ParsedTxn) => number,
  startBalance: number,
  out: Map<number, number>
): void {
  const rows = parsed
    .filter(filterFn)
    .filter((r) => !parentIds.has(r.id))
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  let bal = startBalance;
  for (const r of rows) {
    out.set(r.id, bal);
    bal -= deltaFn(r);
  }
}

function numSafe(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}
