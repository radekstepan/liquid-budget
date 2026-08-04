// apps/web/tests/e2e/basic.spec.ts
//
// Smoke E2E for the YNAB4-alternative web app. Verifies that:
//   - the Next.js dev server boots and serves `/`
//   - BudgetAppShell finishes its /api/budget fetch and mounts BudgetApp
//   - the Sidebar nav + Inspector "To Be Budgeted" card are present
//
// This is intentionally minimal. Add more specs as the UI surface
// grows. The webServer (playwright.config.ts) starts `next dev` on
// port 3001 against an isolated SQLite file at apps/web/.e2e/budget.db,
// so the dev DB at the repo root is never touched.
import { test, expect } from "@playwright/test";

test("home page loads and renders the budget app", async ({ page }) => {
  await page.goto("/");

  // Document title comes from apps/web/src/app/layout.tsx:5-8.
  await expect(page).toHaveTitle(/Liquid/);

  // Loading state from BudgetAppShell.tsx:208-223 must clear before
  // we can assert on the budget UI. We don't pin to network idle
  // because Next.js streams a shell + RSC payload and the budget fetch
  // happens in a useEffect; the role-based assertions below cover the
  // real success path.
  await expect(
    page.getByText("Loading budget…")
  ).toBeHidden({ timeout: 15_000 });

  // Sidebar nav (Sidebar.tsx:17-24, 80-94) renders a button per view.
  // "Budget" is the default active view on first load. We pin to the
  // nav item with `exact: true` because the Sidebar also has a
  // "Budget Accounts" group header button that matches a partial
  // "Budget" name and would trip strict-mode.
  await expect(
    page.getByRole("button", { name: "Budget", exact: true })
  ).toBeVisible();

  // Inspector card (Inspector.tsx:111-116) shows "To Be Budgeted"
  // (or "Overbudgeted" if the demo data is negative). Either is a
  // valid mount signal. The same text also appears in the Summary
  // panel (Inspector.tsx:136) so we use `.first()` to satisfy
  // strict-mode — both renders are equally valid mount signals.
  await expect(
    page.getByText(/^(To Be Budgeted|Overbudgeted)$/).first()
  ).toBeVisible();

  // Settings cog lives in the Inspector header (Inspector.tsx:57-64).
  await expect(
    page.getByRole("button", { name: "Settings" })
  ).toBeVisible();
});
