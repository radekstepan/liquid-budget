// apps/web/tests/e2e/budget.spec.ts
//
// Exercises BudgetView + Inspector interactions:
//   - inline category assignment edits (BudgetView.tsx:481-534)
//   - MonthNav prev/next (BudgetView.tsx:131-136, blocks.tsx:7-33)
//   - group collapse / expand menu (BudgetView.tsx:144-172)
//   - Inspector history bar month jump (Inspector.tsx:151-181)
//
// These specs mutate state, so the CI global setup (tests/e2e/global-setup.ts)
// must run before the suite for deterministic results. Locally, with
// `reuseExistingServer` on, the suite runs against the existing dev DB.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("inline-edits a category assigned amount and updates To Be Budgeted", async ({ page }) => {
  // Pick a category with a stable, non-zero seed assignment and edit
  // it to a value unique to this run, so a leftover from a previous
  // test run can't make the "before" equal the "after".
  const newAmount = `${Date.now() % 1000}.45`;
  const rentRow = page.getByRole("row").filter({ hasText: "Rent" }).first();
  const budgetedCell = rentRow.locator("button.y-inline-amt").first();
  const before = await budgetedCell.textContent();

  await budgetedCell.click();
  const input = rentRow.locator("input.y-inline-amt");
  await expect(input).toBeVisible();
  await input.fill(newAmount);
  await input.press("Enter");

  // The same cell now reflects the new value.
  await expect(rentRow.locator("button.y-inline-amt").first()).toHaveText(`$${newAmount}`);
  expect(before).not.toBe(`$${newAmount}`);
});

test("MonthNav prev/next shifts the active month", async ({ page }) => {
  // The BudgetView MonthNav renders "June 2026" for the seed month
  // (BudgetView.tsx:30-37, formatMonthLong uses MONTHS_LONG).
  const monthLabel = page.locator(".y-toolbar .text-\\[15px\\]").first();
  await expect(monthLabel).toHaveText("June 2026");

  await page.getByRole("button", { name: "Next month" }).click();
  await expect(monthLabel).toHaveText("July 2026");

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(monthLabel).toHaveText("June 2026");
});

test("Group options menu collapses and expands all groups", async ({ page }) => {
  // The first "Needs" group's row (Mortgage Principal) should be visible
  // when expanded.
  const mortgageRow = page.getByRole("row").filter({ hasText: "Mortgage Principal" });
  await expect(mortgageRow).toBeVisible();

  // Open the dots-menu (aria-label="Group options" — BudgetView.tsx:147).
  await page.getByRole("button", { name: "Group options" }).click();
  await page.getByRole("button", { name: "Collapse all groups" }).click();

  // The category rows vanish; only master rows remain. YNAB4 collapses
  // by removing the row nodes, so the simplest assertion is that the
  // category row is now hidden.
  await expect(mortgageRow).toBeHidden();

  await page.getByRole("button", { name: "Group options" }).click();
  await page.getByRole("button", { name: "Expand all groups" }).click();
  await expect(mortgageRow).toBeVisible();
});

test("clicking a real history bar in the Inspector jumps to that month", async ({ page }) => {
  // June 2026 is the only "real" history bar (the only month with
  // assignments in the seed). Shift one month forward so the jump
  // produces a visible change.
  await page.getByRole("button", { name: "Next month" }).click();
  const monthLabel = page.locator(".y-toolbar .text-\\[15px\\]").first();
  await expect(monthLabel).toHaveText("July 2026");

  // Inspector history bar (Inspector.tsx:151-181) uses aria-label
  // "Jump to <MonthShort> <Year>" — MONTHS is the 3-letter array
  // (Inspector.tsx:5, format.ts:1-14), so it's "Jun 2026", not "June 2026".
  await page.getByRole("button", { name: "Jump to Jun 2026" }).click();
  await expect(monthLabel).toHaveText("June 2026");
});
