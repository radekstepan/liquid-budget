"use client";

import { useCallback, useMemo } from "react";
import type { BudgetData, BudgetResult } from "@ynab/logic";
import { monthKey, num, parseMonthKey, previousMonthKey } from "@ynab/logic";
import { isInternalGroup } from "./BudgetView.js";

export type QuickBudgetType = "lastMonth" | "spentLastMonth" | "avgBudgeted" | "clear";

function lastMonthMapFor(
  assignments: BudgetData["assignments"],
  targetMonth: string
): Map<number, number> {
  const prevMonth = previousMonthKey(targetMonth);
  const map = new Map<number, number>();
  for (const a of assignments) {
    if (a.month === prevMonth) {
      map.set(a.categoryId, num(a.amount));
    }
  }
  return map;
}

function spentLastMonthMapFor(
  transactions: BudgetData["transactions"],
  targetMonth: string
): Map<number, number> {
  const prevMonth = previousMonthKey(targetMonth);
  const map = new Map<number, number>();
  const parentSet = new Set<number>();
  for (const t of transactions) {
    if (t.parentId != null) parentSet.add(t.parentId);
  }
  for (const t of transactions) {
    if (t.date.slice(0, 7) !== prevMonth) continue;
    if (t.categoryId == null) continue;
    if (parentSet.has(t.id)) continue;
    const amt = num(t.amount);
    if (amt < 0) {
      map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
    }
  }
  return map;
}

function avgBudgetedMapFor(
  assignments: BudgetData["assignments"],
  targetMonth: string
): Map<number, number> {
  const { year: y, month0 } = parseMonthKey(targetMonth);
  const map = new Map<number, { sum: number; count: number }>();
  for (let i = 1; i <= 3; i++) {
    const mm = ((month0 - i) % 12 + 12) % 12;
    const yy = y + Math.floor((month0 - i) / 12);
    const key = monthKey(yy, mm);
    for (const a of assignments) {
      if (a.month !== key) continue;
      const amt = num(a.amount);
      const entry = map.get(a.categoryId) ?? { sum: 0, count: 0 };
      entry.sum += amt;
      entry.count++;
      map.set(a.categoryId, entry);
    }
  }
  const result = new Map<number, number>();
  for (const [catId, { sum, count }] of map) {
    if (count > 0) result.set(catId, Math.round(sum / count));
  }
  return result;
}

export type QuickAssign = (categoryId: number, amount: number, m?: string) => Promise<void>;

/**
 * Quick-budget ("budget the way I did before") view-model: per-category
 * source maps (last month, spent last month, average budgeted,
 * underfunded), per-month display totals, and the applier. All figures
 * are relative to each target column, not the anchor month.
 */
export function useQuickBudget(args: {
  data: BudgetData;
  month: string;
  visibleMonths: string[];
  isBudgetView: boolean;
  selectedCategoryId: number | null;
  budget: BudgetResult;
  assign: QuickAssign;
  batchAssign?: (items: { categoryId: number; amount: number; month: string }[]) => Promise<void>;
}) {
  const { data, month, visibleMonths, isBudgetView, selectedCategoryId, budget, assign, batchAssign } = args;
  // Quick-fill: last month's budgeted per category (only computed for budget view)
  const lastMonthAssignments = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const prevMonth = previousMonthKey(month);
    const map = new Map<number, number>();
    for (const a of data.assignments) {
      if (a.month === prevMonth) {
        map.set(a.categoryId, num(a.amount));
      }
    }
    return map;
  }, [data, month, isBudgetView]);

  // Quick-fill: spent last month (outflows in M-1) per category (only computed for budget view)
  const spentLastMonthByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const prevMonth = previousMonthKey(month);
    const map = new Map<number, number>();
    const parentSet = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) parentSet.add(t.parentId);
    }
    for (const t of data.transactions) {
      if (t.date.slice(0, 7) !== prevMonth) continue;
      if (t.categoryId == null) continue;
      if (parentSet.has(t.id)) continue;
      const amt = num(t.amount);
      if (amt < 0) {
        map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
      }
    }
    return map;
  }, [data, month, isBudgetView]);

  // Quick-fill: average spent (outflow) over last 3 months per category (only computed for budget view)
  const avgSpentByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const { year: y, month0 } = parseMonthKey(month);
    const map = new Map<number, number>();
    const parentSet = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) parentSet.add(t.parentId);
    }
    for (let i = 1; i <= 3; i++) {
      const mm = ((month0 - i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 - i) / 12);
      const key = monthKey(yy, mm);
      for (const t of data.transactions) {
        if (t.date.slice(0, 7) !== key) continue;
        if (t.categoryId == null) continue;
        // Skip split parents so we do not double-count, but include split children!
        if (parentSet.has(t.id)) continue;
        const amt = num(t.amount);
        if (amt >= 0) continue; // only outflows
        map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
      }
    }
    const result = new Map<number, number>();
    for (const [catId, sum] of map) {
      if (sum > 0) {
        result.set(catId, Math.round(sum / 3));
      }
    }
    return result;
  }, [data, month, isBudgetView]);

  // Quick-fill: average budgeted over last 3 months per category (only computed for budget view)
  const avgBudgetedByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const { year: y, month0 } = parseMonthKey(month);
    const map = new Map<number, { sum: number; count: number }>();
    for (let i = 1; i <= 3; i++) {
      const mm = ((month0 - i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 - i) / 12);
      const key = monthKey(yy, mm);
      for (const a of data.assignments) {
        if (a.month !== key) continue;
        const amt = num(a.amount);
        const entry = map.get(a.categoryId) ?? { sum: 0, count: 0 };
        entry.sum += amt;
        entry.count++;
        map.set(a.categoryId, entry);
      }
    }
    const result = new Map<number, number>();
    for (const [catId, { sum, count }] of map) {
      if (count > 0) result.set(catId, Math.round(sum / count));
    }
    return result;
  }, [data, month, isBudgetView]);

  // Quick-fill: underfunded = max(0, goalTarget - available)
  const underfundedByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const map = new Map<number, number>();
    for (const g of budget.groups) {
      for (const r of g.rows) {
        if (r.category.goalTarget) {
          const goal = num(r.category.goalTarget);
          const underfunded = Math.max(0, goal - r.available);
          if (underfunded > 0) map.set(r.category.id, underfunded);
        }
      }
    }
    return map;
  }, [budget, isBudgetView]);

  // Per-month quick-budget source maps, keyed by target month. Each month's
  // "last month" / "spent last month" / "average budgeted" figures are
  // relative to that column, not to the anchor month.
  const quickMapsByMonth = useMemo(() => {
    if (!isBudgetView) return {} as Record<string, { lastMonth: Map<number, number>; spentLastMonth: Map<number, number>; avgBudgeted: Map<number, number> }>;
    const out: Record<string, { lastMonth: Map<number, number>; spentLastMonth: Map<number, number>; avgBudgeted: Map<number, number> }> = {};
    for (const m of visibleMonths) {
      out[m] = {
        lastMonth: lastMonthMapFor(data.assignments, m),
        spentLastMonth: spentLastMonthMapFor(data.transactions, m),
        avgBudgeted: avgBudgetedMapFor(data.assignments, m),
      };
    }
    return out;
  }, [data.assignments, data.transactions, visibleMonths, isBudgetView]);

  // Display totals per visible month for the header dropdowns. When a
  // category is selected the figures cover just that category, otherwise
  // they cover the entire budget (same scope the action applies to).
  const quickBudgetByMonth = useMemo(() => {
    const out: Record<string, { lastMonth: number; spentLastMonth: number; avgBudgeted: number }> = {};
    for (const m of visibleMonths) {
      const maps = quickMapsByMonth[m];
      if (!maps) continue;
      if (selectedCategoryId != null) {
        out[m] = {
          lastMonth: maps.lastMonth.get(selectedCategoryId) ?? 0,
          spentLastMonth: maps.spentLastMonth.get(selectedCategoryId) ?? 0,
          avgBudgeted: maps.avgBudgeted.get(selectedCategoryId) ?? 0,
        };
      } else {
        let lastMonth = 0;
        for (const v of maps.lastMonth.values()) lastMonth += v;
        let spentLastMonth = 0;
        for (const v of maps.spentLastMonth.values()) spentLastMonth += v;
        let avgBudgeted = 0;
        for (const v of maps.avgBudgeted.values()) avgBudgeted += v;
        out[m] = { lastMonth, spentLastMonth, avgBudgeted };
      }
    }
    return out;
  }, [quickMapsByMonth, visibleMonths, selectedCategoryId]);

  const handleQuickBudget = useCallback(
    async (type: QuickBudgetType, catId?: number, targetMonth?: string) => {
      const target = targetMonth ?? month;
      const cached = quickMapsByMonth[target];
      const lastMonthMap = cached?.lastMonth ?? lastMonthMapFor(data.assignments, target);
      const spentLastMonthMap =
        cached?.spentLastMonth ?? spentLastMonthMapFor(data.transactions, target);
      const avgBudgetedMap =
        cached?.avgBudgeted ?? avgBudgetedMapFor(data.assignments, target);
      const getAmount = (categoryId: number): number => {
        switch (type) {
          case "lastMonth":
            return lastMonthMap.get(categoryId) ?? 0;
          case "spentLastMonth":
            return spentLastMonthMap.get(categoryId) ?? 0;
          case "avgBudgeted":
            return avgBudgetedMap.get(categoryId) ?? 0;
          case "clear":
            return 0;
        }
      };

      if (catId != null) {
        await assign(catId, getAmount(catId), target);
        return;
      }

      // Apply to all categories in visible structure groups
      const allBudgetCats: number[] = [];
      for (const g of budget.groups) {
        if (g.group.isCreditCardPayments || isInternalGroup(g.group)) continue;
        for (const r of g.rows) {
          allBudgetCats.push(r.category.id);
        }
      }

      const itemsToAssign: { categoryId: number; amount: number; month: string }[] = [];
      for (const cId of allBudgetCats) {
        const amt = getAmount(cId);
        // Apply if there's an amount or if resetting to zero
        if (amt > 0 || type === "clear") {
          itemsToAssign.push({ categoryId: cId, amount: amt, month: target });
        }
      }

      if (itemsToAssign.length === 0) return;

      if (batchAssign) {
        try {
          await batchAssign(itemsToAssign);
        } catch {
          // Handled via notifications toast and rollback in BudgetAppShell
        }
      } else {
        for (const item of itemsToAssign) {
          await assign(item.categoryId, item.amount, item.month);
        }
      }
    },
    [
      assign,
      batchAssign,
      budget.groups,
      data.assignments,
      data.transactions,
      quickMapsByMonth,
      month,
    ]
  );
  return {
    lastMonthAssignments,
    spentLastMonthByCategory,
    avgSpentByCategory,
    avgBudgetedByCategory,
    underfundedByCategory,
    quickBudgetByMonth,
    handleQuickBudget,
  };
}
