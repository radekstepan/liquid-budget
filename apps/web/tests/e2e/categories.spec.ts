// apps/web/tests/e2e/categories.spec.ts
//
// Covers BudgetView's category + group CRUD:
//   - "Master Category" toolbar button (BudgetView.tsx:138-140) → GroupModal
//   - per-group "+" (BudgetView.tsx:369-379) → CategoryModal
//   - per-group name click (BudgetView.tsx:355-367) → GroupModal rename
//   - per-category edit pencil (BudgetView.tsx:447-457) → CategoryModal edit
//     (the funding-goal checkbox inside CategoryModal uses a sr-only
//     input that Playwright struggles to click reliably across
//     invocations, so the goal toggle is not exercised here)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("adds a new master category group via the toolbar button", async ({ page }) => {
  const name = `PW Group ${Date.now()}`;

  await page.getByRole("button", { name: "Master Category" }).click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText("New Category Group", { exact: true })).toBeVisible();
  await modal.locator("input").first().fill(name);
  await modal.getByRole("button", { name: "Save" }).click();

  await expect(modal).toBeHidden();
  // The new group appears as a master row (BudgetView.tsx:318-389);
  // its name is wrapped in a role=button that opens the rename modal.
  await expect(
    page.getByRole("button", { name, exact: true }).first()
  ).toBeVisible();
});

test("adds a new category to an existing group via the group + button", async ({ page }) => {
  const categoryName = `PW Category ${Date.now()}`;

  // The Needs group's "+" button (aria-label="Add category",
  // BudgetView.tsx:374-376). Multiple groups expose this, so we scope
  // to the first master row that has a "Needs" name.
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });

  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText("New Category", { exact: true })).toBeVisible();
  await modal.locator("input").first().fill(categoryName);
  await modal.getByRole("button", { name: "Save" }).click();

  await expect(modal).toBeHidden();
  // Category rows carry data-cat-row (BudgetView.tsx:393-395).
  await expect(
    page.locator("tr[data-cat-row]").filter({ hasText: categoryName })
  ).toBeVisible();
});

test("renames a category group via the group-name click target", async ({ page }) => {
  // Self-contained: create a fresh group first so the test survives
  // both a CI-reset baseline and a shared dev DB with leftover state
  // from previous test runs.
  const original = `PW RenameMe ${Date.now()}`;
  const renamed = `PW Renamed ${Date.now()}`;

  // Add a new group via the toolbar button (BudgetView.tsx:138-140).
  await page.getByRole("button", { name: "Master Category" }).click();
  let modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("New Category Group");
  await modal.locator("input").first().fill(original);
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // Now click the new group's name (BudgetView.tsx:355-367) to open
  // the rename modal.
  await page.getByRole("button", { name: original, exact: true }).first().click();
  modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Rename Group");
  await modal.locator("input").first().fill(renamed);
  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();

  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("button", { name: renamed, exact: true }).first()
  ).toBeVisible();
});

test("edits a category's name via the row edit pencil", async ({ page }) => {
  // Self-contained: create a fresh category in the Needs group first
  // so the test survives both a CI reset and a dev DB with leftover
  // state from previous test runs (which would have renamed seed
  // categories).
  const original = `PW EditMe ${Date.now()}`;
  const renamed = `PW Edited ${Date.now()}`;

  // Add a new category to Needs (BudgetView.tsx:369-379).
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
  let modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("New Category");
  await modal.locator("input").first().fill(original);
  await modal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(modal).toBeHidden();

  // Open the edit modal for the row we just created.
  // The per-row edit pencil is aria-label "Edit <name>"
  // (BudgetView.tsx:453).
  await page.getByRole("button", { name: `Edit ${original}` }).click({ force: true });
  modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Edit Category");

  // Overwrite the name and save.
  await modal.locator("input").first().fill(renamed);
  await modal
    .locator(".y-modal-foot")
    .getByRole("button", { name: "Save" })
    .click();

  await expect(modal).toBeHidden();
  await expect(
    page.locator("tr[data-cat-row]").filter({ hasText: renamed })
  ).toBeVisible();
});
