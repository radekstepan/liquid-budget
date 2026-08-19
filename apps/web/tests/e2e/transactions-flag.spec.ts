import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("adds, changes, clears, and persists a transaction color flag", async ({ page }) => {
  const payee = `PW Flag ${Date.now()}`;
  const register = page.locator("table.y-table:not(.y-scheduled-table)").first();

  await expect(register.locator("thead th", { hasText: /^F$/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("4.20");
  await modal.locator('input[type="date"]').first().fill("2026-09-01");
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(payee);
  await modal.getByRole("radio", { name: "Red" }).click();
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  const row = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(row).toBeVisible();
  await expect(register.locator("thead th", { hasText: /^F$/ })).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Flag: Red" })).toBeVisible();

  await row.getByRole("button", { name: "Flag: Red" }).click();
  await page.getByRole("radio", { name: "Blue" }).last().click();
  await expect(row.getByRole("button", { name: "Flag: Blue" })).toBeVisible();

  await page.reload();
  await waitForReady(page);
  await gotoAllTransactions(page);
  const reloadedRow = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(reloadedRow.getByRole("button", { name: "Flag: Blue" })).toBeVisible();

  await reloadedRow.getByRole("button", { name: "Flag: Blue" }).click();
  await page.getByRole("button", { name: "Clear flag" }).click();
  await expect(page.locator("table.y-table:not(.y-scheduled-table) thead th", { hasText: /^F$/ })).toHaveCount(0);
});
