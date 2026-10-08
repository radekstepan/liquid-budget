import { isValidISOMonth, monthLabel } from "./format.js";

/**
 * Client-navigable top-level views. Each maps to a nice-URL path segment
 * (`/budget/:month`, `/reports`, `/transactions/:accountId?`).
 */
export type AppView = "budget" | "reports" | "transactions";

export const APP_TITLE_BASE = "Liquid";

/**
 * Tab title for the current view, most-specific context first:
 * "October 2026 Budget - Liquid", "EQ Bank Transactions - Liquid".
 * Navigation is client-side via pushState so BudgetApp applies this with
 * `document.title` whenever the URL-driven view state changes; the slug
 * page's `generateMetadata` reuses it for the server-rendered title on
 * full loads.
 */
export function buildPageTitle(
  view: AppView,
  opts?: { month?: string; accountName?: string | null }
): string {
  let leading: string;
  if (view === "budget") {
    leading =
      opts?.month != null && isValidISOMonth(opts.month)
        ? `${monthLabel(opts.month)} Budget`
        : "Budget";
  } else if (view === "transactions") {
    const accountName = opts?.accountName?.trim();
    leading = accountName ? `${accountName} Transactions` : "All Transactions";
  } else {
    leading = "Reports";
  }
  return `${leading} - ${APP_TITLE_BASE}`;
}
