// apps/web/tests/e2e/recurring.spec.ts
//
// Covers RecurringView + RecurringModal:
//   - add a recurring entry (Modals.tsx:278-422)
//   - toggle the Active/Paused pill (RecurringView.tsx:82-96)
//   - Post Now creates a transaction and advances the next date
//     (BudgetAppShell.tsx:87-113)
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Recurring", exact: true }).click();
  await expect(page.getByText("Recurring Transactions", { exact: true }).first()).toBeVisible();
});

test("adds a new recurring transaction and renders its card", async ({ page }) => {
  const uniquePayee = `PW Recurring ${Date.now()}`;

  await page.getByRole("button", { name: "Add Recurring" }).click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText("Add Recurring Transaction")).toBeVisible();

  // Payee field opens from its closed trigger above the Amount/Frequency grid.
  await fillSearchlist(modal, "e.g. Whole Foods", uniquePayee);
  await modal.locator('input[inputmode="decimal"]').first().fill("42.00");
  await modal.locator('input[type="date"]').first().fill("2026-08-01");
  await modal.getByRole("button", { name: "Save" }).click();

  await expect(modal).toBeHidden();
  // The card title is a div with the payee (RecurringView.tsx:67-69).
  await expect(page.getByText(uniquePayee, { exact: true }).first()).toBeVisible();
});

test("toggles the Active/Paused pill on a recurring entry", async ({ page }) => {
  // Find the Active pill for any seeded recurring entry; the seed has
  // multiple, so we look for the first one with the "Active" label.
  const activePill = page.locator(".y-pill").filter({ hasText: "Active" }).first();
  await expect(activePill).toBeVisible();

  // Click the pill — it should flip to "Paused" (RecurringView.tsx:84-94).
  await activePill.click();
  await expect(page.locator(".y-pill").filter({ hasText: "Paused" }).first()).toBeVisible();

  // And back to Active.
  await page.locator(".y-pill").filter({ hasText: "Paused" }).first().click();
  await expect(page.locator(".y-pill").filter({ hasText: "Active" }).first()).toBeVisible();
});

test("Post Now creates a transaction and advances the next date", async ({ page }) => {
  // Set up a dialog handler in case any of the api calls trigger one
  // (none today, but safe).
  page.on("dialog", (d) => d.accept());

  // Use the API to find a stable target and to read truth after the
  // click — the DOM can lie if React holds stale props during the
  // optimistic update window.
  const before = await page.request.get("/api/budget");
  const beforeBody = await before.json();
  const target = beforeBody.recurring.find(
    (r: { payee: string; amount: string; frequency: string }) =>
      r.payee === "TD Bank" && Number(r.amount) === -235297 && r.frequency === "monthly"
  );
  expect(target).toBeTruthy();
  const idBefore = target.id;
  const dateBefore = target.nextDate;
  const txCountBefore = beforeBody.transactions.length;

  // Click the matching card's Post Now. We disambiguate from the
  // sibling "TD Bank" / -$1,800.00 card (Mortgage Principal) by the
  // amount rendered on the card.
  const card = page
    .locator(".y-panel")
    .filter({ hasText: "TD Bank" })
    .filter({ hasText: "$2,352.97" })
    .first();
  await card.getByRole("button", { name: "Post Now" }).click();

  // The click triggers a transaction create + a recurring PATCH +
  // a /api/budget reload. Wait for the post-reload state.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/budget");
        const body = await res.json();
        return {
          updated: body.recurring.find((r: { id: number }) => r.id === idBefore),
          txCount: body.transactions.length,
        };
      },
      { timeout: 10_000 }
    )
    .toMatchObject({
      updated: { nextDate: expect.stringMatching(/^2099-12$|^20\d{2}-/) },
      txCount: expect.anything(),
    });

  const afterRes = await page.request.get("/api/budget");
  const afterBody = await afterRes.json();
  const updated = afterBody.recurring.find((r: { id: number }) => r.id === idBefore);
  expect(updated).toBeTruthy();

  // Two side effects: a new transaction lands in /api/transactions, and
  // the recurring's nextDate moves forward.
  expect(afterBody.transactions.length).toBe(txCountBefore + 1);
  expect(updated.nextDate).not.toBe(dateBefore);
});

test("Post Now button stays readable while held down (blue :active)", async ({ page }) => {
  // Regression guard: the `.y-btn--blue` variant used to inherit the
  // light-gray `:active` gradient from the default button rule, leaving
  // white text unreadable while the mouse was held down. The fix adds
  // a dedicated dark-blue gradient + explicit `color: #fff` to
  // `.y-btn--blue:active` (and `.is-on`). Simulate the held-down state
  // by issuing `mouse.down()` without `mouse.up()`.
  const card = page
    .locator(".y-panel")
    .filter({ hasText: "TD Bank" })
    .filter({ hasText: "$2,352.97" })
    .first();
  const postNow = card.getByRole("button", { name: "Post Now" });
  const box = await postNow.boundingBox();
  if (!box) throw new Error("Post Now button not found");

  // Hover and press the mouse without releasing, so CSS `:active` applies.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    const color = await postNow.evaluate((el) => getComputedStyle(el).color);
    // White text on the dark-blue gradient stays readable while held down.
    expect(color).toBe("rgb(255, 255, 255)");
  } finally {
    await page.mouse.up();
  }
});
