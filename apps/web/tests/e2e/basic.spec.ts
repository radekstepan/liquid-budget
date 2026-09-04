// apps/web/tests/e2e/basic.spec.ts
//
// Smoke E2E for the YNAB4-alternative web app. Verifies that:
//   - the Next.js dev server boots and serves `/`
//   - BudgetAppShell finishes its /api/budget fetch and mounts BudgetApp
//   - the Sidebar nav + Inspector sidebar are present
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
    page.getByText("Loading budget")
  ).toBeHidden({ timeout: 15_000 });

  // Sidebar nav (Sidebar.tsx:17-24, 80-94) renders a button per view.
  // "Budget" is the default active view on first load. We pin to the
  // nav item with `exact: true` because the Sidebar also has a
  // "Budget Accounts" group header button that matches a partial
  // "Budget" name and would trip strict-mode.
  await expect(
    page.getByRole("button", { name: "Budget", exact: true })
  ).toBeVisible();

  // Inspector sidebar (Inspector.tsx) mounts — the "To Be Budgeted" /
  // "Overbudgeted" banner was removed, so the Net Monthly panel is the
  // mount signal instead.
  await expect(
    page.locator(".y-inspector").getByText("Net Monthly")
  ).toBeVisible();

  // Settings cog lives in the Inspector header (Inspector.tsx:57-64).
  await expect(
    page.getByTitle("Settings")
  ).toBeVisible();
});
