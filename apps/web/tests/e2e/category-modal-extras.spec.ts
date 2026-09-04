// apps/web/tests/e2e/category-modal-extras.spec.ts
//
// Extends the existing `categories.spec.ts` (which only covers
// name-only add/edit/rename) with the rest of the CategoryModal
// surface:
//
//   - creating a category with a funding goal (Modals.tsx:483-500)
//     — the funding-goal checkbox is a sr-only input wrapped in a
//     <label>, so the click target is the label text
//   - PATCH /api/categories with a carryover value (the
//     carryover can only be set via the API: the create flow
//     drops it, see apps/web/src/components/BudgetAppShell.tsx:189-193,
//     so the supported user path is create-then-edit via PATCH)
//
// Note: the UI flow for setting a carryover on a *new* category
// does not work today — the BudgetAppShell saveCategory POST
// drops `carryover`, and the in-app edit modal misroutes the
// category id (BudgetView.tsx:237 passes `g.group.id` instead of
// the row's category id, so editing any category in a group opens
// the modal for whichever category's id happens to equal the
// group id). Until that's fixed, the carryover round-trip is
// covered via the API contract below.
//
// Delete affordances for category/group rows are *not* present in
// the UI (the props exist on BudgetView but no button is rendered),
// so those flows are intentionally uncovered here.
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

async function getCategory(
  page: Page,
  name: string
): Promise<{ id: number; goalTarget: string | null; carryover: string }> {
  const res = await page.request.get("/api/budget");
  const body = await res.json();
  const row = body.categories.find(
    (c: { name: string }) => c.name === name
  );
  expect(row, `seed or created category ${name} should exist`).toBeTruthy();
  return row;
}

test("creating a category with a funding goal persists goalTarget", async ({ page }) => {
  // Self-contained: create a fresh category with a unique name so
  // the test survives both a CI reset and a dev DB with leftover
  // state from previous test runs.
  const stamp = Date.now();
  const name = `PW Goal ${stamp}`;

  // Open the New Category modal via the Needs group's "+"
  // (BudgetView.tsx:369-379, aria-label="Add category").
  const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
  await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });

  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("New Category");

  await modal.locator("input").first().fill(name);

  // Tick the funding-goal checkbox. The Checkbox (theme/primitives.tsx:221-240)
  // wraps a sr-only <input type="checkbox"> in a <label> that contains
  // the visible text "Set a funding goal". The label is the natural
  // click target and is the pattern the rest of the app's modals
  // use; it is more reliable than `check({ force: true })` against
  // the sr-only input.
  await modal.getByText("Set a funding goal", { exact: true }).click();

  // The Goal Target field is now visible (Modals.tsx:490-501).
  // It's the second input that becomes visible (the first is the
  // name). Scope by label.
  const goalLabel = modal
    .locator(".y-label")
    .filter({ hasText: "Goal Target" });
  await expect(goalLabel).toBeVisible();
  const goalInput = goalLabel.locator("..").locator("input");
  await goalInput.fill("1234.56");

  await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();

  // The row is in the budget; the goalTarget is on the server row.
  const row = page
    .locator("tr[data-cat-row]")
    .filter({ hasText: name });
  await expect(row).toBeVisible();

  const stored = await getCategory(page, name);
  expect(Number(stored.goalTarget)).toBe(123456);
});

test("PATCH /api/categories persists a carryover change", async ({ page }) => {
  // The UI edit modal currently misroutes category ids (see file
  // header), so the carryover round-trip is covered directly
  // against the API. The supported user flow today is:
  // create → re-fetch the row's id → PATCH with carryover.
  const stamp = Date.now();
  const name = `PW Carry ${stamp}`;

  // Create the row via POST (carryover is dropped here, that's the
  // documented behaviour of the create handler).
  const create = await page.request.post("/api/categories", {
    data: {
      groupId: 2, // Needs
      name,
      goalTarget: null,
    },
  });
  expect(create.status()).toBe(200);
  const created = await create.json();
  expect(created.id).toBeGreaterThan(0);

  // PATCH the new row with a carryover.
  const patch = await page.request.patch("/api/categories", {
    data: { id: created.id, carryover: -5000 },
  });
  expect(patch.status()).toBe(200);

  // The persisted row reflects the carryover.
  const stored = await getCategory(page, name);
  expect(Number(stored.carryover)).toBe(-5000);
});
