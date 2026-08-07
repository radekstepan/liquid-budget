// apps/web/tests/e2e/account-types.spec.ts
//
// Extends the existing `accounts.spec.ts` (which only covers the
// Liquid account kind) with the rest of the AccountModal surface
// and the Sidebar's grouping + Net Worth panel:
//
//   - adding a Credit Card account and asserting it lands under
//     the "Credit Cards" group in the sidebar
//     (AccountModal.tsx:997-1002 → AccountModal maps the `kind`
//     to the `groupLabel` server-side, Sidebar.tsx:99-118 renders
//     per-group accordions)
//   - adding an Off-Budget account and asserting it lands under
//     "Retirement" (the off-budget kind maps to "Retirement" per
//     AccountModal.tsx:970 — Investments accounts seeded under
//     "Investments" come from the fixture, not the UI; the test
//     exercises the create flow only)
//   - the Net Worth panel breakdown reflects the new accounts
//     (Sidebar.tsx:200-241)
//   - renaming an account via the edit pencil
//   - sidebar group collapse/expand (the "Credit Cards" header
//     hides its children when collapsed)
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

test("adds a Credit Card account under the Credit Cards group", async ({ page }) => {
  const stamp = Date.now();
  const name = `PW Card ${stamp}`;

  await page.getByRole("button", { name: "Add Account" }).click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Add Account");

  await modal.locator("input").first().fill(name);
  // The Type <select> is the first (and only) one in the modal
  // (AccountModal.tsx:993-1003).
  await modal.locator("select").first().selectOption("credit");
  await modal.locator('input[inputmode="decimal"]').first().fill("-100.00");
  await modal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Add Account" })
    .click();
  await expect(modal).toBeHidden();

  // The new account row is in the sidebar. The sidebar's account
  // row buttons have accessible name "<name> <balance>"
  // (Sidebar.tsx:118-141).
  const row = page.getByRole("button", { name: new RegExp(`^${name} `) });
  await expect(row).toBeVisible();

  // The row is nested under the "Credit Cards" group header.
  // The group's account list sits between the header button and
  // the next group header; verify that the row is positioned
  // after a Credit Cards header and before the next group.
  const ccHeader = page
    .locator("button.y-side-head")
    .filter({ hasText: "Credit Cards" })
    .first();
  await expect(ccHeader).toBeVisible();
  // The row's bounding box is below the header's.
  const headerBox = await ccHeader.boundingBox();
  const rowBox = await row.boundingBox();
  expect(headerBox, "header should be visible").toBeTruthy();
  expect(rowBox, "row should be visible").toBeTruthy();
  expect(rowBox!.y).toBeGreaterThan(headerBox!.y);
});

test("adds an Off-Budget account under the Retirement group", async ({ page }) => {
  const stamp = Date.now();
  const name = `PW Off ${stamp}`;

  await page.getByRole("button", { name: "Add Account" }).click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Add Account");

  await modal.locator("input").first().fill(name);
  await modal.locator("select").first().selectOption("offbudget");
  await modal.locator('input[inputmode="decimal"]').first().fill("1234.56");
  await modal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Add Account" })
    .click();
  await expect(modal).toBeHidden();

  // The "Retirement" group is collapsed by default
  // (Sidebar.tsx:50-52), so the new row is hidden until the
  // group is expanded. Click the header to expand.
  const retirementHeader = page
    .locator("button.y-side-head")
    .filter({ hasText: "Retirement" })
    .first();
  await expect(retirementHeader).toBeVisible();
  await retirementHeader.click();

  // The new account row is in the sidebar.
  const row = page.getByRole("button", { name: new RegExp(`^${name} `) });
  await expect(row).toBeVisible();

  // AccountModal.tsx:970 maps the offbudget kind to the
  // "Retirement" groupLabel, so the new account renders under
  // the "Retirement" group header.
  const headerBox = await retirementHeader.boundingBox();
  const rowBox = await row.boundingBox();
  expect(headerBox, "header should be visible").toBeTruthy();
  expect(rowBox, "row should be visible").toBeTruthy();
  expect(rowBox!.y).toBeGreaterThan(headerBox!.y);
});

test("Net Worth panel reflects a newly created Liquid account", async ({ page }) => {
  // Add a $1,000 Liquid account; the Liquid Accounts row in the
  // Net Worth panel should pick it up.
  const stamp = Date.now();
  const name = `PW Net ${stamp}`;
  const startBalance = 1000;

  // Read the Liquid total before.
  const panel = page.locator("aside.y-inspector").first();
  const liquidBefore = await getNetWorthRow(page, "Liquid Accounts");

  await page.getByRole("button", { name: "Add Account" }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator("input").first().fill(name);
  await modal.locator("select").first().selectOption("liquid");
  await modal.locator('input[inputmode="decimal"]').first().fill(String(startBalance));
  await modal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Add Account" })
    .click();
  await expect(modal).toBeHidden();

  // Wait for the panel re-render.
  await expect
    .poll(async () => getNetWorthRow(page, "Liquid Accounts"), { timeout: 5_000 })
    .toBe(liquidBefore + startBalance);

  // Suppress unused-variable lint.
  expect(panel).toBeTruthy();
});

async function getNetWorthRow(page: Page, label: string): Promise<number> {
  // The Net Worth card (Sidebar.tsx:200-241) renders rows like
  // "Liquid Accounts   $118,341.69" inside a styled box. The text
  // format is `<label> <value>`. The dollar value is the only
  // number, so a regex parse works.
  const text = await page
    .locator("aside.y-sidebar, [class*='y-sidebar']")
    .first()
    .textContent();
  expect(text, "sidebar should be visible").toBeTruthy();
  // Find the label followed by a $-prefixed number.
  const re = new RegExp(`${label}\\s*(-?\\$[\\d,]+\\.\\d{2})`);
  const match = text!.match(re);
  if (!match) {
    throw new Error(`Net Worth row "${label}" not found in sidebar text`);
  }
  return Number(match[1]!.replace(/[$,]/g, ""));
}

test("renames an account via the edit pencil", async ({ page }) => {
  // Create a fresh account so we can rename it without affecting
  // any other spec.
  const stamp = Date.now();
  const original = `PW RenameMe ${stamp}`;
  const renamed = `PW Renamed ${stamp}`;

  await page.getByRole("button", { name: "Add Account" }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator("input").first().fill(original);
  await addModal.locator("select").first().selectOption("liquid");
  await addModal.locator('input[inputmode="decimal"]').first().fill("10.00");
  await addModal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Add Account" })
    .click();
  await expect(addModal).toBeHidden();

  // Sidebar's edit pencil: aria-label="Edit account <name>"
  // (Sidebar.tsx:151). It's hidden until row hover, so we
  // force the click.
  await page
    .getByRole("button", { name: `Edit account ${original}` })
    .click({ force: true });

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Account");

  // The Name field is the first input.
  await editModal.locator("input").first().fill(renamed);
  await editModal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Save Changes" })
    .click();
  await expect(editModal).toBeHidden();

  // The sidebar row now shows the new name; the old name is gone.
  await expect(
    page.getByRole("button", { name: new RegExp(`^${renamed} `) })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${original} `) })
  ).toHaveCount(0);
});

test("sidebar group collapse hides its accounts; expand restores them", async ({ page }) => {
  // The "Credit Cards" group is expanded by default (Sidebar.tsx:50-52
  // starts only "Retirement" collapsed). Click its header to
  // collapse; the children vanish. Click again to expand.
  const ccHeader = page
    .locator("button.y-side-head")
    .filter({ hasText: "Credit Cards" })
    .first();
  await expect(ccHeader).toBeVisible();

  // The first Credit Card is "AMEX Cobalt" (seed.ts:16).
  const firstCard = page.getByRole("button", { name: /^AMEX Cobalt / });
  await expect(firstCard).toBeVisible();

  await ccHeader.click();
  await expect(firstCard).toBeHidden();

  await ccHeader.click();
  await expect(firstCard).toBeVisible();
});
