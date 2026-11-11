/**
 * reports.ts
 *
 * Pure business logic for financial reports (Net Worth, etc.).
 * No React, no DB access.
 *
 * Spending sub-aggregators (insights collectors, trends drilldown builders,
 * drilldown row filter) live in report-spending.ts; the entry points below
 * stay thin orchestrators. Boundary math (internal-transfer detection, net
 * on-budget deltas) is shared with transfers.ts.
 * SQL counterpart: @ynab/server queries/reports.ts (getReportAggregates) pushes
 * these group-bys into SQLite SUM/GROUP BY for large budgets; the pure fns
 * below stay as the fallback for small/offline bundles.
 */


import type { BudgetData, Transaction } from "./types.js";
import { fmt, num, isValidISODate } from "./format.js";
import { isIncomeTransaction } from "./budget-engine.js";
import { collectSplitParentIds } from "./budget-walk.js";
import { isInternalTransfer, rowNetOnBudgetDelta } from "./transfers.js";
import {
  accumulateSpendingByMonth,
  buildSpendingConstituents,
  buildSpendingMonthPoints,
  buildSpendingScanContext,
  buildTrendInsights,
  collectInsightSpend,
  countAvailableBaselineMonths,
  finalizeSpendingConstituents,
  matchesSpendingTransaction,
  resolveSpendingDrill,
} from "./report-spending.js";
import type { SpendingTransactionFilter } from "./report-spending.js";

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

  // 1. Identify split parents and valid account IDs
  const splitParentIds = collectSplitParentIds(data.transactions);
  const validAccountIds = new Set<number>(data.accounts.map((a) => a.id));
  const earliestMonthByAccount = new Map<number, string>();

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
    // Unknown/deleted accounts are silently skipped (no phantom accounts, no
    // console output — Vitest onConsoleLog throws on any console call).
    // A skipped source leg must not skip the transfer leg below.
    if (validAccountIds.has(t.accountId)) {
      // Track earliest activity month for source account
      const curEarliestSrc = earliestMonthByAccount.get(t.accountId);
      if (!curEarliestSrc || mk < curEarliestSrc) {
        earliestMonthByAccount.set(t.accountId, mk);
      }

      totalDeltas.set(t.accountId, (totalDeltas.get(t.accountId) ?? 0) + amt);
      let srcMonthMap = deltasByMonth.get(mk);
      if (!srcMonthMap) {
        srcMonthMap = new Map<number, number>();
        deltasByMonth.set(mk, srcMonthMap);
      }
      srcMonthMap.set(t.accountId, (srcMonthMap.get(t.accountId) ?? 0) + amt);
    }

    // Transfer destination account delta
    // Unknown/deleted destinations are silently skipped (see above).
    if (t.transferAccountId != null && validAccountIds.has(t.transferAccountId)) {
      const curEarliestDest = earliestMonthByAccount.get(t.transferAccountId);
      if (!curEarliestDest || mk < curEarliestDest) {
        earliestMonthByAccount.set(t.transferAccountId, mk);
      }
      totalDeltas.set(t.transferAccountId, (totalDeltas.get(t.transferAccountId) ?? 0) - amt);
      let srcMonthMap = deltasByMonth.get(mk);
      if (!srcMonthMap) {
        srcMonthMap = new Map<number, number>();
        deltasByMonth.set(mk, srcMonthMap);
      }
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
        if (!validAccountIds.has(accId)) continue;
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
        if (!validAccountIds.has(accId)) continue;
        runningBalances.set(accId, (runningBalances.get(accId) ?? 0) + d);
      }
    }

    let assets = 0;
    let debts = 0;
    for (const a of data.accounts) {
      // Determine the earliest active month for this account:
      // - If explicit `createdAt` is present, use its "YYYY-MM" (or earlier if transactions were backdated before createdAt).
      // - If `createdAt` is omitted, use the earliest recorded transaction month.
      // - If neither is present (e.g. account with base balance and no transactions), retain base balance across all months.
      const createdMonth = a.createdAt?.trim() ? a.createdAt.slice(0, 7) : undefined;
      const earliestTxMonth = earliestMonthByAccount.get(a.id);
      let startMonth: string | undefined;
      if (createdMonth && earliestTxMonth) {
        startMonth = createdMonth < earliestTxMonth ? createdMonth : earliestTxMonth;
      } else {
        startMonth = createdMonth ?? earliestTxMonth;
      }

      if (startMonth && m < startMonth) {
        continue;
      }
      const bal = runningBalances.get(a.id) ?? 0;
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

export type CashFlowRangeSummary = {
  income: number;
  outflow: number;
  net: number;
  savingsRate: number;
};

/**
 * Compute monthly cash flow across a contiguous month range (inclusive)
 * applying budget-boundary logic.
 */
export function computeCashFlowRange(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): CashFlowRangeSummary {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const splitParentIds = collectSplitParentIds(data.transactions);
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  let income = 0;
  let outflow = 0;

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    const amt = num(t.amount);
    // Shared boundary math (transfers.ts): net on-budget delta plus the
    // internal-transfer (same-boundary) exclusion.
    const netOnBudgetDelta = rowNetOnBudgetDelta(t, accountMap);
    const isInternal = isInternalTransfer(t, accountMap);

    if (isIncomeTransaction(t, accountMap)) {
      const incomeAmt = netOnBudgetDelta > 0 ? netOnBudgetDelta : amt;
      income = Math.round(income + incomeAmt);
    } else if (!isInternal) {
      outflow = Math.round(outflow - netOnBudgetDelta);
    }
  }

  const net = Math.round(income - outflow);
  const savingsRate =
    income > 0
      ? Math.round(((income - outflow) / income) * 1000) / 10
      : net > 0
        ? 100
        : 0;

  return { income, outflow, net, savingsRate };
}

/**
 * Compute monthly cash flow (Income vs Outflow, Net, and Savings Rate %).
 */
export function computeCashFlow(data: BudgetData, month: string): CashFlowSummary {
  const flow = computeCashFlowRange(data, month, month);
  return { month, ...flow };
}

export type SurplusMonthPoint = {
  month: string;
  income: number;
  outflow: number;
  /** Income minus outflow for the month (negative = loss). */
  surplus: number;
};

/**
 * Compute the monthly surplus (income minus outflow) for each month in a
 * contiguous range. Each month reuses `computeCashFlowRange`, so the
 * income/outflow semantics — split-parent exclusion, on-budget boundary
 * logic, and internal-transfer exclusion — match the cash-flow summary
 * exactly.
 */
export function computeMonthlySurplus(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): SurplusMonthPoint[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  return getMonthsBetween(actualStart, actualEnd).map((m) => {
    const flow = computeCashFlowRange(data, m, m);
    return { month: m, income: flow.income, outflow: flow.outflow, surplus: flow.net };
  });
}

export type TrendlineFit = {
  /** Least-squares slope: fitted change in value per month-index step. */
  slope: number;
  /** Least-squares intercept: fitted value at month index 0. */
  intercept: number;
  /** Fitted value (`slope * i + intercept`) for each input index. */
  fitted: number[];
};

/**
 * Fit an ordinary least-squares linear trendline over a sequence of monthly
 * values, using the month position (0..n-1) as x. Returns null when fewer
 * than 2 values are available — a line needs at least two points.
 */
export function computeTrendline(values: number[]): TrendlineFit | null {
  const n = values.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i] ?? 0;
    sumX += i;
    sumY += y;
    sumXX += i * i;
    sumXY += i * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const fitted = values.map((_, i) => slope * i + intercept);
  return { slope, intercept, fitted };
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
  /** "mtd" when the comparison is month-to-date aligned, else "full". */
  basis?: "full" | "mtd";
  message: string;
};

export type MonthlyInsightsOptions = {
  /**
   * Wall-clock date (YYYY-MM-DD) used to detect the in-progress month.
   * When the viewed month is the `asOfDate` month, spend is compared
   * same-day-to-same-day instead of month-to-date vs full-month average.
   */
  asOfDate?: string;
};

/**
 * Minimum absolute % change for a trend to be shown. Anything smaller
 * (+0%, +2%, ...) is noise, not a signal worth surfacing.
 */
export const MIN_INSIGHT_PCT_CHANGE = 5;

/**
 * Absolute dollar move vs the baseline: how much was saved or overspent
 * in absolute terms. Used to sort trends (largest move first).
 */
export function insightAbsDiff(
  insight: Pick<SpendingInsight, "amount" | "avgAmount">
): number {
  return Math.abs((insight.amount ?? 0) - (insight.avgAmount ?? 0));
}

/**
 * Compute monthly trends and 3-month average comparisons, sorted by largest
 * absolute dollar move vs the baseline. Trends within `MIN_INSIGHT_PCT_CHANGE`
 * of the baseline are suppressed as noise.
 *
 * When `opts.asOfDate` falls in the viewed month, the month is still in
 * progress, so both sides are cut off at the same day-of-month: current
 * spend through day N is compared against the average spend through day N
 * of the prior months. Categories with no baseline spend through day N
 * (nothing due yet in either period) are suppressed instead of being
 * reported as bogus savings; categories with $0 spend against a positive
 * baseline are reported with -100% so the UI can render them as "$0".
 * Completed past months always compare full month vs full-month average.
 */
export function computeMonthlyInsights(
  data: BudgetData,
  month: string,
  _budgetResult?: unknown,
  opts?: MonthlyInsightsOptions
): SpendingInsight[] {
  const asOfDate = opts?.asOfDate;
  const asOfMonth =
    asOfDate != null && isValidISODate(asOfDate) ? asOfDate.slice(0, 7) : null;

  // Future month: nothing could have been spent yet, so any trend would be
  // a bogus -100%.
  if (asOfMonth != null && month > asOfMonth) {
    return [
      {
        id: "clean-spending",
        type: "clean",
        message: "No trend data yet for a future month",
      },
    ];
  }

  // In-progress month: align both sides at the same day-of-month.
  const cutoffDay =
    asOfMonth === month && asOfDate != null ? Number(asOfDate.slice(8, 10)) : null;

  const ctx = buildSpendingScanContext(data);

  // Spending per category this month vs previous 3 months
  const m1 = getOffsetMonth(month, -1);
  const m2 = getOffsetMonth(month, -2);
  const m3 = getOffsetMonth(month, -3);
  const priorMonths = new Set([m1, m2, m3]);

  const maps = collectInsightSpend(data, ctx, month, priorMonths, cutoffDay);

  // Count how many of the 3 prior months are present in the budget history
  const divisor = countAvailableBaselineMonths([m1, m2, m3], maps.earliestMonth);

  const insights = buildTrendInsights(
    maps,
    divisor,
    new Map(data.categories.map((c) => [c.id, c.name])),
    cutoffDay,
    MIN_INSIGHT_PCT_CHANGE,
    fmt
  );

  // Sort by largest absolute dollar move vs the baseline first
  insights.sort((a, b) => insightAbsDiff(b) - insightAbsDiff(a));

  if (insights.length === 0) {
    insights.push({
      id: "clean-spending",
      type: "clean",
      message:
        cutoffDay != null
          ? "Not enough month-to-date data for trends yet"
          : "Spending is steady within 3-month baseline",
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
  /** Most negative month net (withdrawal) in cents, <= 0. */
  minMonthSpend: number;
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

  const { activeCategoryIds = null } = options;
  const drill = resolveSpendingDrill(data, options);
  const ctx = buildSpendingScanContext(data);

  // Group spending by: month -> categoryId -> net spending (outflow - inflow)
  const spendByMonthCat = accumulateSpendingByMonth(
    data,
    ctx,
    monthList,
    actualStart,
    actualEnd,
    drill,
    activeCategoryIds
  );

  // Build constituents list based on drill level
  const constituentsMap = buildSpendingConstituents(data, drill, activeCategoryIds);

  // Calculate monthly points with segments
  const { monthPoints, overallTotal, maxMonthSpend, minMonthSpend } =
    buildSpendingMonthPoints(
      monthList,
      spendByMonthCat,
      constituentsMap,
      drill.drillLevel,
      ctx.catMap
    );

  // Finalize constituents array sorted by total spend descending
  const constituents = finalizeSpendingConstituents(
    constituentsMap,
    numMonths,
    overallTotal
  );

  const avgPerMonth = Math.round(overallTotal / numMonths);

  return {
    months: monthPoints,
    constituents,
    total: overallTotal,
    avgPerMonth,
    maxMonthSpend,
    minMonthSpend,
    drillLevel: drill.drillLevel,
    currentGroupId: drill.currentGroupId,
    currentGroupName: drill.currentGroupName,
    currentCategoryId: drill.currentCategoryId,
    currentCategoryName: drill.currentCategoryName,
  };
}

/**
 * Retrieve the individual spending transactions matching drilldown & month filters.
 */
export function getSpendingTransactions(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  filter?: SpendingTransactionFilter
): Transaction[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const ctx = buildSpendingScanContext(data);

  return data.transactions
    .filter((t) => matchesSpendingTransaction(t, ctx, actualStart, actualEnd, filter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

// ---------------------------------------------------------------------------
// SQL-aggregation mirror (P1 sql-aggregation).
//
// `buildReportAggregates` is the pure-JS single-pass mirror of the SQLite
// group-bys in `@ynab/server` queries/reports.ts. Parity between the two is
// covered by server tests; the `*FromAggregates` helpers below let report
// screens consume O(months x categories) aggregate rows instead of the full
// transaction list. The full-scan `compute*` fns above remain the fallback.
// ---------------------------------------------------------------------------

export type ReportOutflowAggregate = {
  /** "YYYY-MM" of the transaction date. */
  month: string;
  /** Null = uncategorized outflow (cash-flow relevant, budget-irrelevant). */
  categoryId: number | null;
  /** SUM of net on-budget deltas (negative = spending, positive = refund). */
  total: number;
};

export type ReportIncomeAggregate = {
  /** Transaction month: substr(date, 1, 7) — the cash-flow grouping. */
  month: string;
  /** Budget month: incomeMonth ?? transaction month — the TBB grouping. */
  incomeMonth: string;
  total: number;
};

export type ReportAccountDeltaAggregate = {
  /** "YYYY-MM" of the transaction date. */
  month: string;
  accountId: number;
  total: number;
};

export type ReportAggregates = {
  outflow: ReportOutflowAggregate[];
  income: ReportIncomeAggregate[];
  accountDeltas: ReportAccountDeltaAggregate[];
};

/**
 * Single-pass JS mirror of the SQL aggregates: split-parent exclusion,
 * internal-transfer exclusion, boundary net, and income classification all
 * match queries/reports.ts row-for-row (amounts are integer cents).
 */
export function buildReportAggregates(data: BudgetData): ReportAggregates {
  const splitParentIds = collectSplitParentIds(data.transactions);
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  const outflowByKey = new Map<string, number>();
  const incomeByMonth = new Map<string, number>();
  const deltaByKey = new Map<string, number>();

  for (const t of data.transactions) {
    const isSplitParent = splitParentIds.has(t.id);
    const amt = num(t.amount);
    // Shared boundary math (transfers.ts): plain rows score their on-budget
    // leg, transfer rows their net on-budget delta.
    const net = rowNetOnBudgetDelta(t, accountMap);
    const isInternal = isInternalTransfer(t, accountMap);

    const isIncome =
      isIncomeTransaction(t, accountMap) && (!isSplitParent || t.isIncome === true);

    if (!isSplitParent) {
      const mk = t.date.slice(0, 7);
      const srcKey = `${mk}|${t.accountId}`;
      deltaByKey.set(srcKey, (deltaByKey.get(srcKey) ?? 0) + amt);
      if (t.transferAccountId != null) {
        const dstKey = `${mk}|${t.transferAccountId}`;
        deltaByKey.set(dstKey, (deltaByKey.get(dstKey) ?? 0) - amt);
      }
    }

    if (!isSplitParent && !isInternal && net !== 0 && !isIncome) {
      const mk = t.date.slice(0, 7);
      const key = `${mk}|${t.categoryId ?? ""}`;
      outflowByKey.set(key, (outflowByKey.get(key) ?? 0) + net);
    }

    if (isIncome) {
      const mk = t.date.slice(0, 7);
      const incomeMonth = t.incomeMonth || mk;
      const incomeAmt = net > 0 ? net : amt;
      const key = `${mk}|${incomeMonth}`;
      incomeByMonth.set(key, (incomeByMonth.get(key) ?? 0) + incomeAmt);
    }
  }

  const outflow: ReportOutflowAggregate[] = Array.from(outflowByKey.entries()).map(
    ([key, total]) => {
      const sep = key.indexOf("|");
      const month = key.slice(0, sep);
      const catPart = key.slice(sep + 1);
      return { month, categoryId: catPart === "" ? null : Number(catPart), total };
    }
  );
  outflow.sort(
    (a, b) => a.month.localeCompare(b.month) || (a.categoryId ?? -1) - (b.categoryId ?? -1)
  );

  const income: ReportIncomeAggregate[] = Array.from(incomeByMonth.entries()).map(
    ([key, total]) => {
      const sep = key.indexOf("|");
      return { month: key.slice(0, sep), incomeMonth: key.slice(sep + 1), total };
    }
  );
  income.sort((a, b) => a.month.localeCompare(b.month) || a.incomeMonth.localeCompare(b.incomeMonth));

  const accountDeltas: ReportAccountDeltaAggregate[] = Array.from(deltaByKey.entries()).map(
    ([key, total]) => {
      const sep = key.indexOf("|");
      return { month: key.slice(0, sep), accountId: Number(key.slice(sep + 1)), total };
    }
  );
  accountDeltas.sort(
    (a, b) => a.month.localeCompare(b.month) || a.accountId - b.accountId
  );

  return { outflow, income, accountDeltas };
}

/**
 * Cash-flow summary over a month range from pre-aggregated rows instead of
 * the full transaction list. Income is grouped by *transaction* month (the
 * `month` key), matching `computeCashFlowRange`, which attributes income to
 * the month it posted — not the deferred `incomeMonth` the budget engine
 * uses for TBB (available on each row as `incomeMonth` for that grouping).
 * `outflow` nets are negative spending, so the reported outflow is their
 * negation.
 */
export function computeCashFlowRangeFromAggregates(
  aggregates: ReportAggregates,
  startMonth: string,
  endMonth: string
): CashFlowRangeSummary {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  let income = 0;
  for (const row of aggregates.income) {
    if (row.month >= actualStart && row.month <= actualEnd) income += row.total;
  }
  let outflowNet = 0;
  for (const row of aggregates.outflow) {
    if (row.month >= actualStart && row.month <= actualEnd) outflowNet += row.total;
  }
  const outflow = -outflowNet;
  const net = Math.round(income - outflow);
  const savingsRate =
    income > 0
      ? Math.round(((income - outflow) / income) * 1000) / 10
      : net > 0
        ? 100
        : 0;
  return { income, outflow, net, savingsRate };
}

/** Single-month cash flow from aggregates (mirrors `computeCashFlow`). */
export function computeCashFlowFromAggregates(
  aggregates: ReportAggregates,
  month: string
): CashFlowSummary {
  return { month, ...computeCashFlowRangeFromAggregates(aggregates, month, month) };
}

/** Monthly surplus series from aggregates (mirrors `computeMonthlySurplus`). */
export function computeMonthlySurplusFromAggregates(
  aggregates: ReportAggregates,
  startMonth: string,
  endMonth: string
): SurplusMonthPoint[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  return getMonthsBetween(actualStart, actualEnd).map((m) => {
    const flow = computeCashFlowRangeFromAggregates(aggregates, m, m);
    return { month: m, income: flow.income, outflow: flow.outflow, surplus: flow.net };
  });
}
