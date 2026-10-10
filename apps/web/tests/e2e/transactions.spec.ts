// apps/web/tests/e2e/transactions.spec.ts
//
// Covers TransactionsView + TransactionModal:
//   - add a transaction via the modal (TransactionsView.tsx:107-109
//     → Modals.tsx:11-159)
//   - search filtering (TransactionsView.tsx:100-106)
//   - account filter pill + clear (TransactionsView.tsx:82-97)
//   - row click opens edit modal pre-filled
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist, openSearchField, pickSubCategory, filterRegisterByText, clearRegisterFilter } from "./helpers";

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

test("adds a new transaction via the modal and renders the row", async ({ page }) => {
  const uniquePayee = `PW Test ${Date.now()}`;

  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  await expect(page.getByText("Add Transaction", { exact: true }).first()).toBeVisible();

  // The modal title is rendered twice (toolbar button + modal head);
  // we use a scoped locator to target just the dialog.
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("12.34");
  await modal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(modal, "e.g. Whole Foods", uniquePayee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();

  // Modal closes and the new row appears.
  await expect(modal).toBeHidden();
  await filterRegisterByText(page, uniquePayee);
  await expect(page.getByRole("row").filter({ hasText: uniquePayee })).toBeVisible();
});

test("search filter narrows the register rows", async ({ page }) => {
  // Add a uniquely-named transaction first so we have a stable target.
  // The DB may contain leftover rows from previous test runs (we only
  // reset in CI), so we search for the exact unique stamp rather than
  // just the prefix.
  const stamp = Date.now().toString();
  const uniquePayee = `PW Search ${stamp}`;
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("5.00");
  await modal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(modal, "e.g. Whole Foods", uniquePayee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  const allRows = page.locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row");
  const totalBefore = await allRows.count();

  // Type the exact stamp; only the matching row stays visible.
  await filterRegisterByText(page, stamp);
  await expect(allRows).toHaveCount(1);
  await expect(allRows.first()).toContainText(uniquePayee);

  // Clearing the search restores every row.
  await clearRegisterFilter(page);
  await expect(allRows).toHaveCount(totalBefore);
});

test("selecting a sidebar account marks the row and scopes the register; Transactions nav clears the filter", async ({ page }) => {
  // The toolbar title (a <span>) shows "All Transactions" by default
  // and the account name when an account row is selected
  // (TransactionsView.tsx).
  const toolbarTitle = page.locator(".y-toolbar span.text-\\[13px\\]").first();
  await expect(toolbarTitle).toHaveText("All Transactions");

  const transactionsNav = page.getByRole("button", { name: /^Transactions/ });
  const accountRow = page.getByRole("button", { name: /TD Unlimited Chequing/ }).first();
  await expect(accountRow).not.toHaveClass(/is-sel/);

  // Sidebar account click selects the row (Sidebar.tsx: <is-sel> is
  // applied) and switches to the transactions view filtered to that
  // account (BudgetApp.tsx onSelectAccount handler).
  await accountRow.click();
  await expect(toolbarTitle).toHaveText("TD Unlimited Chequing");
  await expect(accountRow).toHaveClass(/is-sel/);

  // Clicking the same account again toggles the selection off.
  await accountRow.click();
  await expect(toolbarTitle).toHaveText("All Transactions");
  await expect(accountRow).not.toHaveClass(/is-sel/);

  // Re-select, then click the top-level "Transactions" nav: the account
  // selection clears and the register returns to All Transactions.
  await accountRow.click();
  await expect(accountRow).toHaveClass(/is-sel/);
  await transactionsNav.click();
  await expect(toolbarTitle).toHaveText("All Transactions");
  await expect(accountRow).not.toHaveClass(/is-sel/);
  await expect(transactionsNav).toHaveClass(/is-sel/);
});

test("clicking a row opens the edit modal pre-filled with the payee", async ({ page }) => {
  // Create a dedicated regular transaction: the register's first row is
  // seed-dependent (currently an auto-posted Wealthsimple TFSA *transfer*,
  // whose edit modal has no payee SearchList), so the old rows.first()
  // lookup was not deterministic.
  const uniquePayee = `PW Row ${Date.now()}`;
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator('input[inputmode="decimal"]').first().fill("12.34");
  await addModal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(addModal, "e.g. Whole Foods", uniquePayee);
  await addModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(addModal).toBeHidden();

  await filterRegisterByText(page, uniquePayee);
  const targetRow = page.getByRole("row").filter({ hasText: uniquePayee }).first();
  await expect(targetRow).toBeVisible();
  await targetRow.click();

  const editModal = page.locator(".y-modal").last();
  // The payee field contains the current payee value.
  await expect(
    editModal.locator(".y-searchlist input").first()
  ).toHaveValue(uniquePayee);
});

test("deletes a transaction via the modal after confirming", async ({ page }) => {
  const uniquePayee = `PW Delete ${Date.now()}`;
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator('input[inputmode="decimal"]').first().fill("25.00");
  await addModal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(addModal, "e.g. Whole Foods", uniquePayee);
  await addModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(addModal).toBeHidden();

  await filterRegisterByText(page, uniquePayee);
  const createdRow = page.getByRole("row").filter({ hasText: uniquePayee });
  await expect(createdRow).toBeVisible();

  // Click row to open edit modal
  await createdRow.click();
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();

  // Click Delete button
  await editModal.getByRole("button", { name: /^Delete/ }).click();
  await expect(editModal.locator(".y-modal-head")).toContainText("Delete");

  // Confirm delete
  await editModal.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(editModal).toBeHidden();

  // Verify row is removed
  await expect(createdRow).toBeHidden();
});

test("deletes a transfer transaction via modal showing linked transfer warning", async ({ page }) => {
  const stamp = Date.now().toString();
  const transferPayee = `PW Transfer ${stamp}`;
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const addModal = page.locator(".y-modal").last();

  // Switch to Transfer mode
  await addModal.getByRole("button", { name: /^transfer$/i }).click();
  await addModal.locator(".y-searchlist-trigger").first().click();
  await addModal.locator('input[placeholder^="Transfer"]').first().fill(transferPayee);
  await addModal.locator('input[inputmode="decimal"]').first().fill("-30.00");
  await addModal.locator('input[type="date"]').first().fill("2026-06-15");

  // Pick destination account (the searchable "Transfer to" field)
  await openSearchField(addModal, "Select account…");
  const options = page.locator('.y-dropdown button[role="option"]');
  await expect(options.first()).toBeVisible();
  await options.nth(1).click();

  await addModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(addModal).toBeHidden();

  await filterRegisterByText(page, transferPayee);
  const createdRow = page.getByRole("row").filter({ hasText: transferPayee });
  await expect(createdRow.first()).toBeVisible();

  // Click row to open edit modal
  await createdRow.first().click();
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();

  // Click Delete button
  await editModal.getByRole("button", { name: /^Delete/ }).click();
  await expect(editModal.getByText(/Linked transfer/i)).toBeVisible();
  await expect(editModal.getByText(/also remove the corresponding transaction in the linked account/i)).toBeVisible();

  // Confirm delete
  await editModal.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(editModal).toBeHidden();

  // Verify row is removed
  await expect(createdRow).toHaveCount(0);
});

test("deletes a split transaction via modal showing split warning notice", async ({ page }) => {
  const stamp = Date.now().toString();
  const splitPayee = `PW Split ${stamp}`;
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const addModal = page.locator(".y-modal").last();

  // Switch to Split mode
  await addModal.getByRole("button", { name: /^split$/i }).click();
  await addModal.locator('input[inputmode="decimal"]').first().fill("50.00");
  await addModal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(addModal, "e.g. Whole Foods", splitPayee);

  // Sub-row 1 amount
  const subAmountInputs = addModal.locator('input[inputmode="decimal"]');
  await subAmountInputs.nth(1).fill("30.00");
  await subAmountInputs.nth(2).fill("20.00");

  // Pick category for sub-row 1
  await pickSubCategory(addModal, page, "Groceries");

  // Pick category for sub-row 2
  await pickSubCategory(addModal, page, "Household");

  await addModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(addModal).toBeHidden();

  // Find the split transaction row
  await filterRegisterByText(page, stamp);
  const parentRow = page.getByRole("row").filter({ hasText: splitPayee }).first();
  await expect(parentRow).toBeVisible();

  // Click parent row to edit
  await parentRow.click();
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();

  // Click Delete
  await editModal.getByRole("button", { name: /^Delete/ }).click();
  await expect(editModal.getByText(/Split transaction/i)).toBeVisible();
  await expect(editModal.getByText(/also delete all of its 2 sub-transactions/i)).toBeVisible();

  // Confirm delete
  await editModal.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(editModal).toBeHidden();

  // Clear search and verify row is gone
  await clearRegisterFilter(page);
  await expect(page.getByRole("row").filter({ hasText: splitPayee })).toHaveCount(0);
});
