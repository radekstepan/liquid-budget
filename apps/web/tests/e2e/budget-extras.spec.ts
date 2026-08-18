// apps/web/tests/e2e/budget-extras.spec.ts
//
// Covers BudgetView features not tested in budget.spec.ts:
//   - Quick Fill popover menu on category budget cells (BudgetView.tsx:970-1085)
//   - "Today" toolbar button jumping back to the current month (BudgetView.tsx:214-218)
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("Quick Fill menu applies Set to Zero and updates category assignment", async ({ page }) => {
  // Target the Rent row which has a non-zero assignment in the seed
  const rentRow = page.getByRole("row").filter({ hasText: "Rent" }).first();
  await expect(rentRow).toBeVisible();

  // Click the quick budget options button inside the budgeted cell
  const quickFillBtn = rentRow.getByRole("button", { name: "Quick budget options" }).first();
  await quickFillBtn.click({ force: true });

  // Quick fill dropdown appears
  const dropdown = page.locator(".y-menu-item").filter({ hasText: "Set to Zero" }).first();
  await expect(dropdown).toBeVisible();

  // Click "Set to Zero"
  await dropdown.click();

  // The budgeted cell now reflects $0.00
  const budgetedCell = rentRow.locator("button.y-inline-amt").first();
  await expect(budgetedCell).toHaveText("$0.00");
});

test("Today button appears when viewing other months and jumps to current month", async ({ page }) => {
  // Since the demo budget starts on DEMO_MONTH (2026-06) which is not the current calendar month,
  // the "Today" button is visible in the toolbar.
  const todayBtn = page.getByRole("button", { name: /Today/i });
  await expect(todayBtn).toBeVisible();

  // Click Today
  await todayBtn.click();

  // "Today" button disappears because we are now on today's month
  await expect(todayBtn).toBeHidden();
});
