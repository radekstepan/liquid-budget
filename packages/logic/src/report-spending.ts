/**
 * report-spending.ts
 *
 * Spending-report sub-aggregators extracted from reports.ts (P2 decompose):
 * shared scan context + row predicate, monthly-insights collectors, and
 * spending-trends drilldown/accumulation builders. Pure: no React, no DB
 * access. reports.ts keeps the public `compute*` entry points as thin
 * orchestrators over these helpers; the SQL counterpart that pushes the
 * same group-bys into SQLite lives in @ynab/server queries/reports.ts.
 */

import type { Account, BudgetData, Category, CategoryGroup, Transaction } from "./types.js";
import { num } from "./format.js";
import { isIncomeTransaction } from "./budget-engine.js";
import { collectCCGroupIds, collectSplitParentIds } from "./budget-walk.js";
import type {
  SpendingInsight,
  SpendingTrendsConstituent,
  SpendingTrendsMonthPoint,
  SpendingTrendsMonthSegment,
  SpendingTrendsOptions,
} from "./reports.js";

/** Drilldown scoping for a spending-transaction listing. */
export type SpendingTransactionFilter = {
  groupId?: number | null;
  categoryId?: number | null;
  month?: string | null;
  activeCategoryIds?: Set<number> | null;
};

/** Shared lookup maps for spending scans (built once per entry call). */
export type SpendingScanContext = {
  groupMap: Map<number, CategoryGroup>;
  catMap: Map<number, Category>;
  accountMap: Map<number, Account>;
  splitParentIds: Set<number>;
  ccGroupIds: Set<number>;
};

/** Build the shared scan context for a spending pass over `data`. */
export function buildSpendingScanContext(data: BudgetData): SpendingScanContext {
  return {
    groupMap: new Map(data.groups.map((g) => [g.id, g])),
    catMap: new Map(data.categories.map((c) => [c.id, c])),
    accountMap: new Map(data.accounts.map((a) => [a.id, a])),
    splitParentIds: collectSplitParentIds(data.transactions),
    ccGroupIds: collectCCGroupIds(data.groups),
  };
}

/**
 * True when the row counts as report spending: not a split parent, categorized,
 * and not income. With `skipCCPayments`, rows in Credit Card Payments groups
 * are excluded (top-level "all" views and monthly insights never attribute
 * payoff plumbing as spending).
 */
export function isReportSpendingRow(
  t: Transaction,
  ctx: SpendingScanContext,
  opts?: { skipCCPayments?: boolean }
): boolean {
  if (ctx.splitParentIds.has(t.id)) return false;
  if (t.categoryId == null) return false;
  if (isIncomeTransaction(t, ctx.accountMap)) return false;
  if (opts?.skipCCPayments) {
    const cat = ctx.catMap.get(t.categoryId);
    if (cat != null && ctx.ccGroupIds.has(cat.groupId)) return false;
  }
  return true;
}

/** Net outflow of a spending row in cents (outflow positive, refund negative). */
export function spendingNetOutflow(t: Transaction): number {
  return -num(t.amount);
}

// ---------------------------------------------------------------------------
// Monthly insights
// ---------------------------------------------------------------------------

/** Per-category spend maps feeding trend evaluation. */
export type InsightSpendMaps = {
  currentSpendByCat: Map<number, number>;
  priorSpendByCatMonth: Map<number, Map<string, number>>;
  earliestMonth: string | null;
};

/**
 * Collect this-month vs prior-months per-category spend. Same-day alignment
 * for an in-progress month: rows after `cutoffDay` are ignored on both sides,
 * including future-dated entries this month. CC-payment groups are always
 * skipped (payoff plumbing is not spending).
 */
export function collectInsightSpend(
  data: BudgetData,
  ctx: SpendingScanContext,
  month: string,
  priorMonths: ReadonlySet<string>,
  cutoffDay: number | null
): InsightSpendMaps {
  const currentSpendByCat = new Map<number, number>();
  const priorSpendByCatMonth = new Map<number, Map<string, number>>();
  let earliestMonth: string | null = null;

  for (const t of data.transactions) {
    if (!isReportSpendingRow(t, ctx, { skipCCPayments: true })) continue;

    const netOutflow = spendingNetOutflow(t);
    const mk = t.date.slice(0, 7);
    if (earliestMonth == null || mk < earliestMonth) {
      earliestMonth = mk;
    }

    // Same-day alignment for the in-progress month: ignore spend after the
    // cutoff day on both sides, including future-dated entries this month.
    if (cutoffDay != null && Number(t.date.slice(8, 10)) > cutoffDay) continue;

    const categoryId = t.categoryId as number;
    if (mk === month) {
      currentSpendByCat.set(
        categoryId,
        (currentSpendByCat.get(categoryId) ?? 0) + netOutflow
      );
    } else if (priorMonths.has(mk)) {
      let mMap = priorSpendByCatMonth.get(categoryId);
      if (!mMap) {
        mMap = new Map();
        priorSpendByCatMonth.set(categoryId, mMap);
      }
      mMap.set(mk, (mMap.get(mk) ?? 0) + netOutflow);
    }
  }

  return { currentSpendByCat, priorSpendByCatMonth, earliestMonth };
}

/** Baseline month count available in history (prior months >= earliestMonth). */
export function countAvailableBaselineMonths(
  priorMonths: readonly string[],
  earliestMonth: string | null
): number {
  if (earliestMonth == null) return 0;
  return priorMonths.filter((m) => m >= earliestMonth).length;
}

/**
 * Evaluate per-category trends against the `divisor`-month baseline average.
 * Mid-month net-refund spend is timing noise (returns posted before the
 * corresponding purchases) and skipped; exact $0 against a positive baseline
 * is kept as an informative "$0" row. Near-zero changes under
 * `minPctChange` are noise, not trends. Unsorted; caller sorts/fallbacks.
 */
export function buildTrendInsights(
  maps: InsightSpendMaps,
  divisor: number,
  catNameById: Map<number, string>,
  cutoffDay: number | null,
  minPctChange: number,
  formatAmount: (cents: number) => string
): SpendingInsight[] {
  const insights: SpendingInsight[] = [];
  if (divisor <= 0) return insights;

  // Evaluate all categories that had spend either in the current month or in prior baseline months
  const candidateCatIds = new Set<number>([
    ...maps.currentSpendByCat.keys(),
    ...maps.priorSpendByCatMonth.keys(),
  ]);

  // Calculate baseline average and % difference for categories
  for (const catId of candidateCatIds) {
    const currentSpend = maps.currentSpendByCat.get(catId) ?? 0;
    const mMap = maps.priorSpendByCatMonth.get(catId);
    if (mMap && mMap.size > 0) {
      const totalPriorSpend = Array.from(mMap.values()).reduce((a, b) => a + b, 0);
      const avg3mo = Math.round(totalPriorSpend / divisor);
      if (avg3mo > 0) {
        // Mid-month net-refund spend is timing noise (returns posted
        // before the corresponding purchases). Exact $0 is kept: against
        // a positive baseline it renders as an informative "$0" row.
        if (cutoffDay != null && currentSpend < 0) continue;
        const pct = Math.round(((currentSpend - avg3mo) / avg3mo) * 100);
        // Near-zero changes are noise, not trends.
        if (Math.abs(pct) < minPctChange) continue;
        const name = catNameById.get(catId) ?? "Unknown";
        const baselineLabel = cutoffDay != null ? "MTD 3-mo avg" : "3-mo avg";
        insights.push({
          id: `trend-${catId}`,
          type: "trend",
          categoryId: catId,
          categoryName: name,
          amount: currentSpend,
          avgAmount: avg3mo,
          pctChange: pct,
          basis: cutoffDay != null ? "mtd" : "full",
          message: `${name}: ${formatAmount(currentSpend)} (${pct >= 0 ? "+" : ""}${pct}% vs ${baselineLabel})`,
        });
      }
    }
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Spending trends drilldown
// ---------------------------------------------------------------------------

/** Resolved drilldown level + metadata for a spending-trends query. */
export type SpendingDrill = {
  drillLevel: "all" | "group" | "category";
  currentGroupId: number | null;
  currentGroupName: string | null;
  currentCategoryId: number | null;
  currentCategoryName: string | null;
};

/** Resolve the drill level from explicit group/category selection. */
export function resolveSpendingDrill(
  data: BudgetData,
  options: SpendingTrendsOptions = {}
): SpendingDrill {
  const { drillGroupId = null, drillCategoryId = null } = options;
  const groupMap = new Map(data.groups.map((g) => [g.id, g]));
  const catMap = new Map(data.categories.map((c) => [c.id, c]));

  if (drillCategoryId != null) {
    const cat = catMap.get(drillCategoryId);
    return {
      drillLevel: "category",
      currentGroupId: cat?.groupId ?? null,
      currentGroupName: cat ? (groupMap.get(cat.groupId)?.name ?? null) : null,
      currentCategoryId: drillCategoryId,
      currentCategoryName: cat?.name ?? "Category",
    };
  }
  if (drillGroupId != null) {
    return {
      drillLevel: "group",
      currentGroupId: drillGroupId,
      currentGroupName: groupMap.get(drillGroupId)?.name ?? "Master Category",
      currentCategoryId: null,
      currentCategoryName: null,
    };
  }
  return {
    drillLevel: "all",
    currentGroupId: null,
    currentGroupName: null,
    currentCategoryId: null,
    currentCategoryName: null,
  };
}

/**
 * Accumulate month -> categoryId -> net spending (outflow - inflow) for rows
 * in range passing the drilldown + active-category filters. Top-level "all"
 * skips CC-payment groups to match the constituents below.
 */
export function accumulateSpendingByMonth(
  data: BudgetData,
  ctx: SpendingScanContext,
  monthList: readonly string[],
  actualStart: string,
  actualEnd: string,
  drill: SpendingDrill,
  activeCategoryIds: Set<number> | null
): Map<string, Map<number, number>> {
  const spendByMonthCat = new Map<string, Map<number, number>>();
  for (const m of monthList) {
    spendByMonthCat.set(m, new Map());
  }

  for (const t of data.transactions) {
    if (!isReportSpendingRow(t, ctx, { skipCCPayments: drill.drillLevel === "all" })) {
      continue;
    }

    // Category filter check
    if (activeCategoryIds && !activeCategoryIds.has(t.categoryId as number)) continue;

    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    const cat = ctx.catMap.get(t.categoryId as number);
    if (!cat) continue;

    // Drilldown filter checks
    if (drill.drillLevel === "category" && t.categoryId !== drill.currentCategoryId) continue;
    if (drill.drillLevel === "group" && cat.groupId !== drill.currentGroupId) continue;

    const mCatMap = spendByMonthCat.get(mk);
    if (mCatMap) {
      // Amount < 0 is outflow (+ netOutflow); amount > 0 is return (- netOutflow)
      const delta = spendingNetOutflow(t);
      const categoryId = t.categoryId as number;
      mCatMap.set(categoryId, (mCatMap.get(categoryId) ?? 0) + delta);
    }
  }

  return spendByMonthCat;
}

/** Constituent accumulator (group- or category-shaped depending on drill). */
export type SpendingConstituentAccum = Map<number, { id: number; name: string; total: number }>;

/**
 * Build the zero-initialized constituent set for the drill level: category
 * groups at "all" (excluding CC-payment groups), subcategories at "group",
 * the single category at "category".
 */
export function buildSpendingConstituents(
  data: BudgetData,
  drill: SpendingDrill,
  activeCategoryIds: Set<number> | null
): SpendingConstituentAccum {
  const constituentsMap: SpendingConstituentAccum = new Map();

  if (drill.drillLevel === "all") {
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
  } else if (drill.drillLevel === "group" && drill.currentGroupId != null) {
    // Constituents are subcategories in this group
    const groupCats = data.categories.filter((c) => c.groupId === drill.currentGroupId);
    for (const c of groupCats) {
      if (activeCategoryIds && !activeCategoryIds.has(c.id)) continue;
      constituentsMap.set(c.id, { id: c.id, name: c.name, total: 0 });
    }
  } else if (drill.drillLevel === "category" && drill.currentCategoryId != null) {
    const cat = data.categories.find((c) => c.id === drill.currentCategoryId);
    if (cat) {
      constituentsMap.set(cat.id, { id: cat.id, name: cat.name, total: 0 });
    }
  }

  return constituentsMap;
}

/** Monthly points plus range rollups built from per-month category spend. */
export type SpendingMonthPoints = {
  monthPoints: SpendingTrendsMonthPoint[];
  overallTotal: number;
  maxMonthSpend: number;
  minMonthSpend: number;
};

/**
 * Fold per-month category spend into constituent segments. At "all" the
 * segment key is the parent group id, otherwise the category id. Zero months
 * still emit a point (empty segments) so the timeline stays contiguous.
 * Mutates `constituentsMap` totals as it goes (mirrors the single-pass
 * original); call {@link finalizeSpendingConstituents} after.
 */
export function buildSpendingMonthPoints(
  monthList: readonly string[],
  spendByMonthCat: Map<string, Map<number, number>>,
  constituentsMap: SpendingConstituentAccum,
  drillLevel: SpendingDrill["drillLevel"],
  catMap: Map<number, Category>
): SpendingMonthPoints {
  const monthPoints: SpendingTrendsMonthPoint[] = [];
  let overallTotal = 0;
  let maxMonthSpend = 0;
  let minMonthSpend = 0;

  for (const m of monthList) {
    const mCatMap = spendByMonthCat.get(m) ?? new Map<number, number>();
    const segmentSums = new Map<number, number>();

    for (const [catId, rawSpend] of mCatMap.entries()) {
      const spend = Math.round(rawSpend);
      if (spend === 0) continue;

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
      if (amt !== 0) {
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
    if (monthTotal < minMonthSpend) {
      minMonthSpend = monthTotal;
    }
    overallTotal += monthTotal;

    monthPoints.push({
      month: m,
      total: monthTotal,
      segments,
    });
  }

  return { monthPoints, overallTotal, maxMonthSpend, minMonthSpend };
}

/**
 * Finalize the constituent accumulators into spend-descending constituents
 * with per-month averages and share-of-total.
 */
export function finalizeSpendingConstituents(
  constituentsMap: SpendingConstituentAccum,
  numMonths: number,
  overallTotal: number
): SpendingTrendsConstituent[] {
  return Array.from(constituentsMap.values())
    .map((c) => ({
      id: c.id,
      name: c.name,
      total: c.total,
      avgPerMonth: Math.round(c.total / numMonths),
      pctOfTotal: overallTotal > 0 ? Math.round((c.total / overallTotal) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Drilldown row filter (mirrors the computeSpendingTrends accumulation)
// ---------------------------------------------------------------------------

/**
 * True when the row belongs in a drilldown listing: same spending
 * definition as the trends accumulation (split-parent/income excluded, CC
 * groups skipped only when no explicit group/category filter is set), plus
 * the month window or single-month pin and the active-category allowlist.
 */
export function matchesSpendingTransaction(
  t: Transaction,
  ctx: SpendingScanContext,
  actualStart: string,
  actualEnd: string,
  filter?: SpendingTransactionFilter
): boolean {
  if (ctx.splitParentIds.has(t.id)) return false;
  if (t.categoryId == null) return false;
  if (isIncomeTransaction(t, ctx.accountMap)) return false;

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
    const cat = ctx.catMap.get(t.categoryId);
    return cat?.groupId === filter.groupId;
  }

  // No explicit category/group filter -> top-level "all" drilldown.
  // Skip CC-payment groups to match computeSpendingTrends.
  const cat = ctx.catMap.get(t.categoryId);
  if (!cat) return false;
  if (ctx.ccGroupIds.has(cat.groupId)) return false;

  return true;
}
