// apps/web/tests/e2e/categories-manage.spec.ts
//
// Covers Category deletion and carryover options in CategoryModal (Modals.tsx:594-777):
//   - Safe deletion of a category without transactions
//   - Deletion of a category with transactions requiring reassign category selection
//   - Red arrow overspendCarriesOver toggle persistence
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("deletes an empty category safely via modal", async ({ page }) => {
  const stamp = Date.now();
  const name = `PW CatDel ${stamp}`;

  // Add category to Needs
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
  let modal = page.locator(".y-modal").last();
  await modal.locator("input").first().fill(name);
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // Verify created
  const row = page.locator("tr[data-cat-row]").filter({ hasText: name });
  await expect(row).toBeVisible();

  // Edit category
  await page.getByRole("button", { name: `Edit ${name}` }).click({ force: true });
  modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Edit Category");

  // Click Delete…
  await modal.getByRole("button", { name: /^Delete/ }).click();
  await expect(modal.locator(".y-modal-head")).toContainText("Delete");
  await expect(modal.getByText(/has no transactions and will be removed/i)).toBeVisible();

  // Confirm delete
  await modal.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(modal).toBeHidden();

  // Verify row is gone
  await expect(row).toHaveCount(0);
});

test("deleting a category with transactions prompts for reassign target", async ({ page }) => {
  const stamp = Date.now();
  const catName = `PW CatReassign ${stamp}`;

  // 1. Create the category
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
  let modal = page.locator(".y-modal").last();
  await modal.locator("input").first().fill(catName);
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // 2. Add a transaction tied to this category
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const txModal = page.locator(".y-modal").last();
  await txModal.locator('input[inputmode="decimal"]').first().fill("15.00");
  await txModal.locator('input[type="date"]').first().fill("2026-09-01");
  await txModal.locator('input[placeholder="e.g. Whole Foods"]').fill(`PW Tx ${stamp}`);

  // Select the newly created category in the dropdown
  const catTrigger = txModal.locator(".y-select-trigger").nth(1);
  await catTrigger.click();
  await page.locator('.y-dropdown button[role="option"]').filter({ hasText: catName }).click();

  await txModal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(txModal).toBeHidden();

  // 3. Return to Budget view
  await page.getByRole("button", { name: "Budget", exact: true }).click();
  await expect(page.getByRole("button", { name: "Master Category" })).toBeVisible();

  // 4. Edit the category
  await page.getByRole("button", { name: `Edit ${catName}` }).click({ force: true });
  modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Edit Category");

  // 5. Click Delete…
  await modal.getByRole("button", { name: /^Delete/ }).click();
  await expect(modal.locator(".y-modal-head")).toContainText("Delete");

  // Notice about existing transactions should be visible
  await expect(modal.getByText(/referenced by 1 transaction/i)).toBeVisible();
  await expect(modal.getByText(/Please select another category/i)).toBeVisible();

  // Select replacement category
  const moveSelect = modal.locator(".y-select-trigger").first();
  await expect(moveSelect).toBeVisible();
  await moveSelect.click();
  await page.getByRole("option", { name: "Rent", exact: true }).click();

  // Confirm delete with reassign
  const confirmBtn = modal.getByRole("button", { name: "Yes, delete it" });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(modal).toBeHidden();

  // Verify category row is removed
  const row = page.locator("tr[data-cat-row]").filter({ hasText: catName });
  await expect(row).toHaveCount(0);
});

test("toggles and persists overspendCarriesOver (Red Arrow) option", async ({ page }) => {
  const stamp = Date.now();
  const name = `PW RedArrow ${stamp}`;

  // Add category
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
  let modal = page.locator(".y-modal").last();
  await modal.locator("input").first().fill(name);

  // Enable Red Arrow
  await modal.getByText(/Red Arrow/i).click();

  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // Edit category and verify checkbox remains checked
  await page.getByRole("button", { name: `Edit ${name}` }).click({ force: true });
  modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Edit Category");

  const redArrowInput = modal.locator('input[type="checkbox"]').last();
  await expect(redArrowInput).toBeChecked();

  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
});
