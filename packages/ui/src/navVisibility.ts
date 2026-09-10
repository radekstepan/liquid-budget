import type { View } from "./Sidebar.js";

/** Menu order of the main navigation views, as shown in the sidebar. */
export const NAV_ORDER: View[] = [
  "budget",
  "reports",
  "calendar",
  "projections",
  "transactions",
];

export type NavItemMeta = {
  key: View;
  label: string;
  description: string;
};

export const NAV_ITEMS: NavItemMeta[] = [
  { key: "budget", label: "Budget", description: "Plan and assign money to categories each month." },
  { key: "reports", label: "Reports", description: "Spending, income and net-worth reports." },
  { key: "calendar", label: "Calendar", description: "See transactions on a monthly calendar." },
  { key: "projections", label: "Projections", description: "Forecast future account balances." },
  { key: "transactions", label: "Transactions", description: "Browse transactions across all accounts." },
];

export const NAV_VISIBILITY_STORAGE_KEY = "ynab:nav:visible";

export const DEFAULT_NAV_VISIBILITY: Record<View, boolean> = {
  budget: true,
  reports: true,
  calendar: true,
  projections: true,
  transactions: true,
};

export function isNavVisibility(val: unknown): val is Record<View, boolean> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const r = val as Record<string, unknown>;
  return NAV_ORDER.every((k) => typeof r[k] === "boolean");
}

export function visibleViewCount(visible: Record<View, boolean>): number {
  return NAV_ORDER.filter((v) => visible[v]).length;
}

/**
 * First visible view in menu order, or null when every view is hidden.
 * Used as the fallback destination when the current view gets hidden.
 */
export function firstAvailableView(visible: Record<View, boolean>): View | null {
  return NAV_ORDER.find((v) => visible[v]) ?? null;
}
