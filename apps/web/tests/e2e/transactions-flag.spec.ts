import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist } from "./helpers";

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
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
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

test("renders the duplicate marker as a read-only D badge that cannot be changed", async ({ page }) => {
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

  const budgetAfter = await (await fetch(`${BASE_URL}/api/budget`)).json();
  const dupRow = budgetAfter.transactions.find(
    (t: { payee: string; flagColor: string | null }) =>
      t.payee === payee && t.flagColor === "duplicate"
  );
  expect(dupRow).toBeTruthy();

  await page.reload();
  await waitForReady(page);
  await gotoAllTransactions(page);

  const row = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(row).toBeVisible();

  // The D badge is a non-interactive element, not a button, and clicking it
  // never opens the flag picker.
  const dupBadge = row.locator('[aria-label="Flag: Duplicate"]');
  await expect(dupBadge).toBeVisible();
  await expect(dupBadge.locator(".y-cleared--duplicate")).toHaveText("D");
  await expect(row.getByRole("button", { name: "Flag: Duplicate" })).toHaveCount(0);
  await dupBadge.click();
  await expect(page.getByRole("dialog", { name: "Choose flag color" })).toHaveCount(0);

  // Editing the transaction shows a read-only duplicate note — no flag
  // picker — and saving other changes preserves the D badge.
  await row.click();
  const modal = page.locator(".y-modal").last();
  await expect(modal).toBeVisible();
  await expect(modal.locator(".y-cleared--duplicate")).toHaveText("D");
  await expect(modal.getByRole("radio", { name: /Red|Blue|Yellow|Green|Purple|Orange/ })).toHaveCount(0);
  await fillSearchlist(modal, "e.g. Whole Foods", `${payee} edited`);
  await modal.getByRole("button", { name: "Save Changes" }).click();
  await expect(modal).toBeHidden();

  const editedRow = page.getByRole("row").filter({ hasText: `${payee} edited` }).first();
  await expect(editedRow).toBeVisible();
  await expect(editedRow.locator('[aria-label="Flag: Duplicate"]')).toBeVisible();

  // The API rejects any attempt to change the flag on a duplicate row.
  const patch = await fetch(`${BASE_URL}/api/transactions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: dupRow.id, flagColor: "red" }),
  });
  expect(patch.status).toBe(422);

  const clear = await fetch(`${BASE_URL}/api/transactions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: dupRow.id, flagColor: null }),
  });
  expect(clear.status).toBe(422);

  const bulk = await fetch(`${BASE_URL}/api/transactions?action=bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [dupRow.id], patch: { flagColor: "blue" } }),
  });
  expect(bulk.status).toBe(422);

  await resetToDemo();
});
