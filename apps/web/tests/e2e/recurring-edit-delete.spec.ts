// apps/web/tests/e2e/recurring-edit-delete.spec.ts
//
// Extends the existing `recurring.spec.ts` (which only covers add +
// Active/Paused + Post Now) with the rest of the RecurringView
// surface and the RecurringModal's three modes:
//
//   - editing a recurring through the modal (RecurringView.tsx:166-172
//     → RecurringModal with `initial`, Modals.tsx:728 "Edit
//     Recurring Transaction")
//   - deleting a recurring via the trash button
//     (RecurringView.tsx:173-180)
//   - adding a new recurring in Transfer mode (Modals.tsx:739-753
//     segmented toggle) and confirming the card renders the
//     "sourceName → destName" hint (RecurringView.tsx:86-89)
//   - adding a new recurring in Split mode and confirming the
//     "split" pill renders (RecurringView.tsx:123-137) and the
//     Σ footer enables Save when children balance
//   - the Monthly Income / Bills / Net strip picks up the new
//     amounts (RecurringView.tsx:54-64)
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist, openSearchField, pickSubCategory } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoRecurring(page: Page) {
  await page
    .getByRole("button", { name: "Recurring", exact: true })
    .click();
  await expect(
    page.getByText("Recurring Transactions", { exact: true }).first()
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoRecurring(page);
});

test("editing a recurring updates the card", async ({ page }) => {
  // Self-contained: create a fresh recurring first so the test
  // survives both a CI reset and a dev DB with leftover state
  // (e.g. previous test runs that may have renamed TD Bank etc.).
  const stamp = Date.now();
  const original = `PW Edit ${stamp}`;
  const renamed = `PW Edited ${stamp}`;

  await page.getByRole("button", { name: "Add Recurring" }).click();
  const addModal = page.locator(".y-modal").last();
  await fillSearchlist(addModal, "e.g. Whole Foods", original);
  await addModal.locator('input[inputmode="decimal"]').first().fill("-10.00");
  await addModal.locator('input[type="date"]').first().fill("2026-08-01");
  await addModal.getByRole("button", { name: "Save" }).click();
  await expect(addModal).toBeHidden();
  await expect(page.getByText(original, { exact: true }).first()).toBeVisible();

  // Click the card's edit pencil — aria-label="Edit <payee>"
  // (RecurringView.tsx:168).
  await page.getByRole("button", { name: `Edit ${original}` }).click();
  const editModal = page.locator(".y-modal").last();
  await expect(editModal.getByText("Edit Recurring Transaction")).toBeVisible();

  // The payee field is pre-filled; change it and the amount.
  await fillSearchlist(editModal, "e.g. Whole Foods", renamed);
  await editModal.locator('input[inputmode="decimal"]').first().fill("-25.00");
  await editModal.getByRole("button", { name: "Save Changes" }).click();
  await expect(editModal).toBeHidden();

  // The card now shows the new payee and amount.
  const card = page
    .locator(".y-panel")
    .filter({ hasText: renamed })
    .first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("-$25.00");
});

test("deleting a recurring removes its card", async ({ page }) => {
  // Self-contained: create a sacrificial entry.
  const stamp = Date.now();
  const payee = `PW Trash ${stamp}`;

  await page.getByRole("button", { name: "Add Recurring" }).click();
  const modal = page.locator(".y-modal").last();
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  await modal.locator('input[inputmode="decimal"]').first().fill("-1.00");
  await modal.locator('input[type="date"]').first().fill("2026-08-01");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText(payee, { exact: true }).first()).toBeVisible();

  // The trash button has aria-label="Delete <payee>"
  // (RecurringView.tsx:178). Click trash then confirm in the modal.
  const delBtn = page.getByRole("button", { name: `Delete ${payee}` });
  await delBtn.scrollIntoViewIfNeeded();
  await delBtn.click();
  await page.getByRole("button", { name: "Delete Recurring Rule" }).click();

  // The card disappears
  await expect(page.getByText(payee, { exact: true })).toHaveCount(0);
});

test("adding a recurring Transfer renders the source → dest hint", async ({ page }) => {
  const stamp = Date.now();
  const payee = `PW Recur Xfer ${stamp}`;

  // Read the math-strip "Monthly Bills" before so we can confirm
  // the new row contributes. A transfer contributes $0 to the net
  // (logic/recurring.ts:58) so the strip should be unchanged; we
  // just assert the card appears.
  const billsCell = page
    .locator(".y-mathbox")
    .filter({ has: page.getByText("Monthly Bills", { exact: true }) });
  const billsBefore = (await billsCell.locator(".y-math-val").textContent())?.trim();

  await page.getByRole("button", { name: "Add Recurring" }).click();
  const modal = page.locator(".y-modal").last();
  await modal.getByRole("button", { name: /^transfer$/i }).click();
  await modal.locator('input[inputmode="decimal"]').first().fill("-50.00");
  await modal.locator('input[type="date"]').first().fill("2026-08-01");
  // The Transfer-mode payee input is the auto-generated one
  // (Modals.tsx:834) — leave it blank so the server fills in
  // "Transfer : <dest>".
  await openSearchField(modal, "Select account…");
  const options = page.locator('.y-dropdown button[role="option"]');
  await expect(options.first()).toBeVisible();
  const destOption = options.nth(1);
  const destName = (await destOption.textContent())?.trim()!;
  await destOption.click();
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // The card renders the payee (which the server normalised to
  // "Transfer : <dest>") and the source → dest hint.
  const card = page
    .locator(".y-panel")
    .filter({ hasText: `Transfer : ${destName}` })
    .first();
  await expect(card).toBeVisible();
  // The card should contain "→" between source and dest
  // (RecurringView.tsx:87-88).
  await expect(card).toContainText("→");
  await expect(card).toContainText(destName);

  // The "transfer" flavour pill renders too (RecurringView.tsx:123-137).
  await expect(card).toContainText(/transfer/i);

  // And the Monthly Bills math strip is unchanged (a transfer nets
  // to 0 — see logic/recurring.ts:54-63).
  const billsAfter = (await billsCell.locator(".y-math-val").textContent())?.trim();
  expect(billsAfter).toBe(billsBefore);

  // Suppress unused-variable lint; payee is here for debugging if
  // the test ever fails.
  expect(payee).toBeTruthy();
});

test("adding a recurring Split enables Save when children balance", async ({ page }) => {
  const stamp = Date.now();
  const payee = `PW Recur Split ${stamp}`;

  await page.getByRole("button", { name: "Add Recurring" }).click();
  const modal = page.locator(".y-modal").last();
  await modal.getByRole("button", { name: /^split$/i }).click();

  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  const allDecimals = modal.locator('input[inputmode="decimal"]');
  await allDecimals.nth(0).fill("-30");

  await pickSubCategory(modal, page, 1);
  await pickSubCategory(modal, page, 2);

  // Off by a cent — Save should be disabled (Modals.tsx:720).
  await allDecimals.nth(1).fill("-20");
  await allDecimals.nth(2).fill("-9.99");
  const saveBtn = modal.getByRole("button", { name: "Save" });
  await expect(saveBtn).toBeDisabled();

  // Fix the imbalance → Save enables.
  await allDecimals.nth(2).fill("-10");
  await expect(saveBtn).toBeEnabled();

  await modal.locator('input[type="date"]').first().fill("2026-08-01");
  await saveBtn.click();
  await expect(modal).toBeHidden();

  // Card renders the "split" flavour pill
  // (RecurringView.tsx:123-137 → `flavour`).
  const card = page.locator(".y-panel").filter({ hasText: payee }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/split/i);
  await expect(card).toContainText("2 categories");
});

test("Monthly Income / Bills / Net math strip updates when a bill is added", async ({ page }) => {
  const stamp = Date.now();
  const payee = `PW Recur Bill ${stamp}`;

  const billsCell = page
    .locator(".y-mathbox")
    .filter({ has: page.getByText("Monthly Bills", { exact: true }) });
  const billsBefore = (await billsCell.locator(".y-math-val").textContent())?.trim();
  expect(billsBefore).toBeTruthy();

  // Add a -$123.45 monthly bill. The strip uses Math.abs in
  // display (RecurringView.tsx:30-32 — the reducer keeps only
  // negative values, then UI shows them as a "Bills" cell so the
  // display is `fmt(monthlyOut)` = -fmt(|sum|) which renders as a
  // positive money value with a leading minus). We just need the
  // before/after to differ; the absolute delta is what the user
  // sees.
  await page.getByRole("button", { name: "Add Recurring" }).click();
  const modal = page.locator(".y-modal").last();
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  await modal.locator('input[inputmode="decimal"]').first().fill("-123.45");
  await modal.locator('input[type="date"]').first().fill("2026-08-01");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  const billsAfter = (await billsCell.locator(".y-math-val").textContent())?.trim();
  expect(billsAfter).toBeTruthy();
  expect(billsAfter).not.toBe(billsBefore);

  // The new card is visible.
  const card = page.locator(".y-panel").filter({ hasText: payee }).first();
  await expect(card).toBeVisible();
});
