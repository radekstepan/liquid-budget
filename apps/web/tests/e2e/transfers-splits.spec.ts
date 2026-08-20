// apps/web/tests/e2e/transfers-splits.spec.ts
//
// End-to-end coverage of transfer and split transaction flows, exercising
// the modal's three modes (Single / Transfer / Split) and the server-side
// helpers. Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist, openSearchField, pickSubCategory } from "./helpers";

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

test("creates a transfer between two accounts", async ({ page }) => {
  const uniquePayee = `PW Transfer ${Date.now()}`;
  const stamp = uniquePayee.split(" ").pop()!;

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();

  // Switch to Transfer mode.
  await modal.getByRole("button", { name: /^transfer$/i }).click();

  // Type a custom payee so we can find the row in the register later
  // (otherwise the modal auto-derives "Transfer : <dest>").
  await modal.locator(".y-searchlist-trigger").first().click();
  await modal.locator('input[placeholder^="Transfer"]').first().fill(uniquePayee);
  // Negative amount = outflow from source.
  await modal.locator('input[inputmode="decimal"]').first().fill("-75.00");
  // Pick a destination account (the searchable "Transfer to" field).
  await openSearchField(modal, "Select account…");
  const options = page.locator('.y-dropdown button[role="option"]');
  await expect(options.first()).toBeVisible();
  const destOption = options.nth(1);
  const destName = (await destOption.textContent())?.trim()!;
  await destOption.click();

  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  // The transfer row should appear in the register; the payee encodes
  // the destination name (or our custom payee if we typed one).
  const row = page.getByRole("row").filter({ hasText: stamp });
  await expect(row).toBeVisible();
  // Category column shows "Transfer" label for transfer rows.
  await expect(row.first()).toContainText("Transfer");
});

test("creates a 2-way split and renders in register with children visible only in modal", async ({ page }) => {
  const uniquePayee = `PW Split ${Date.now()}`;
  const stamp = uniquePayee.split(" ").pop()!;

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();

  // Switch to Split mode.
  await modal.getByRole("button", { name: /^split$/i }).click();

  // Type the parent payee and total.
  await fillSearchlist(modal, "e.g. Whole Foods", uniquePayee);
  // The first "0.00" is the parent total; subsequent ones are sub-rows.
  const allDecimals = modal.locator('input[inputmode="decimal"]');
  await allDecimals.nth(0).fill("-100");

  // Pick categories and amounts for the two sub-rows.
  await pickSubCategory(modal, page, 1);
  await pickSubCategory(modal, page, 2);

  // Children carry their typed sign and must sum to the signed parent
  // total (mixed-sign validation): -60 + -40 = -100.
  await allDecimals.nth(1).fill("-60");
  await allDecimals.nth(2).fill("-40");

  // Save.
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  // The parent row should be visible in the register with "Split (Multiple Categories)".
  const parentRow = page.getByRole("row").filter({ hasText: stamp }).first();
  await expect(parentRow).toBeVisible();
  await expect(parentRow).toContainText("Split (Multiple Categories)");

  // Subtransactions (↳ glyph) should NOT be in the register list.
  const childCount = await page.locator("tbody tr.y-row", { hasText: "↳" }).count();
  expect(childCount).toBe(0);

  // Clicking the parent row opens the modal with the subtransactions.
  await parentRow.click();
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();
  const editDecimals = editModal.locator('input[inputmode="decimal"]');
  await expect(editDecimals.nth(0)).toHaveValue("-100.00");
  await expect(editDecimals.nth(1)).toHaveValue("-60.00");
  await expect(editDecimals.nth(2)).toHaveValue("-40.00");
});

test("split editor disables save when children don't sum to the parent total", async ({
  page,
}) => {
  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.getByRole("button", { name: /^split$/i }).click();

  await fillSearchlist(modal, "e.g. Whole Foods", "Test");
  const allDecimals = modal.locator('input[inputmode="decimal"]');
  await allDecimals.nth(0).fill("-100");

  await pickSubCategory(modal, page, 1);
  await pickSubCategory(modal, page, 2);

  // Off by a cent.
  await allDecimals.nth(1).fill("60");
  await allDecimals.nth(2).fill("39.99");

  const saveBtn = modal.getByRole("button", { name: "Save Transaction" });
  await expect(saveBtn).toBeDisabled();
});
