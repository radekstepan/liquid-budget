// apps/web/tests/e2e/reports.spec.ts
//
// Covers ReportsView (packages/ui/src/ReportsView.tsx):
//   - math strip (Income / Expenses / Net) renders with the default
//     April–June range (ReportsView.tsx:168-179)
//   - all four panels render: Net Worth, Spending by Category,
//     Expense Breakdown, Top Payees (ReportsView.tsx:181-265)
//   - the From / To selectors narrow the range and re-totals
//     (ReportsView.tsx:144-164)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();
});

test("renders the math strip and all four panels with the default range", async ({ page }) => {
  await expect(page.getByText("Income", { exact: true })).toBeVisible();
  await expect(page.getByText("Expenses", { exact: true })).toBeVisible();
  await expect(page.getByText("Net", { exact: true }).first()).toBeVisible();

  for (const title of [
    "Net Worth",
    "Spending by Category",
    "Expense Breakdown",
    "Top Payees",
  ]) {
    await expect(
      page.locator(".y-panel-head").filter({ hasText: title })
    ).toBeVisible();
  }
});

test("changing the To selector narrows the range and re-totals Income", async ({ page }) => {
  // The default range covers April–June; the seed has income spread
  // across all three months. Narrowing the range to just June should
  // reduce the Income value.
  const incomeCell = page.locator(".y-mathbox").filter({ has: page.getByText("Income", { exact: true }) });
  const fullIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(fullIncome).toBeTruthy();

  // The "To" select is the second one in the toolbar
  // (ReportsView.tsx:155-164).
  const selects = page.locator(".y-toolbar select");
  await selects.nth(0).selectOption("2026-06");
  await selects.nth(1).selectOption("2026-06");

  const narrowIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(narrowIncome).toBeTruthy();
  expect(narrowIncome).not.toBe(fullIncome);
});
