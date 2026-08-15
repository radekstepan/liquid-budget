// apps/web/tests/e2e/accounts.spec.ts
//
// Covers the Sidebar's account CRUD surface:
//   - "Add Account" button (Sidebar.tsx:176-181) → AccountModal
//     (Modals.tsx:424-490)
//   - hover-revealed edit pencil (Sidebar.tsx:140-153)
//   - hover-revealed trash (Sidebar.tsx:154-169) + window.confirm
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("adds a new liquid account and renders it under Budget Accounts", async ({ page }) => {
  const name = `PW Account ${Date.now()}`;

  await page.getByRole("button", { name: "Add Account" }).click();
  const modal = page.locator(".y-modal").last();
  // The modal head title (Modals.tsx:114-119) and the footer's
  // "Add Account" button both contain the same text; scope to the head.
  await expect(modal.locator(".y-modal-head")).toHaveText("Add Account");

  // Account Name (autofocuses — Modals.tsx:466).
  await modal.locator("input").first().fill(name);
  await modal.locator(".y-select-trigger").first().click();
  await page.locator('.y-dropdown [data-value="liquid"]').click();
  await modal.locator('input[inputmode="decimal"]').first().fill("250.00");
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Add Account" }).click();

  await expect(modal).toBeHidden();
  // The account row is a button whose accessible name is
  // "<name> <balance>" (Sidebar.tsx:124-139).
  await expect(
    page.getByRole("button", { name: new RegExp(`^${name} `) })
  ).toBeVisible();
});

test("edits an existing account balance via the hover-revealed pencil", async ({ page }) => {
  // The TD Unlimited Chequing account is the first seeded one (seed.ts:114).
  // The hover-revealed edit button uses aria-label "Edit account <name>".
  const editBtn = page.getByRole("button", { name: "Edit account TD Unlimited Chequing" });
  await editBtn.click({ force: true });

  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Edit Account");

  // Overwrite the balance field.
  const balance = modal.locator('input[inputmode="decimal"]').first();
  await balance.fill("12345.67");
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save Changes" }).click();

  await expect(modal).toBeHidden();
  // The sidebar shows the new balance next to the account name.
  await expect(
    page.getByRole("button", { name: /TD Unlimited Chequing.*12,345/ }).first()
  ).toBeVisible();
});

test("deletes an account after accepting the confirm dialog", async ({ page }) => {
  // We need a sacrificial account so we don't disturb the other tests.
  const name = `PW Trash ${Date.now()}`;
  await page.getByRole("button", { name: "Add Account" }).click();
  const addModal = page.locator(".y-modal").last();
  await addModal.locator("input").first().fill(name);
  await addModal.locator(".y-select-trigger").first().click();
  await page.locator('.y-dropdown [data-value="liquid"]').click();
  await addModal.locator('input[inputmode="decimal"]').first().fill("1.00");
  await addModal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Add Account" })
    .click();
  await expect(addModal).toBeHidden();

  // The trash button was removed from the sidebar. Deletion now goes
  // through the Edit Account modal: hover-reveal the edit pencil
  // (Sidebar.tsx), open the modal, click "Delete account" to enter the
  // confirm panel, then "Yes, delete it" to finalise.
  await page
    .getByRole("button", { name: `Edit account ${name}` })
    .click({ force: true });

  const editModal = page.locator(".y-modal").last();
  await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Account");

  // Step 1: enter the confirm panel.
  await editModal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Delete account" })
    .click();
  await expect(editModal.locator(".y-modal-head")).toContainText("Delete");

  // Step 2: confirm the deletion.
  await editModal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Yes, delete it" })
    .click();
  await expect(editModal).toBeHidden();

  // The account row is a button whose accessible name is
  // "<name> <balance>"; the Edit button has aria-label "Edit account <name>",
  // so anchor the regex with `^` to match only the row.
  await expect(
    page.getByRole("button", { name: new RegExp(`^${name} `) })
  ).toHaveCount(0);
});
