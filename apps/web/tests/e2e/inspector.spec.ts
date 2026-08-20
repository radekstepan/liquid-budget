// apps/web/tests/e2e/inspector.spec.ts
//
// Covers Inspector chrome (packages/ui/src/Inspector.tsx):
//   - Settings cog opens the menu with "Import YNAB4 Backup"
//   - the Net Monthly panel renders Net Cash Flow, Income, and Expenses
//   - the Net Worth (12 mo) panel renders 12 interactive month jump buttons
//   - the Trends & Insights panel renders
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("Settings cog opens the menu", async ({ page }) => {
  await page.getByTitle("Settings").click();
  await expect(page.getByText("Import YNAB4 Backup")).toBeVisible();
});

test("Net Monthly panel shows cash flow breakdown", async ({ page }) => {
  const panel = page.locator(".y-panel").filter({ hasText: "Net Monthly" });
  await expect(panel.getByText("Net Cash Flow")).toBeVisible();
  await expect(panel.getByText("Income (Inflow)")).toBeVisible();
  await expect(panel.getByText("Expenses (Outflow)")).toBeVisible();
});

test("Net Worth (12 mo) panel renders 12 month buttons", async ({ page }) => {
  const buttons = page
    .locator(".y-panel")
    .filter({ hasText: "Net Worth (12 mo)" })
    .locator('button[aria-label^="Jump to "]');
  await expect(buttons).toHaveCount(12);
});

test("Trends & Insights panel renders", async ({ page }) => {
  const panel = page.locator(".y-panel").filter({ hasText: "Trends & Insights" });
  await expect(panel).toBeVisible();
});
