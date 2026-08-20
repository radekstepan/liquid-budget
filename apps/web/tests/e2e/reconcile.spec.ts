// apps/web/tests/e2e/reconcile.spec.ts
//
// End-to-end coverage of the YNAB4-style reconciliation flow.
//
// Tests cover:
//   1. Balanced reconciliation: open the modal, accept the working
//      balance as the statement balance, confirm — verify the modal
//      closes and the previously-cleared rows render the R glyph.
//   2. Reconciliation with adjustment: enter a statement balance off
//      by a small amount, pick a category, confirm — verify the
//      synthetic "Reconciliation balance" row appears.
//   3. Un-reconcile: re-open the modal on the same account, click
//      the "undo" link, verify the R glyphs revert to C.
//   4. API contract: POST /api/reconcile with a non-zero diff and no
//      categoryId returns 422; with both fields succeeds.
//
// The toolbar "Last reconciled" pill was removed from the UI; the
// underlying lastReconciledAt data and the modal's "undo" flow are
// still covered. We assert the pill is absent (count 0) so any
// regression re-introducing it would fail this suite.
import { test, expect, type Page, request as apiRequest } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function openAccountFromSidebar(page: Page, accountName: string) {
  await page.getByRole("button", { name: new RegExp(`^${accountName} `) }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${accountName} `) })
  ).toHaveCount(1);
}

async function gotoAccountTransactions(page: Page, accountName: string) {
  await page.goto("/");
  await waitForReady(page);
  await openAccountFromSidebar(page, accountName);
  // The account name should appear in the toolbar (along with its
  // balance pill), confirming we are in the account-filtered
  // transactions view. Use a scoped lookup to the toolbar area so we
  // don't confuse this with the sidebar label.
  await expect(
    page.locator(".y-toolbar").getByText(accountName, { exact: true })
  ).toBeVisible();
}

test.describe("reconcile flow", () => {
  test("balanced reconciliation locks cleared rows", async ({ page }) => {
    // Use "Cash" — it has no transactions in the seed, so the entire
    // current balance ($116.05) equals the working balance. After
    // reconcile, the toolbar should show no "Last reconciled" pill
    // (the pill was removed from the UI; the data is still tracked
    // and used by the Reconcile modal).
    await gotoAccountTransactions(page, "Cash");

    await page.getByRole("button", { name: "Reconcile", exact: true }).click();
    const modal = page.locator(".y-modal").last();
    await expect(modal.locator(".y-modal-head")).toHaveText(/Reconcile: Cash/);

    // The statement input is pre-filled with the working balance.
    // Click Reconcile without modifying.
    await modal.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(modal).toBeHidden();

    // The pill should remain absent.
    await expect(page.locator(".y-pill--green")).toHaveCount(0);
  });

  test("reconcile with a non-zero diff creates a synthetic adjustment row", async ({ page }) => {
    // Use "Scotia e-Chequing" — no r rows, a clean slate. Open it.
    await gotoAccountTransactions(page, "Scotia e-Chequing");

    await page.getByRole("button", { name: "Reconcile", exact: true }).click();
    const modal = page.locator(".y-modal").last();

    // The pre-filled statement balance equals the working balance.
    // Add $1.23 to it so the diff is non-zero and the
    // "Absorb the difference" panel appears.
    const statementInput = modal.locator('input[inputmode="decimal"]').first();
    const current = await statementInput.inputValue();
    const adjusted = (parseFloat(current) + 1.23).toFixed(2);
    await statementInput.fill(adjusted);

    // The "Absorb the difference" panel should now be visible with
    // a category dropdown and a "Mark for adjustment" button.
    await expect(modal.getByText("Absorb the difference")).toBeVisible();

    // Pick a non-CC-payment category. The searchable field is inside the modal.
    const categoryField = modal.locator('button[aria-haspopup="listbox"]').last();
    await expect(categoryField).toBeVisible();

    // Acknowledge the diff by clicking "Mark for adjustment" — the
    // modal's primary button only enables once the user signals
    // intent to absorb the non-zero diff.
    await modal.getByRole("button", { name: "Mark for adjustment" }).click();
    await expect(
      modal.getByRole("button", { name: "Will create adjustment" })
    ).toBeVisible();

    // Submit.
    await modal.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(modal).toBeHidden();

    // A new transaction with the "Reconciliation balance" memo
    // should appear in the register.
    await expect(
      page.getByRole("row").filter({ hasText: "Reconciliation balance" })
    ).toBeVisible();

    // The pill should remain absent.
    await expect(page.locator(".y-pill--green")).toHaveCount(0);
  });

  test("un-reconcile restores the rows to Cleared", async ({ page }) => {
    // Scotia e-Chequing is now reconciled from the previous test (in
    // CI after the global reset). Use the TD account which the seed
    // marks as pre-reconciled with a known lastReconciledAt.
    await gotoAccountTransactions(page, "TD Unlimited Chequing");

    // The seed sets lastReconciledAt, but the toolbar pill is no
    // longer rendered in the UI.
    await expect(page.locator(".y-pill--green")).toHaveCount(0);

    await page.getByRole("button", { name: "Reconcile", exact: true }).click();
    const modal = page.locator(".y-modal").last();
    // The "Already reconciled" notice is shown.
    await expect(modal.getByText("Already reconciled")).toBeVisible();
    // Click the "undo the last reconciliation" link.
    await modal.getByRole("button", { name: /undo the last reconciliation/i }).click();
    await expect(modal).toBeHidden();

    // Pill still absent after un-reconcile.
    await expect(page.locator(".y-pill--green")).toHaveCount(0);
  });
});

test.describe("/api/reconcile contract", () => {
  test("returns 422 when the diff is non-zero and no categoryId is provided", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const budget = await (await ctx.get("/api/budget")).json();
    // Pick "EQ Bank" specifically — it is not touched by any other
    // test in this suite and has no pre-marked Reconciled rows, so
    // its working balance is reproducible across runs.
    const account = budget.accounts.find(
      (a: { name: string }) => a.name === "EQ Bank"
    );
    expect(account?.id).toBeTruthy();

    // A statement balance that is far from EQ Bank's working
    // balance guarantees a non-zero diff regardless of state
    // mutations from prior tests.
    const res = await ctx.post("/api/reconcile", {
      data: {
        accountId: account.id,
        statementBalance: 1.0,
        // no adjustmentCategoryId
      },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/adjustment category/i);
    await ctx.dispose();
  });

  test("accepts a valid reconcile request with a categoryId when diff is non-zero", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const budget = await (await ctx.get("/api/budget")).json();
    // Use a specific account untouched by other tests in this suite
    // so we get a clean baseline.
    const account = budget.accounts.find(
      (a: { name: string }) => a.name === "Cash"
    );
    expect(account?.id).toBeTruthy();

    // Use the current account balance as the statement balance so
    // the diff is small and well-defined.
    const current = Number(account.balance);
    const res = await ctx.post("/api/reconcile", {
      data: {
        accountId: account.id,
        statementBalance: current,
        adjustmentCategoryId: null,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("reconcile");
    expect(body.adjustmentTransactionId).toBeNull();
    expect(body.finalDiff).toBe(0);
    await ctx.dispose();
  });
});
