/**
 * Pure helpers for the budget grid (slice 1 of the BudgetView split).
 * No hooks, no JSX — safe to unit-test in isolation. The month grid,
 * DnD reorder, inline edit cell, and quick-budget menu stay in
 * `BudgetView.tsx` until later slices.
 */
import { MONTHS, parseMonthKey } from "@ynab/logic";
import type { CategoryGroup } from "@ynab/logic";

export function formatMonthLong(monthKey: string): string {
  const { month0, year } = parseMonthKey(monthKey);
  return `${MONTHS[month0] ?? ""} ${year}`;
}

/**
 * The semantic color of a balance figure: green when funds remain, red
 * when overspent, faint at zero. Color is never the only channel — every
 * negative figure also renders OverspentMarker (MonthCells.tsx), and the
 * amount text itself always carries the sign.
 */
export function balanceColor(n: number): string {
  if (n > 0) return "var(--y-green-dk)";
  if (n < 0) return "var(--y-red)";
  return "var(--y-ink-faint)";
}

export function isInternalGroup(group: CategoryGroup | string): boolean {
  const name = typeof group === "string" ? group : group.name;
  return name === "__Internal__" || name.toLowerCase() === "__internal__";
}

export function isHiddenGroup(group: CategoryGroup | string): boolean {
  if (typeof group === "object" && group !== null) {
    if (group.isHidden !== undefined) return Boolean(group.isHidden);
    return group.name === "Hidden Categories" || group.name?.toLowerCase() === "hidden categories";
  }
  return group === "Hidden Categories" || group.toLowerCase() === "hidden categories";
}

export const COL_A = "w-[120px]";
export const COL_O = "w-[120px]";
export const COL_V = "w-[120px]";
