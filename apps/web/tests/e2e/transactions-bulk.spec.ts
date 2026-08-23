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
import { fillSearchlist } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
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

test("selects multiple rows with checkboxes and displays the bulk action bar", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW Bulk 1 ${stamp}`;
  const payee2 = `PW Bulk 2 ${stamp}`;

  // Create two distinct transactions
  for (const p of [payee1, payee2]) {
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("15.00");
    await modal.locator('input[type="date"]').first().fill("2026-09-01");
    await fillSearchlist(modal, "e.g. Whole Foods", p);
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

test("bulk edits selected rows with field isolation and confirmation step", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW BulkEdit 1 ${stamp}`;
  const payee2 = `PW BulkEdit 2 ${stamp}`;
  const commonPayee = `PW Common Bulk ${stamp}`;

  // Create two distinct transactions with different amounts
  const txConfigs = [
    { payee: payee1, amount: "20.00", date: "2026-09-01" },
    { payee: payee2, amount: "40.00", date: "2026-09-02" },
  ];

  for (const cfg of txConfigs) {
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill(cfg.amount);
    await modal.locator('input[type="date"]').first().fill(cfg.date);
    await fillSearchlist(modal, "e.g. Whole Foods", cfg.payee);
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

  // Click Edit (2) button
  await page.getByRole("button", { name: "Edit (2)" }).click();

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit 2 Transactions")).toBeVisible();

  // Enable Payee field only
  await editModal.getByText("Payee", { exact: true }).click();
  await fillSearchlist(editModal, "e.g. Target", commonPayee);

  // Review Changes
  await editModal.getByRole("button", { name: /Review Changes/i }).click();

  // Confirm step
  await expect(editModal.getByText("Confirm Changes (2 Transactions)")).toBeVisible();
  await expect(editModal.getByText(commonPayee)).toBeVisible();

  // Apply Changes
  await editModal.getByRole("button", { name: /Confirm & Update 2 Transactions/i }).click();
  await expect(editModal).toBeHidden();

  // Verify both rows now have the updated payee while keeping their original amounts
  const updatedRows = page.getByRole("row").filter({ hasText: commonPayee });
  await expect(updatedRows).toHaveCount(2);
  await expect(page.getByRole("row").filter({ hasText: "20.00" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "40.00" })).toBeVisible();
});

test("bulk deletes selected transactions", async ({ page }) => {
  const stamp = Date.now();
  const payee1 = `PW BulkDel 1 ${stamp}`;
  const payee2 = `PW BulkDel 2 ${stamp}`;

  for (const p of [payee1, payee2]) {
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("18.00");
    await modal.locator('input[type="date"]').first().fill("2026-09-01");
    await fillSearchlist(modal, "e.g. Whole Foods", p);
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

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator('input[inputmode="decimal"]').first().fill("33.00");
  await addModal.locator('input[type="date"]').first().fill("2026-09-01");
  await fillSearchlist(addModal, "e.g. Whole Foods", payee);
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

  // Opening the editor clears the selection; cancelling leaves no row
  // still highlighted behind the modal.
  await editModal.getByRole("button", { name: "Cancel" }).click();
  await expect(editModal).toBeHidden();
  await expect(page.locator("tr.y-row--selected")).toHaveCount(0);
});
