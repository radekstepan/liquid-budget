// apps/web/tests/e2e/notifications.spec.ts
//
// Verifies that explicit mutations surface consistent toast notifications:
//
//   - success toasts after create/update/delete/import/reconcile actions
//   - a single danger toast when an operation fails (modal stays open)
//   - automatic posting of due scheduled transactions is reported once
//   - excluded operations (budget assignment, transaction status/flag
//     changes, drag reordering) do not emit new success toasts
//
// The suite shares the mutating test DB, so it is serial (workers: 1 in
// playwright.config.ts) and relies on the global-setup reset for a known
// baseline. Toasts auto-dismiss after 4 seconds; every assertion targets
// exact toast text so stale toasts from earlier steps cannot collide.
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist } from "./helpers";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
  // Wait for the initial data fetch to complete (the sidebar renders once
  // the shell has loaded the budget) before interacting with the app.
  await expect(page.getByText("TD Unlimited Chequing").first()).toBeVisible();
}

/**
 * Reset the DB to the demo seed and load a fresh page. Because the seed
 * contains due recurring entries (their nextDate is in the past), the very
 * first load after a reset auto-posts them and shows the automatic-post
 * toast. This helper waits for that toast to appear and auto-dismiss so the
 * rest of the test starts from a clean toast surface.
 */
async function loadFresh(page: Page) {
  await page.goto("/");
  await waitForReady(page);
  await expect(page.getByText(/Automatically entered \d+ scheduled transactions?\./)).toBeVisible();
  await expect(page.getByText(/Automatically entered \d+ scheduled transactions?\./)).toBeHidden({ timeout: 10_000 });
}

async function resetToDemo() {
  const res = await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

async function addTransactionViaModal(
  page: Page,
  payee: string,
  amount = "12.34"
) {
  await page.getByRole("button", { name: /Add.*Transaction/i }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill(amount);
  await modal.locator('input[type="date"]').first().fill("2026-09-01");
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function addRecurringViaModal(
  page: Page,
  payee: string,
  amount: string,
  date: string
) {
  await page.getByRole("button", { name: "Schedule a new transaction" }).click();
  const modal = page.locator(".y-modal").last();
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  await modal.locator('input[inputmode="decimal"]').first().fill(amount);
  await modal.locator('input[type="date"]').first().fill(date);
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden();
  const row = page.locator(".y-scheduled-table").getByRole("row").filter({ hasText: payee }).first();
  await expect(row).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetToDemo();
  await loadFresh(page);
});

test.describe("success notifications", () => {
  test("adding a transaction shows a success toast", async ({ page }) => {
    await gotoAllTransactions(page);
    const payee = `PW Notify Tx ${Date.now()}`;
    await addTransactionViaModal(page, payee);
    await expect(page.getByText("Transaction added.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: payee })).toBeVisible();
  });

  test("creating an account shows a success toast", async ({ page }) => {
    const name = `PW Notify Acct ${Date.now()}`;
    await page.getByRole("button", { name: "Add Account" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator("input").first().fill(name);
    await modal.locator(".y-modal-foot").getByRole("button", { name: "Add Account" }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByText("Account created.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name} `) })
    ).toBeVisible();
  });

  test("editing an account shows a success toast", async ({ page }) => {
    const stamp = Date.now();
    const name = `PW Notify Rename ${stamp}`;
    const renamed = `PW Notify Renamed ${stamp}`;
    await page.getByRole("button", { name: "Add Account" }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator("input").first().fill(name);
    await addModal.locator(".y-modal-foot").getByRole("button", { name: "Add Account" }).click();
    await expect(addModal).toBeHidden();

    await page.getByRole("button", { name: `Edit account ${name}` }).click({ force: true });
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[placeholder="e.g. TD Chequing"]').first().fill(renamed);
    await modal.locator(".y-modal-foot").getByRole("button", { name: "Save Changes" }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByText("Account updated.")).toBeVisible();
  });

  test("creating a category shows a success toast", async ({ page }) => {
    const name = `PW Notify Cat ${Date.now()}`;
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    const modal = page.locator(".y-modal").last();
    await modal.locator("input").first().fill(name);
    await modal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByText("Category created.")).toBeVisible();
  });

  test("scheduling a recurring transaction shows a success toast", async ({ page }) => {
    await gotoAllTransactions(page);
    const payee = `PW Notify Recur ${Date.now()}`;
    await addRecurringViaModal(page, payee, "-10.00", "2026-12-01");
    await expect(page.getByText("Recurring transaction scheduled.")).toBeVisible();
  });

  test("posting a scheduled transaction shows a success toast", async ({ page, request }) => {
    await gotoAllTransactions(page);
    const payee = `PW Notify Post ${Date.now()}`;
    // Create the entry with a future date so it is not auto-posted on save.
    await addRecurringViaModal(page, payee, "-10.00", "2026-12-01");

    // Make it paused and overdue via the API so it is never auto-posted,
    // keeping its "Enter Now" button in the scheduled drawer clickable.
    const budget = await (await request.get("/api/budget")).json();
    const created = budget.recurring.find((r: { payee: string }) => r.payee === payee);
    expect(created).toBeTruthy();
    const patch = await request.patch("/api/recurring", {
      data: { id: created.id, active: false, nextDate: "2026-08-01" },
    });
    expect(patch.status()).toBe(200);

    // Reload so the scheduled drawer reflects the paused + overdue entry.
    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);
    const row = page
      .locator(".y-scheduled-table")
      .getByRole("row")
      .filter({ hasText: payee })
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText("Edit Recurring Transaction")).toBeVisible();
    await page.getByRole("button", { name: "Enter Now" }).click();
    await expect(page.getByText("Scheduled transaction entered.")).toBeVisible();
  });

  test("reconciling an account shows a success toast", async ({ page }) => {
    await page.getByRole("button", { name: /^Cash / }).click();
    await expect(
      page.locator(".y-toolbar").getByText("Cash", { exact: true })
    ).toBeVisible();

    await page.getByRole("button", { name: "Reconcile", exact: true }).click();
    const modal = page.locator(".y-modal").last();
    await expect(modal.locator(".y-modal-head")).toHaveText(/Reconcile: Cash/);
    await modal.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByText("Account reconciled.")).toBeVisible();
  });

  test("adding a rename rule shows a success toast", async ({ page }) => {
    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await page.getByText("Rename rules").click();
    await expect(page.getByText("Payee Rename Rules")).toBeVisible();
    await page.getByRole("button", { name: "Add rename rule" }).click();
    await page.getByLabel("Source pattern").fill(`PW ${Date.now()}`);
    await page.getByLabel("Target payee").fill("Notify Target");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByText("Rename rule created.")).toBeVisible();
  });
});

test.describe("failure notifications", () => {
  test("failing to add a transaction shows a single danger toast, keeps the modal open, and rolls back the optimistic update", async ({
    page,
  }) => {
    await page.route("**/api/transactions", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });

    await gotoAllTransactions(page);

    // Count rows before the failed attempt
    const rowCountBefore = await page.locator("tbody tr.y-row").count();

    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("5.00");
    await modal.locator('input[type="date"]').first().fill("2026-09-01");
    await fillSearchlist(modal, "e.g. Whole Foods", `PW Notify Fail ${Date.now()}`);
    await modal.getByRole("button", { name: "Save Transaction" }).click();

    await expect(page.getByText("Failed to add transaction. Please try again.")).toBeVisible();
    await expect(page.getByText("Add Transaction", { exact: true }).first()).toBeVisible();

    // Assert optimistic row was rolled back — row count unchanged
    const rowCountAfter = await page.locator("tbody tr.y-row").count();
    expect(rowCountAfter).toBe(rowCountBefore);
  });

  test("failing to reconcile shows a danger toast and keeps the modal open", async ({
    page,
  }) => {
    await page.route("**/api/reconcile", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
    );

    await page.getByRole("button", { name: /^Cash / }).click();
    await page.getByRole("button", { name: "Reconcile", exact: true }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: "Reconcile", exact: true }).click();

    await expect(page.getByText("Failed to reconcile account.")).toBeVisible();
    await expect(modal.locator(".y-modal-head")).toHaveText(/Reconcile: Cash/);
  });

  test("failing to save a rename rule shows the inline notice but no global toast", async ({
    page,
  }) => {
    await page.route("**/api/rename-rules", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });

    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await page.getByText("Rename rules").click();
    await expect(page.getByText("Payee Rename Rules")).toBeVisible();
    await page.getByRole("button", { name: "Add rename rule" }).click();
    await page.getByLabel("Source pattern").fill(`PW ${Date.now()}`);
    await page.getByLabel("Target payee").fill("Notify Target");
    await page.getByRole("button", { name: "Save rule" }).click();

    await expect(page.getByText("Rule not saved")).toBeVisible();
    await expect(page.locator(".y-toast").filter({ hasText: "rename" })).toHaveCount(0);
  });

  test("failing to save a budget assignment rolls back the optimistic inline edit", async ({
    page,
  }) => {
    await page.route("**/api/assignments", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });

    // "Home Insurance" has a zero June assignment in the demo seed.
    const row = page.locator("tr[data-cat-row]").filter({ hasText: "Home Insurance" }).first();
    await expect(row).toBeVisible();
    const originalText = await row.locator(".y-inline-amt").first().textContent();

    // Attempt to change the assignment — optimistic update fires.
    const assignedBtn = row.locator(".y-inline-amt").first();
    await assignedBtn.click();
    const input = row.locator("input.y-inline-amt");
    await input.fill("5.00");
    await input.press("Enter");

    // Failure toast appears
    await expect(page.getByText("Failed to save assignment. Please try again.")).toBeVisible();
    // Value rolls back to original
    await expect(row.locator(".y-inline-amt").first()).toContainText(originalText!.trim());
  });
});

test.describe("excluded operations", () => {
  test("budget assignment does not emit a success toast", async ({ page }) => {
    // "Home Insurance" has a zero June assignment in the demo seed.
    const row = page.locator("tr[data-cat-row]").filter({ hasText: "Home Insurance" }).first();
    await expect(row).toBeVisible();

    const assignedBtn = row.locator(".y-inline-amt").first();
    await assignedBtn.click();
    const input = row.locator("input.y-inline-amt");
    await input.fill("5.00");
    await input.press("Enter");

    // Wait for the optimistic update to settle, then assert no success toast.
    await expect(row.locator(".y-inline-amt").first()).toContainText("5.00");
    await expect(page.locator(".y-toast").filter({ hasText: /updated|added|created/ })).toHaveCount(0);
  });

  test("status-only bulk update does not emit a success toast", async ({ page }) => {
    await gotoAllTransactions(page);
    const row = page.getByRole("row").filter({ hasText: "SAP Concur" }).first();
    // Select via the row checkbox (a plain row click opens the edit modal).
    await row.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /Mark Cleared/ }).click();

    // The status-only bulk update is excluded from success notifications.
    await expect(page.getByText("Updated 1 transaction.")).toHaveCount(0);
    await expect(page.locator(".y-toast").filter({ hasText: "Updated" })).toHaveCount(0);
  });
});

test.describe("automatic recurring posting", () => {
  test("due scheduled transactions are reported once on reload", async ({
    page,
    request,
  }) => {
    // Reset + first load auto-posts the seed's due recurrings and reports
    // them via the automatic-post toast.
    await resetToDemo();
    await page.goto("/");
    await waitForReady(page);
    await expect(
      page.getByText(/Automatically entered \d+ scheduled transactions?\./)
    ).toBeVisible();
    await expect(
      page.getByText(/Automatically entered \d+ scheduled transactions?\./)
    ).toBeHidden({ timeout: 10_000 });

    // Reloading after they are posted reports nothing new.
    await page.reload();
    await waitForReady(page);
    await expect(
      page.getByText(/Automatically entered \d+ scheduled transactions?\./)
    ).toHaveCount(0);

    // Create a fresh due recurring via the API.
    const budget = await (await request.get("/api/budget")).json();
    const account = budget.accounts.find(
      (a: { name: string }) => a.name === "TD Unlimited Chequing"
    );
    const payee = `PW AutoPost ${Date.now()}`;
    const created = await request.post("/api/recurring", {
      data: {
        accountId: account.id,
        categoryId: null,
        payee,
        amount: -5000,
        frequency: "monthly",
        nextDate: "2026-01-15",
      },
    });
    expect(created.status()).toBe(200);

    // A fresh page load auto-posts the new entry and reports it.
    await page.reload();
    await waitForReady(page);
    await expect(
      page.getByText(/Automatically entered \d+ scheduled transactions?\./)
    ).toBeVisible();

    // The auto-posted transaction is present in the register.
    await gotoAllTransactions(page);
    await expect(page.getByRole("row").filter({ hasText: payee }).first()).toBeVisible();
  });
});
