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

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: "All Transactions", exact: true }).click();
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

  await page.getByRole("button", { name: "Add Transaction" }).click();
  await expect(page.getByText("Add Transaction", { exact: true }).first()).toBeVisible();

  // The modal title is rendered twice (toolbar button + modal head);
  // we use a scoped locator to target just the dialog.
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("12.34");
  await modal.locator('input[type="date"]').first().fill("2026-06-15");
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(uniquePayee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();

  // Modal closes and the new row appears.
  await expect(modal).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: uniquePayee })).toBeVisible();
});

test("search filter narrows the register rows", async ({ page }) => {
  // Add a uniquely-named transaction first so we have a stable target.
  // The DB may contain leftover rows from previous test runs (we only
  // reset in CI), so we search for the exact unique stamp rather than
  // just the prefix.
  const stamp = Date.now().toString();
  const uniquePayee = `PW Search ${stamp}`;
  await page.getByRole("button", { name: "Add Transaction" }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("5.00");
  await modal.locator('input[type="date"]').first().fill("2026-06-15");
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(uniquePayee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  const allRows = page.locator("tbody tr.y-row");
  const totalBefore = await allRows.count();

  // Type the exact stamp; only the matching row stays visible.
  await page.getByPlaceholder("Search register").fill(stamp);
  await expect(allRows).toHaveCount(1);
  await expect(allRows.first()).toContainText(uniquePayee);

  // Clearing the search restores every row.
  await page.getByPlaceholder("Search register").fill("");
  await expect(allRows).toHaveCount(totalBefore);
});

test("selecting a sidebar account marks the row and scopes the register; All Transactions nav clears it", async ({ page }) => {
  // The toolbar title (a <span>) shows "All Transactions" by default
  // and the account name when an account row is selected
  // (TransactionsView.tsx).
  const toolbarTitle = page.locator(".y-toolbar span.text-\\[13px\\]").first();
  await expect(toolbarTitle).toHaveText("All Transactions");

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

  // Re-select, then click the top-level "All Transactions" nav to clear.
  await accountRow.click();
  await expect(accountRow).toHaveClass(/is-sel/);
  await page.getByRole("button", { name: "All Transactions", exact: true }).click();
  await expect(toolbarTitle).toHaveText("All Transactions");
  await expect(accountRow).not.toHaveClass(/is-sel/);
});

test("clicking a row opens the edit modal pre-filled with the payee", async ({ page }) => {
  // Find the first clickable row (skip split children, which are not
  // clickable in TransactionsView). Rows render date, account, payee
  // (with the ↳ glyph for children), category, memo, outflow, inflow,
  // flag, balance — the payee lives in td index 2 (TransactionsView
  // renders the glyph inline with the payee).
  const rows = page.locator("tbody tr.y-row");
  const count = await rows.count();
  let targetRow = rows.nth(0);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const hasArrow = await row.locator("td").nth(2).locator("text=↳").count();
    if (hasArrow === 0) {
      targetRow = row;
      break;
    }
  }
  const payeeText = (await targetRow.locator("td").nth(2).textContent())?.trim();
  expect(payeeText).toBeTruthy();

  await targetRow.click();

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();
  await expect(
    editModal.locator('input[placeholder="e.g. Whole Foods"]')
  ).toHaveValue(payeeText!);
});
