/**
 * reports.ts
 *
 * Pure business logic for financial reports (Net Worth, etc.).
 * No React, no DB access.
 */

import type { BudgetData } from "./types.js";
import { num } from "./format.js";

export type NetWorthPoint = {
  month: string;
  assets: number;
  debts: number;
  net: number;
};

/**
 * Generate a contiguous list of "YYYY-MM" month keys from start to end (inclusive).
 */
export function getMonthsBetween(start: string, end: string): string[] {
  const partsS = start.split("-");
  const partsE = end.split("-");
  let y = Number(partsS[0]);
  let m = Number(partsS[1]);
  const ey = Number(partsE[0]);
  const em = Number(partsE[1]);
  const out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${m.toString().padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Compute the Net Worth series across a requested month range.
 *
 * Algorithm:
 * 1. Exclude split-parent rows (rows referenced as `parentId` by other rows);
 *    only split children carry balance deltas.
 * 2. Compute the lifetime net delta each account received from all transactions:
 *    - `t.accountId` receives `+t.amount`.
 *    - `t.transferAccountId` (destination) receives `-t.amount`.
 * 3. Back-calculate the initial base balance of every account prior to any
 *    transaction: `initialBalance = currentBalance - totalLifetimeDelta`.
 *    Accounts without transactions (e.g. Property, Mortgage Debt, fixed assets)
 *    retain their base balance across all months.
 * 4. Step forward month-by-month through the timeline:
 *    - Apply all transaction deltas up through each month.
 *    - Sum positive balances into `assets` and negative balances into `debts`.
 *    - `net = assets + debts`.
 */
export function computeNetWorthReport(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): NetWorthPoint[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const months = getMonthsBetween(actualStart, actualEnd);

  // 1. Identify split parents
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  // 2. Compute total lifetime delta per account across all transactions
  const totalDeltas = new Map<number, number>();
  for (const a of data.accounts) {
    totalDeltas.set(a.id, 0);
  }

  // Group transaction deltas by month: month -> Map<accountId, delta>
  const deltasByMonth = new Map<string, Map<number, number>>();

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const amt = num(t.amount);
    const mk = t.date.slice(0, 7);

    // Source account delta
    totalDeltas.set(t.accountId, (totalDeltas.get(t.accountId) ?? 0) + amt);
    let srcMonthMap = deltasByMonth.get(mk);
    if (!srcMonthMap) {
      srcMonthMap = new Map<number, number>();
      deltasByMonth.set(mk, srcMonthMap);
    }
    srcMonthMap.set(t.accountId, (srcMonthMap.get(t.accountId) ?? 0) + amt);

    // Transfer destination account delta
    if (t.transferAccountId != null) {
      totalDeltas.set(t.transferAccountId, (totalDeltas.get(t.transferAccountId) ?? 0) - amt);
      srcMonthMap.set(
        t.transferAccountId,
        (srcMonthMap.get(t.transferAccountId) ?? 0) - amt
      );
    }
  }

  // 3. Derive initial base balances before any transactions occurred
  const runningBalances = new Map<number, number>();
  for (const a of data.accounts) {
    const current = num(a.balance);
    const delta = totalDeltas.get(a.id) ?? 0;
    runningBalances.set(a.id, current - delta);
  }

  // 4. Advance running balances for all months prior to actualStart
  const allPriorMonths = Array.from(deltasByMonth.keys())
    .filter((m) => m < actualStart)
    .sort();
  for (const pm of allPriorMonths) {
    const mMap = deltasByMonth.get(pm);
    if (mMap) {
      for (const [accId, d] of mMap.entries()) {
        runningBalances.set(accId, (runningBalances.get(accId) ?? 0) + d);
      }
    }
  }

  // 5. Generate data points for each month in the range
  const points: NetWorthPoint[] = [];
  for (const m of months) {
    const mMap = deltasByMonth.get(m);
    if (mMap) {
      for (const [accId, d] of mMap.entries()) {
        runningBalances.set(accId, (runningBalances.get(accId) ?? 0) + d);
      }
    }

    let assets = 0;
    let debts = 0;
    for (const [, bal] of runningBalances.entries()) {
      if (bal > 0) {
        assets += bal;
      } else if (bal < 0) {
        debts += bal;
      }
    }

    points.push({
      month: m,
      assets: Math.round(assets * 100) / 100,
      debts: Math.round(debts * 100) / 100,
      net: Math.round((assets + debts) * 100) / 100,
    });
  }

  return points;
}
