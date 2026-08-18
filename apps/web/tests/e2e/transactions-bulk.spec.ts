// apps/web/tests/e2e/transactions-bulk.spec.ts
//
// Covers TransactionsView bulk selection, bulk actions, and keyboard navigation:
//   - Row selection checkboxes (TransactionsView.tsx:202-213, 401-410)
//   - Select all master checkbox (TransactionsView.tsx:189-200, 370-378)
//   - Bulk action bar: Mark Cleared, Mark Uncleared, Delete (N), Deselect All
//     (TransactionsView.tsx:291-342)
//   - Keyboard navigation: ArrowUp/Down, Enter, 'c'/Space, Delete
//     (TransactionsView.tsx:215-244)
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Accounts/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("selects multiple rows with checkboxes and displays the bulk action bar", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW Bulk 1 ${stamp}`;
  const payee2 = `PW Bulk 2 ${stamp}`;

  // Create two distinct transactions
  for (const p of [payee1, payee2]) {
    await page.getByRole("button", { name: "Add Transaction" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("15.00");
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(p);
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();
  }

  const row1 = page.getByRole("row").filter({ hasText: payee1 }).first();
  const row2 = page.getByRole("row").filter({ hasText: payee2 }).first();
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();

  // Select row 1
  const cb1 = row1.locator('input[type="checkbox"]');
  await cb1.click();
  await expect(page.getByText("1 selected")).toBeVisible();

  // Select row 2
  const cb2 = row2.locator('input[type="checkbox"]');
  await cb2.click();
  await expect(page.getByText("2 selected")).toBeVisible();

  // Click Deselect All
  await page.getByRole("button", { name: "Deselect All" }).click();
  await expect(page.getByText("2 selected")).toBeHidden();
  await expect(cb1).not.toBeChecked();
  await expect(cb2).not.toBeChecked();
});

test("bulk marks selected rows as Cleared and Uncleared", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW BulkClr 1 ${stamp}`;
  const payee2 = `PW BulkClr 2 ${stamp}`;

  // Create two uncleared transactions
  for (const p of [payee1, payee2]) {
    await page.getByRole("button", { name: "Add Transaction" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("20.00");
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(p);
    // Uncheck cleared to create uncleared transaction
    await modal.getByText("Cleared (bank has processed this)").click();
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();
  }

  const row1 = page.getByRole("row").filter({ hasText: payee1 }).first();
  const row2 = page.getByRole("row").filter({ hasText: payee2 }).first();
  await expect(row1.locator(".y-cleared")).toHaveText("U");
  await expect(row2.locator(".y-cleared")).toHaveText("U");

  // Select both rows
  await row1.locator('input[type="checkbox"]').click();
  await row2.locator('input[type="checkbox"]').click();
  await expect(page.getByText("2 selected")).toBeVisible();

  // Bulk mark cleared
  await page.getByRole("button", { name: "Mark Cleared" }).click();
  await expect(page.getByText("2 selected")).toBeHidden();

  // Verify both are now cleared
  await expect(row1.locator(".y-cleared")).toHaveText("C");
  await expect(row2.locator(".y-cleared")).toHaveText("C");

  // Re-select both rows and mark uncleared
  await row1.locator('input[type="checkbox"]').click();
  await row2.locator('input[type="checkbox"]').click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Mark Uncleared" }).click();
  await expect(page.getByText("2 selected")).toBeHidden();

  // Verify both are uncleared
  await expect(row1.locator(".y-cleared")).toHaveText("U");
  await expect(row2.locator(".y-cleared")).toHaveText("U");
});

test("bulk deletes selected transactions", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW BulkDel 1 ${stamp}`;
  const payee2 = `PW BulkDel 2 ${stamp}`;

  for (const p of [payee1, payee2]) {
    await page.getByRole("button", { name: "Add Transaction" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("18.00");
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(p);
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();
  }

  const row1 = page.getByRole("row").filter({ hasText: payee1 }).first();
  const row2 = page.getByRole("row").filter({ hasText: payee2 }).first();
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();

  // Select both rows
  await row1.locator('input[type="checkbox"]').click();
  await row2.locator('input[type="checkbox"]').click();
  await expect(page.getByText("2 selected")).toBeVisible();

  // Click Delete (2)
  await page.getByRole("button", { name: "Delete (2)" }).click();
  await expect(page.getByText("2 selected")).toBeHidden();

  // Verify both rows are removed
  await expect(page.getByRole("row").filter({ hasText: payee1 })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: payee2 })).toHaveCount(0);
});

test("header checkbox selects all visible transactions and allows deselecting", async ({ page }) => {
  const masterCb = page.getByRole("checkbox", { name: "Select all transactions" });
  await expect(masterCb).toBeVisible();
  await expect(masterCb).not.toBeChecked();

  // Click header checkbox to select all
  await masterCb.click();
  await expect(masterCb).toBeChecked();
  await expect(page.getByText(/\d+ selected/)).toBeVisible();

  // Uncheck header checkbox
  await masterCb.click();
  await expect(masterCb).not.toBeChecked();
  await expect(page.getByText(/\d+ selected/)).toBeHidden();
});

test("keyboard shortcuts navigate rows, open edit modal, and cycle status", async ({ page }) => {
  const stamp = Date.now();
  const payee = `PW Keyboard ${stamp}`;

  await page.getByRole("button", { name: "Add Transaction" }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator('input[inputmode="decimal"]').first().fill("33.00");
  await addModal.locator('input[type="date"]').first().fill("2026-06-15");
  await addModal.locator('input[placeholder="e.g. Whole Foods"]').fill(payee);
  await addModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(addModal).toBeHidden();

  const createdRow = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(createdRow).toBeVisible();

  // Focus table container and select row using keyboard
  const tableContainer = page.locator('.y-scroll[tabindex="0"]');
  await tableContainer.focus();
  await page.keyboard.press("ArrowDown");

  const selectedRow = page.locator("tr.y-row--selected");
  await expect(selectedRow).toBeVisible();

  // Press 'c' to cycle status C -> U
  const flag = selectedRow.locator(".y-cleared");
  await expect(flag).toHaveText("C");
  await page.keyboard.press("c");
  await expect(flag).toHaveText("U");

  // Press Space to cycle status U -> C
  await page.keyboard.press(" ");
  await expect(flag).toHaveText("C");

  // Press Enter to open edit modal
  await page.keyboard.press("Enter");
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();
  await editModal.getByRole("button", { name: "Cancel" }).click();
  await expect(editModal).toBeHidden();
});
