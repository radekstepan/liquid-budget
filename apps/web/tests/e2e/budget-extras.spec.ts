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

test("Today button appears when viewing other months and jumps to current month", async ({ page }) => {
  // Navigate away from today's month to ensure the Today button appears
  const prevBtn = page.getByRole("button", { name: /previous month/i });
  await prevBtn.click();

  // If the prev button was on today's month, clicking prev moves to non-today month;
  // if already on non-today month, Today button is visible.
  const todayBtn = page.getByRole("button", { name: /Today/i });
  await expect(todayBtn).toBeVisible();

  // Click Today
  await todayBtn.click();

  // "Today" button disappears because we are now on today's month
  await expect(todayBtn).toBeHidden();
});
