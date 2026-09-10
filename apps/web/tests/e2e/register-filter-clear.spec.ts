// apps/web/tests/e2e/register-filter-clear.spec.ts
//
// Regression: clearing the register filter, navigating to Reports and back,
// must not resurrect the filter. Root cause was BudgetApp.registerFilter
// surviving the local Clear — TransactionsView kept the value in its owner,
// which re-applied it when the register remounted on navigation. The fix
// clears the owner state alongside the local one (Clear, last-chip removal,
// and focus jumps all notify via onClearFilter).
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("cleared register filter stays cleared across view navigation", async ({
  page,
}) => {
  // 1. Open the search modal from the register toolbar.
  await page.getByRole("button", { name: "Filter transactions" }).click();
  await expect(page.getByTestId("global-search-modal")).toBeVisible();

  // 2. Commit a structured chip (seed rows default to cleared status) and
  // apply it to the register.
  const input = page.getByTestId("global-search-input");
  await input.fill("is:cleared");
  await input.press("Enter");
  await expect(page.getByText("Matching transactions")).toBeVisible();
  await page.getByRole("button", { name: "Show in register" }).click();

  // 3. The filter bar is up in the toolbar.
  const bar = page.getByTestId("register-filter-bar");
  await expect(bar).toBeVisible();

  // 4. Clear it.
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(bar).toBeHidden();

  // 5. Navigate away and back — the filter must not come back. Before the
  // fix, the stale owner-side filter re-applied on remount and the bar
  // reappeared here.
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();
  await gotoAllTransactions(page);
  await expect(bar).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Filter transactions" })
  ).toBeVisible();
});
