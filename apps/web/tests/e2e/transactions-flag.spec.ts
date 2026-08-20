import { test, expect, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();
}

async function resetToDemo() {
  const res = await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
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

test("renders the duplicate marker as a D badge and lets the user switch away", async ({ page }) => {
  await resetToDemo();

  const budget = await (await fetch(`${BASE_URL}/api/budget`)).json();
  const account =
    budget.accounts.find((a: { name: string }) => a.name === "EQ Bank") ??
    budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];

  const payee = `PW Dup ${Date.now()}`;
  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-20",
    payee,
    memo: "",
    amount: -1234,
    cleared: true,
  };
  await fetch(`${BASE_URL}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetch(`${BASE_URL}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetch(`${BASE_URL}/api/duplicates`, { method: "POST" });

  await page.reload();
  await waitForReady(page);
  await gotoAllTransactions(page);

  const row = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(row).toBeVisible();
  const dupBadge = row.getByRole("button", { name: "Flag: Duplicate" });
  await expect(dupBadge).toBeVisible();
  await expect(dupBadge.locator(".y-cleared--duplicate")).toHaveText("D");

  // The picker must never offer a way to pick "duplicate".
  await dupBadge.click();
  await expect(page.getByRole("dialog", { name: "Choose flag color" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Duplicate" })).toHaveCount(0);

  // Switching away to a manual color works.
  await page.getByRole("radio", { name: "Red" }).last().click();
  await expect(row.getByRole("button", { name: "Flag: Red" })).toBeVisible();

  await resetToDemo();
});
