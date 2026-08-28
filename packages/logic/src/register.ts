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
 *   4. Split parent rows mirror the running balance of the first child
 *      in their cluster *that has a walk entry* (the chronologically-
 *      newest participating child) so the cluster reads as a single
 *      balance line — the "balance after this cluster". If no child
 *      participated, the parent gets `null` too.
 *
 * Rows that do not participate in a walk (e.g. in an anchored
 * single-account view, a row on another account with no transfer link
 * to the anchor) get `null` rather than the account's live balance — a
 * historical column must never silently show a current figure.
 *
 * The function is pure: same inputs always produce same outputs, no
 * database, no React.
 */

import { num } from "./format.js";
import type { Transaction } from "./types.js";

export type RegisterRow = Omit<Transaction, "amount"> & {
  amount: number;
  /**
   * Balance of the relevant account (the anchor, or the row's own
   * `accountId` when no anchor) *after* this row is applied. For
   * split-parent rows this is copied from the chronologically-newest
   * participating child of the same parent so the cluster reads as a
   * single balance line. `null` when the row did not participate in a
   * walk (e.g. anchored to another account with no transfer link).
   */
  runningBalance: number | null;
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
  const len = rows.length;

  // Identify split parents: rows referenced as `parentId` by another row.
  const parentIds = new Set<number>();
  for (let i = 0; i < len; i++) {
    const pId = rows[i]!.parentId;
    if (pId != null) parentIds.add(pId);
  }

  // Per-account (or single-anchor) backward walk.
  const runningBalanceById = new Map<number, number>();

  if (anchorAccountId != null) {
    let bal = accountBalances.get(anchorAccountId) ?? 0;
    for (let i = 0; i < len; i++) {
      const r = rows[i]!;
      if (parentIds.has(r.id)) continue;
      const isSource = r.accountId === anchorAccountId;
      const isDest = r.transferAccountId === anchorAccountId;
      if (!isSource && !isDest) continue;
      runningBalanceById.set(r.id, bal);
      const amt = typeof r.amount === "number" ? Math.round(r.amount) : num(r.amount);
      const delta = isSource ? amt : -amt;
      bal -= delta;
    }
  } else {
    const byAccount = new Map<number, RegisterInputRow[]>();
    for (let i = 0; i < len; i++) {
      const r = rows[i]!;
      if (parentIds.has(r.id)) continue;
      let srcList = byAccount.get(r.accountId);
      if (!srcList) {
        srcList = [];
        byAccount.set(r.accountId, srcList);
      }
      srcList.push(r);
      if (r.transferAccountId != null) {
        let destList = byAccount.get(r.transferAccountId);
        if (!destList) {
          destList = [];
          byAccount.set(r.transferAccountId, destList);
        }
        destList.push(r);
      }
    }
    for (const [acctId, acctRows] of byAccount) {
      let bal = accountBalances.get(acctId) ?? 0;
      for (let i = 0; i < acctRows.length; i++) {
        const r = acctRows[i]!;
        const isSource = r.accountId === acctId;
        if (isSource) {
          runningBalanceById.set(r.id, bal);
        }
        const amt = typeof r.amount === "number" ? Math.round(r.amount) : num(r.amount);
        const delta = isSource ? amt : -amt;
        bal -= delta;
      }
    }
  }

  // Mirror split parents to the post-cluster value of the first child
  // in their cluster *that has a walk entry* — the chronologically-newest
  // participating child, which carries the "balance after the entire
  // cluster" reading. Children on other accounts (no walk entry) are
  // skipped; if no child participated, the parent stays unmapped and
  // assembles as `null` rather than a live balance.
  const childrenByParent = new Map<number, number[]>();
  for (let i = 0; i < len; i++) {
    const r = rows[i]!;
    if (r.parentId != null) {
      let list = childrenByParent.get(r.parentId);
      if (!list) {
        list = [];
        childrenByParent.set(r.parentId, list);
      }
      // Order of occurrence in `rows` is date-desc order (sort is
      // stable; same-date ties keep input order).
      list.push(r.id);
    }
  }
  for (const [parentId, childIds] of childrenByParent) {
    for (const childId of childIds) {
      const childBal = runningBalanceById.get(childId);
      if (childBal != null) {
        runningBalanceById.set(parentId, childBal);
        break;
      }
    }
  }

  // Assemble output. Rows that didn't participate in a walk (e.g. a row
  // on account X passed in alongside an anchor on account Y, with no
  // transfer link) get `null` — never the account's live balance, which
  // would masquerade as a historical figure.
  const result: RegisterRow[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const r = rows[i]!;
    const amt = typeof r.amount === "number" ? Math.round(r.amount) : num(r.amount);
    const runningBalance = runningBalanceById.get(r.id) ?? null;
    result[i] = { ...r, amount: amt, runningBalance };
  }
  return result;
}
