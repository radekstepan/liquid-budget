/**
 * reports.ts
 *
 * Pure business logic for financial reports (Net Worth, etc.).
 * No React, no DB access.
 */

import type { BudgetData } from "./types.js";
import { fmt, num } from "./format.js";
import { isIncomeTransaction } from "./budget-engine.js";

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
      assets,
      debts,
      net: assets + debts,
    });
  }

  return points;
}

export type CashFlowSummary = {
  month: string;
  income: number;
  outflow: number;
  net: number;
  savingsRate: number;
};

/**
 * Compute monthly cash flow (Income vs Outflow, Net, and Savings Rate %).
 */
export function computeCashFlow(data: BudgetData, month: string): CashFlowSummary {
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  let income = 0;
  let outflow = 0;

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (t.date.slice(0, 7) !== month) continue;

    const amt = num(t.amount);
    if (isIncomeTransaction(t, accountMap)) {
      income += amt;
    } else if (t.transferAccountId == null && amt < 0) {
      outflow += Math.abs(amt);
    }
  }

  const net = income - outflow;
  const savingsRate =
    income > 0
      ? Math.round(((income - outflow) / income) * 1000) / 10
      : net > 0
        ? 100
        : 0;

  return { month, income, outflow, net, savingsRate };
}

export type TrailingNetWorthSummary = {
  points: NetWorthPoint[];
  currentNet: number;
  startNet: number;
  delta: number;
  pctDelta: number;
};

export function getOffsetMonth(month: string, offset: number): string {
  const parts = month.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const total = y * 12 + m + offset;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, "0")}`;
}

/**
 * Compute trailing N months of Net Worth ending at endMonth.
 */
export function computeTrailingNetWorth(
  data: BudgetData,
  endMonth: string,
  count = 12
): TrailingNetWorthSummary {
  const startMonth = getOffsetMonth(endMonth, -(count - 1));
  const points = computeNetWorthReport(data, startMonth, endMonth);
  const currentNet = points[points.length - 1]?.net ?? 0;
  const startNet = points[0]?.net ?? 0;
  const delta = currentNet - startNet;
  const pctDelta =
    startNet !== 0 ? Math.round((delta / Math.abs(startNet)) * 1000) / 10 : 0;

  return {
    points,
    currentNet,
    startNet,
    delta,
    pctDelta,
  };
}

export type SpendingInsight = {
  id: string;
  type: "trend" | "spike" | "top_spend" | "clean";
  categoryId?: number;
  categoryName?: string;
  amount?: number;
  avgAmount?: number;
  pctChange?: number;
  message: string;
};

/**
 * Compute monthly trends and 3-month average comparisons sorted by % change.
 */
export function computeMonthlyInsights(
  data: BudgetData,
  month: string,
  _budgetResult?: unknown
): SpendingInsight[] {
  const insights: SpendingInsight[] = [];
  const catMap = new Map(data.categories.map((c) => [c.id, c.name]));
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  // Spending per category this month vs previous 3 months
  const m1 = getOffsetMonth(month, -1);
  const m2 = getOffsetMonth(month, -2);
  const m3 = getOffsetMonth(month, -3);
  const priorMonths = new Set([m1, m2, m3]);

  const currentSpendByCat = new Map<number, number>();
  const priorSpendByCatMonth = new Map<number, Map<string, number>>();

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (t.categoryId == null || t.transferAccountId != null) continue;
    const amt = num(t.amount);
    if (amt >= 0) continue;

    const absAmt = Math.abs(amt);
    const mk = t.date.slice(0, 7);

    if (mk === month) {
      currentSpendByCat.set(
        t.categoryId,
        (currentSpendByCat.get(t.categoryId) ?? 0) + absAmt
      );
    } else if (priorMonths.has(mk)) {
      let mMap = priorSpendByCatMonth.get(t.categoryId);
      if (!mMap) {
        mMap = new Map();
        priorSpendByCatMonth.set(t.categoryId, mMap);
      }
      mMap.set(mk, (mMap.get(mk) ?? 0) + absAmt);
    }
  }

  // Count how many prior months actually exist in data
  const allDataMonths = new Set(data.transactions.map((t) => t.date.slice(0, 7)));
  const existingPriorMonthsCount = [m1, m2, m3].filter((m) => allDataMonths.has(m)).length;
  const divisor = Math.max(1, existingPriorMonthsCount);

  // Calculate 3-month average and % difference for categories
  for (const [catId, currentSpend] of currentSpendByCat.entries()) {
    const mMap = priorSpendByCatMonth.get(catId);
    if (mMap && mMap.size > 0) {
      const totalPriorSpend = Array.from(mMap.values()).reduce((a, b) => a + b, 0);
      const avg3mo = Math.round(totalPriorSpend / divisor);
      if (avg3mo > 0) {
        const pct = Math.round(((currentSpend - avg3mo) / avg3mo) * 100);
        const name = catMap.get(catId) ?? "Unknown";
        insights.push({
          id: `trend-${catId}`,
          type: "trend",
          categoryId: catId,
          categoryName: name,
          amount: currentSpend,
          avgAmount: avg3mo,
          pctChange: pct,
          message: `${name}: ${fmt(currentSpend)} (${pct >= 0 ? "+" : ""}${pct}% vs 3-mo avg)`,
        });
      }
    }
  }

  // Sort by % change descending
  insights.sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0));

  if (insights.length === 0) {
    insights.push({
      id: "clean-spending",
      type: "clean",
      message: "Spending is steady within 3-month baseline",
    });
  }

  return insights;
}
