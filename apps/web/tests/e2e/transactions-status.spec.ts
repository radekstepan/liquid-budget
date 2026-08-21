// apps/web/tests/e2e/transactions-status.spec.ts
//
// Covers TransactionsView behaviours that the existing
// `transactions.spec.ts` skips:
//
//   - clicking the C column on a row cycles its status U ↔ C
//     (TransactionsView.tsx:251-256 → onCycleStatus → PATCH
//     /api/transactions; `r` is locked because reconcile is the only
//     way to set it, and the cycle button is disabled in that case)
//   - editing a transaction through the modal actually round-trips
//     the change (the existing test only asserts the modal opens)
//   - split parent renders ClearedFlag and subtransactions are not in list
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

async function getTransaction(
  page: Page,
  payee: string
): Promise<{ id: number; status: "u" | "c" | "r" }> {
  const res = await page.request.get("/api/budget");
  const body = await res.json();
  const row = body.transactions.find(
    (t: { payee: string; status: string }) => t.payee === payee
  );
  expect(row, `seed txn ${payee} should exist`).toBeTruthy();
  return row;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("clicking the C column cycles a row C → U → C", async ({ page }) => {
  // "Mountain's Edge MSP" is a stable seed row (TD Unlimited Chequing,
  // 2026-06-02). The DOM uses a y-cleared span with the letter
  // C/U/R (primitives.tsx:385); the click target is the table cell
  // containing that span (TransactionsView.tsx:249 — the column
  // has its own stopPropagation guard so clicking elsewhere on the
  // row doesn't open the edit modal).
  const target = "Mountain's Edge MSP";
  const before = await getTransaction(page, target);
  expect(before.status, "seed assumption: target starts Cleared").toBe("c");

  const row = page.getByRole("row").filter({ hasText: target }).first();
  const flag = row.locator(".y-cleared");
  await expect(flag).toHaveText("C");

  // First click: C → U. The cycle handler is a PATCH + reload, so
  // wait for the row to update.
  await flag.click();
  await expect
    .poll(async () => (await getTransaction(page, target)).status, {
      timeout: 10_000,
    })
    .toBe("u");
  await expect(flag).toHaveText("U");

  // Second click: U → C.
  await flag.click();
  await expect
    .poll(async () => (await getTransaction(page, target)).status, {
      timeout: 10_000,
    })
    .toBe("c");
  await expect(flag).toHaveText("C");
});

test("reconciled rows do not expose the cycle button", async ({ page }) => {
  const stamp = Date.now();
  const accName = `PW RecAcc ${stamp}`;

  // Create a fresh isolated account with 0 balance
  await page.getByRole("button", { name: "Add Account" }).click();
  const accModal = page.locator(".y-modal").last();
  await accModal.locator('input[placeholder="e.g. TD Chequing"]').fill(accName);
  await accModal.getByRole("button", { name: "Add Account" }).click();
  await expect(accModal).toBeHidden();

  // Navigate to the newly created account register
  await page.getByRole("button", { name: accName }).first().click();
  await expect(
    page.locator(".y-toolbar").getByText(accName, { exact: true })
  ).toBeVisible();

  // Add a fresh row
  const payee = `PW Reconcile Cycle ${stamp}`;
  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("3.21");
  await modal.locator('input[type="date"]').first().fill("2026-08-15");
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(payee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  // Ensure it is cleared
  const newRow = page.getByRole("row").filter({ hasText: payee }).first();
  const newFlag = newRow.locator(".y-cleared");
  await expect(newFlag).toHaveText("C");

  // Reconcile via the toolbar
  await page.getByRole("button", { name: /Reconcile/i }).click();
  const rModal = page.locator(".y-modal").last();
  await expect(rModal.locator(".y-modal-head")).toHaveText(new RegExp(`Reconcile: ${accName}`));
  await rModal.getByRole("button", { name: "Reconcile", exact: true }).click();
  await expect(rModal).toBeHidden();

  // The row's status should now be R; the cell renders the
  // ClearedFlag with disabled=true so role="button" is NOT applied
  // (primitives.tsx:362, 372). The "R" text is still visible.
  await expect(newRow.locator(".y-cleared")).toHaveText("R");
  await expect(newRow.locator(".y-cleared")).not.toHaveRole("button");
});

test("editing a transaction through the modal persists the new amount", async ({ page }) => {
  // Create a fresh row with a unique payee so we know which row to
  // find after the save.
  const stamp = Date.now();
  const payee = `PW Edit ${stamp}`;
  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("1.11");
  await modal.locator('input[type="date"]').first().fill("2026-08-15");
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(payee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  // Click the row to open the edit modal. We filter out child
  // rows (those with the ↳ glyph) so we don't accidentally click
  // a split child.
  const row = page.getByRole("row").filter({ hasText: payee }).first();
  await row.click();

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Transaction")).toBeVisible();

  // The payee input is pre-filled; change the amount and save.
  const newAmount = "9.99";
  await editModal.locator('input[inputmode="decimal"]').first().fill(newAmount);
  await editModal.getByRole("button", { name: "Save Changes" }).click();
  await expect(editModal).toBeHidden();

  // The row now renders the new amount in either the Outflow or
  // Inflow column (positive amounts go to Inflow). The amount text
  // is rendered with the locale-aware formatter.
  await expect(row).toContainText("$9.99");
});

test("toggling the Cleared checkbox does not shift the modal fields", async ({ page }) => {
  // Open the edit modal on the first register row.
  const row = page
    .locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row")
    .first();
  await row.click();

  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText("Edit Transaction")).toBeVisible();

  const cbLabel = modal
    .locator("label")
    .filter({ hasText: "Cleared (bank has processed this)" });
  const cbInput = cbLabel.locator("input[type='checkbox']");
  const flagRow = modal.locator("div.pt-1.flex.items-center.gap-2");

  const before = await cbLabel.boundingBox();
  const flagBefore = await flagRow.boundingBox();
  const initiallyChecked = await cbInput.isChecked();

  // Toggle the checkbox twice (state-agnostic start); neither the checkbox
  // nor the field below it may move.
  await cbLabel.click();
  await expect(cbInput).toBeChecked({ checked: !initiallyChecked });
  await cbLabel.click();
  await expect(cbInput).toBeChecked({ checked: initiallyChecked });

  const after = await cbLabel.boundingBox();
  const flagAfter = await flagRow.boundingBox();
  expect(after?.y).toBe(before?.y);
  expect(after?.height).toBe(before?.height);
  expect(flagAfter?.y).toBe(flagBefore?.y);
});

test("split transactions render parent ClearedFlag and no subtransaction rows in list", async ({ page }) => {
  // Create a fresh split so we don't depend on seed data and so the
  // test survives a dev DB with leftover state.
  const stamp = Date.now();
  const payee = `PW Split Parent Flag ${stamp}`;

  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.getByRole("button", { name: /^split$/i }).click();
  await modal.locator('input[placeholder="e.g. Whole Foods"]').fill(payee);
  // Children must sum to the parent *with sign* (packages/logic/src/split.ts:88)
  // — so for a -$20 parent the children are also negative.
  const allDecimals = modal.locator('input[inputmode="decimal"]');
  await allDecimals.nth(0).fill("-20");
  const subCategoryInputs = modal.locator('input[placeholder="Category or Transfer…"]');
  await subCategoryInputs.nth(0).click();
  await page.locator('.y-dropdown button[role="option"]').nth(1).click();
  await subCategoryInputs.nth(0).click();
  await page.locator('.y-dropdown button[role="option"]').nth(2).click();
  await allDecimals.nth(1).fill("-12");
  await allDecimals.nth(2).fill("-8");
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();

  // The parent row renders in the register with its ClearedFlag.
  const parentRow = page.getByRole("row").filter({ hasText: payee }).first();
  await expect(parentRow).toBeVisible();
  const flag = parentRow.locator(".y-cleared");
  await expect(flag).toHaveText("C");

  // Cycling the ClearedFlag on the split parent toggles C -> U.
  await flag.click();
  await expect(flag).toHaveText("U");

  // No child rows (with ↳ glyph) exist in the register.
  const childCount = await page.locator("tbody tr.y-row", { hasText: "↳" }).count();
  expect(childCount).toBe(0);
});
