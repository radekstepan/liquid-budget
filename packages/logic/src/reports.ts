/**
 * reports.ts
 *
 * Pure business logic for financial reports (Net Worth, etc.).
 * No React, no DB access.
 */

import type { BudgetData, Transaction } from "./types.js";
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

  // 1. Identify split parents and earliest transaction month per account
  const splitParentIds = new Set<number>();
  const earliestMonthByAccount = new Map<number, string>();
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

    // Track earliest activity month for source account
    const curEarliestSrc = earliestMonthByAccount.get(t.accountId);
    if (!curEarliestSrc || mk < curEarliestSrc) {
      earliestMonthByAccount.set(t.accountId, mk);
    }

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
      const curEarliestDest = earliestMonthByAccount.get(t.transferAccountId);
      if (!curEarliestDest || mk < curEarliestDest) {
        earliestMonthByAccount.set(t.transferAccountId, mk);
      }
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
    for (const [accId, bal] of runningBalances.entries()) {
      // Clamp to 0 if the account has transactions but they only begin in a future month
      const earliest = earliestMonthByAccount.get(accId);
      if (earliest && m < earliest) {
        continue;
      }
      if (bal > 0) {
        assets = Math.round(assets + bal);
      } else if (bal < 0) {
        debts = Math.round(debts + bal);
      }
    }

    points.push({
      month: m,
      assets,
      debts,
      net: Math.round(assets + debts),
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
      income = Math.round(income + amt);
    } else if (t.transferAccountId == null && amt < 0) {
      outflow = Math.round(outflow + Math.abs(amt));
    }
  }

  const net = Math.round(income - outflow);
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
  pctDelta: number | null;
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
    startNet !== 0
      ? Math.round((delta / Math.abs(startNet)) * 1000) / 10
      : delta === 0
        ? 0
        : null;

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
    if (isIncomeTransaction(t)) continue;

    const netOutflow = -num(t.amount);
    const mk = t.date.slice(0, 7);

    if (mk === month) {
      currentSpendByCat.set(
        t.categoryId,
        (currentSpendByCat.get(t.categoryId) ?? 0) + netOutflow
      );
    } else if (priorMonths.has(mk)) {
      let mMap = priorSpendByCatMonth.get(t.categoryId);
      if (!mMap) {
        mMap = new Map();
        priorSpendByCatMonth.set(t.categoryId, mMap);
      }
      mMap.set(mk, (mMap.get(mk) ?? 0) + netOutflow);
    }
  }

  // Calculate 3-month average and % difference for categories
  for (const [catId, currentSpend] of currentSpendByCat.entries()) {
    const mMap = priorSpendByCatMonth.get(catId);
    if (mMap && mMap.size > 0) {
      const divisor = Math.max(1, mMap.size);
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

export type SpendingTrendsConstituent = {
  id: number;
  name: string;
  total: number;
  avgPerMonth: number;
  pctOfTotal: number;
};

export type SpendingTrendsMonthSegment = {
  id: number;
  name: string;
  amount: number;
};

export type SpendingTrendsMonthPoint = {
  month: string;
  total: number;
  segments: SpendingTrendsMonthSegment[];
};

export type SpendingTrendsResult = {
  months: SpendingTrendsMonthPoint[];
  constituents: SpendingTrendsConstituent[];
  total: number;
  avgPerMonth: number;
  maxMonthSpend: number;
  drillLevel: "all" | "group" | "category";
  currentGroupId: number | null;
  currentGroupName: string | null;
  currentCategoryId: number | null;
  currentCategoryName: string | null;
};

export type SpendingTrendsOptions = {
  drillGroupId?: number | null;
  drillCategoryId?: number | null;
  activeCategoryIds?: Set<number> | null;
};

/**
 * Compute multi-month spending trends across user-selected month range,
 * supporting hierarchical drilldown (All Master Categories -> Subcategories -> Single Category)
 * and category filtering.
 */
export function computeSpendingTrends(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  options: SpendingTrendsOptions = {}
): SpendingTrendsResult {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const monthList = getMonthsBetween(actualStart, actualEnd);
  const numMonths = Math.max(1, monthList.length);

  const { drillGroupId = null, drillCategoryId = null, activeCategoryIds = null } = options;

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const groupMap = new Map(data.groups.map((g) => [g.id, g]));
  const catMap = new Map(data.categories.map((c) => [c.id, c]));

  // Determine current drill level & metadata
  let drillLevel: "all" | "group" | "category" = "all";
  let currentGroupId: number | null = null;
  let currentGroupName: string | null = null;
  let currentCategoryId: number | null = null;
  let currentCategoryName: string | null = null;

  if (drillCategoryId != null) {
    drillLevel = "category";
    currentCategoryId = drillCategoryId;
    const cat = catMap.get(drillCategoryId);
    currentCategoryName = cat?.name ?? "Category";
    if (cat) {
      currentGroupId = cat.groupId;
      currentGroupName = groupMap.get(cat.groupId)?.name ?? null;
    }
  } else if (drillGroupId != null) {
    drillLevel = "group";
    currentGroupId = drillGroupId;
    currentGroupName = groupMap.get(drillGroupId)?.name ?? "Master Category";
  }

  // Group spending by: month -> categoryId -> net spending (outflow - inflow)
  const spendByMonthCat = new Map<string, Map<number, number>>();
  for (const m of monthList) {
    spendByMonthCat.set(m, new Map());
  }

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (t.categoryId == null || t.transferAccountId != null) continue;
    if (isIncomeTransaction(t)) continue;

    // Category filter check
    if (activeCategoryIds && !activeCategoryIds.has(t.categoryId)) continue;

    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    const cat = catMap.get(t.categoryId);
    if (!cat) continue;

    // Drilldown filter checks
    if (drillLevel === "category" && t.categoryId !== currentCategoryId) continue;
    if (drillLevel === "group" && cat.groupId !== currentGroupId) continue;

    const mCatMap = spendByMonthCat.get(mk);
    if (mCatMap) {
      // Amount < 0 is outflow (+ netOutflow); amount > 0 is return (- netOutflow)
      const delta = -num(t.amount);
      mCatMap.set(t.categoryId, (mCatMap.get(t.categoryId) ?? 0) + delta);
    }
  }

  // Build constituents list based on drill level
  const constituentsMap = new Map<number, { id: number; name: string; total: number }>();

  if (drillLevel === "all") {
    // Constituents are category groups (excluding credit card payment groups)
    for (const g of data.groups) {
      if (g.isCreditCardPayments) continue;
      // Check if this group has any categories (or active categories)
      const groupCats = data.categories.filter((c) => c.groupId === g.id);
      if (activeCategoryIds) {
        const hasActive = groupCats.some((c) => activeCategoryIds.has(c.id));
        if (!hasActive && groupCats.length > 0) continue;
      }
      constituentsMap.set(g.id, { id: g.id, name: g.name, total: 0 });
    }
  } else if (drillLevel === "group" && currentGroupId != null) {
    // Constituents are subcategories in this group
    const groupCats = data.categories.filter((c) => c.groupId === currentGroupId);
    for (const c of groupCats) {
      if (activeCategoryIds && !activeCategoryIds.has(c.id)) continue;
      constituentsMap.set(c.id, { id: c.id, name: c.name, total: 0 });
    }
  } else if (drillLevel === "category" && currentCategoryId != null) {
    const cat = catMap.get(currentCategoryId);
    if (cat) {
      constituentsMap.set(cat.id, { id: cat.id, name: cat.name, total: 0 });
    }
  }

  // Calculate monthly points with segments
  const monthPoints: SpendingTrendsMonthPoint[] = [];
  let overallTotal = 0;
  let maxMonthSpend = 0;

  for (const m of monthList) {
    const mCatMap = spendByMonthCat.get(m) ?? new Map<number, number>();
    const segmentSums = new Map<number, number>();

    for (const [catId, rawSpend] of mCatMap.entries()) {
      const spend = Math.max(0, Math.round(rawSpend));
      if (spend <= 0) continue;

      if (drillLevel === "all") {
        const cat = catMap.get(catId);
        if (cat) {
          segmentSums.set(cat.groupId, (segmentSums.get(cat.groupId) ?? 0) + spend);
        }
      } else {
        // group or category drilldown -> by categoryId
        segmentSums.set(catId, (segmentSums.get(catId) ?? 0) + spend);
      }
    }

    const segments: SpendingTrendsMonthSegment[] = [];
    let monthTotal = 0;

    for (const [id, constituent] of constituentsMap.entries()) {
      const amt = segmentSums.get(id) ?? 0;
      if (amt > 0) {
        segments.push({
          id,
          name: constituent.name,
          amount: amt,
        });
        monthTotal += amt;
        constituent.total += amt;
      }
    }

    // Sort segments consistently by constituent order/id
    segments.sort((a, b) => a.id - b.id);

    if (monthTotal > maxMonthSpend) {
      maxMonthSpend = monthTotal;
    }
    overallTotal += monthTotal;

    monthPoints.push({
      month: m,
      total: monthTotal,
      segments,
    });
  }

  // Finalize constituents array sorted by total spend descending
  const constituents: SpendingTrendsConstituent[] = Array.from(constituentsMap.values())
    .map((c) => ({
      id: c.id,
      name: c.name,
      total: c.total,
      avgPerMonth: Math.round(c.total / numMonths),
      pctOfTotal: overallTotal > 0 ? Math.round((c.total / overallTotal) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const avgPerMonth = Math.round(overallTotal / numMonths);

  return {
    months: monthPoints,
    constituents,
    total: overallTotal,
    avgPerMonth,
    maxMonthSpend,
    drillLevel,
    currentGroupId,
    currentGroupName,
    currentCategoryId,
    currentCategoryName,
  };
}

/**
 * Retrieve the individual spending transactions matching drilldown & month filters.
 */
export function getSpendingTransactions(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  filter?: {
    groupId?: number | null;
    categoryId?: number | null;
    month?: string | null;
    activeCategoryIds?: Set<number> | null;
  }
): Transaction[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const catMap = new Map(data.categories.map((c) => [c.id, c]));

  return data.transactions
    .filter((t) => {
      if (splitParentIds.has(t.id)) return false;
      if (t.categoryId == null || t.transferAccountId != null) return false;
      if (isIncomeTransaction(t)) return false;

      const mk = t.date.slice(0, 7);
      if (filter?.month) {
        if (mk !== filter.month) return false;
      } else {
        if (mk < actualStart || mk > actualEnd) return false;
      }

      if (filter?.activeCategoryIds && !filter.activeCategoryIds.has(t.categoryId)) {
        return false;
      }

      if (filter?.categoryId != null) {
        return t.categoryId === filter.categoryId;
      }

      if (filter?.groupId != null) {
        const cat = catMap.get(t.categoryId);
        return cat?.groupId === filter.groupId;
      }

      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}
