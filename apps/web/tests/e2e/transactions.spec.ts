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

test("account filter pill clears and restores the unfiltered title", async ({ page }) => {
  // The toolbar title (a <span>) shows "All Transactions" by default
  // and the account name when filtered (TransactionsView.tsx:78-82).
  // The sidebar nav button keeps the same label, so we target the
  // toolbar only.
  const toolbarTitle = page.locator(".y-toolbar span.text-\\[13px\\]").first();
  await expect(toolbarTitle).toHaveText("All Transactions");

  // Sidebar account click triggers the deep-link filter
  // (Sidebar.tsx:118-127 → BudgetApp.tsx:215-218).
  await page.getByRole("button", { name: /TD Unlimited Chequing/ }).first().click();
  await expect(toolbarTitle).toHaveText("TD Unlimited Chequing");

  // The pill exposes an × button with aria-label "Clear account filter"
  // (TransactionsView.tsx:91-94).
  await page.getByRole("button", { name: "Clear account filter" }).click();
  await expect(toolbarTitle).toHaveText("All Transactions");
});

test("clicking a row opens the edit modal pre-filled with the payee", async ({ page }) => {
  // Find the first clickable row (skip split children, which are not
  // clickable in TransactionsView). The first .alt-row with the ↳ glyph
  // is a child; pick a row without that.
  const rows = page.locator("tbody tr.y-row");
  const count = await rows.count();
  let targetRow = rows.nth(0);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const hasArrow = await row.locator("td").nth(3).locator("text=↳").count();
    if (hasArrow === 0) {
      targetRow = row;
      break;
    }
  }
  const payeeText = (await targetRow.locator("td").nth(3).textContent())?.trim();
  expect(payeeText).toBeTruthy();

  await targetRow.click();

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();
  await expect(
    editModal.locator('input[placeholder="e.g. Whole Foods"]')
  ).toHaveValue(payeeText!);
});
