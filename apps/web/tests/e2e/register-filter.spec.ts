// apps/web/tests/e2e/register-filter.spec.ts
//
// E2E coverage for the register search/filter wiring that unit tests cannot
// reach: the round trips between TransactionsView's filter bar, BudgetApp's
// owner state (registerFilter/searchInitialQuery), and GlobalSearchModal.
//
// Unit coverage this complements (not duplicates):
//   - packages/logic/tests/searchQuery.test.ts — parsing/matching/suggestions
//   - packages/ui/src/GlobalSearchModal.test.tsx — modal in isolation with
//     mocked onJump/onClose (callback args only, never the register result)
//
// What IS covered here: edit-from-bar round trip, per-chip removal, applied
// filter persistence across navigation, the no-match empty state, payee and
// transaction jumps landing in the register, and the global Cmd+K entry point.
import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist, filterRegisterByText } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

/** Top-level register rows (excludes the scheduled section). */
function registerRows(page: Page) {
  return page.locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row");
}

async function createTransaction(page: Page, payee: string) {
  await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
  const modal = page.locator(".y-modal").last();
  await modal.locator('input[inputmode="decimal"]').first().fill("5.00");
  await modal.locator('input[type="date"]').first().fill("2026-06-15");
  await fillSearchlist(modal, "e.g. Whole Foods", payee);
  await modal.getByRole("button", { name: "Save Transaction" }).click();
  await expect(modal).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("editing the applied filter from the register bar round-trips through the modal", async ({
  page,
}) => {
  // The bar's Edit button must open the modal pre-filled with the applied
  // query (via BudgetApp searchInitialQuery), and re-applying must replace
  // the owner's filter — unit tests cover pre-fill rendering and the jump
  // callback separately, never this round trip.
  const stampA = `PW EditA ${Date.now()}`;
  const stampB = `PW EditB ${Date.now()}`;
  await createTransaction(page, stampA);
  await createTransaction(page, stampB);
  const rows = registerRows(page);

  await filterRegisterByText(page, stampA);
  await expect(rows).toHaveCount(1);

  const bar = page.getByTestId("register-filter-bar");
  await bar.getByRole("button", { name: "Edit search text filter" }).click();
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  const input = page.getByTestId("global-search-input");
  // Pre-filled from the owner's applied query, not a fresh search.
  await expect(input).toHaveValue(stampA);

  await input.fill(stampB);
  await page.getByRole("button", { name: "Show in register" }).click();
  await expect(modal).toBeHidden();
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Edit search text filter" })).toContainText(
    stampB
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(stampB);
});

test("removing one chip widens results; removing the last clears the filter without resurrection", async ({
  page,
}) => {
  // Per-chip removal lives entirely in TransactionsView's bar (no unit
  // tests), and last-chip removal must notify the owner — otherwise the
  // filter resurrects on remount (the register-filter-clear regression).
  const uniquePayee = `PW Chip ${Date.now()}`;
  await createTransaction(page, uniquePayee);
  const rows = registerRows(page);

  // Apply a two-part query: an is:cleared chip plus free text.
  await page.getByRole("button", { name: "Filter transactions" }).click();
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  const input = page.getByTestId("global-search-input");
  await input.fill("is:cleared");
  await input.press("Enter");
  await expect(page.getByText("Matching transactions")).toBeVisible();
  await input.fill(uniquePayee);
  await page.getByRole("button", { name: "Show in register" }).click();
  await expect(modal).toBeHidden();

  const bar = page.getByTestId("register-filter-bar");
  await expect(bar).toBeVisible();
  const removeIs = bar.getByRole("button", { name: "Remove Is filter" });
  const removeText = bar.getByRole("button", { name: "Remove search text filter" });
  await expect(removeIs).toBeVisible();
  await expect(removeText).toBeVisible();
  await expect(rows).toHaveCount(1);

  // Removing the text chip widens to all cleared rows; the Is chip stays.
  await removeText.click();
  await expect(removeText).toBeHidden();
  await expect(removeIs).toBeVisible();
  await expect.poll(async () => rows.count()).toBeGreaterThan(1);

  // Removing the last chip clears everything, including the owner's copy:
  // navigating away and back must not resurrect the bar.
  await removeIs.click();
  await expect(bar).toBeHidden();
  await expect(page.getByRole("button", { name: "Filter transactions" })).toBeVisible();

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();
  await gotoAllTransactions(page);
  await expect(bar).toBeHidden();
  await expect(page.getByRole("button", { name: "Filter transactions" })).toBeVisible();
});

test("applied filter persists across view navigation", async ({ page }) => {
  // Complement of register-filter-clear: a still-applied filter must survive
  // the register remount (owner registerFilter re-applies via nonce effect).
  const uniquePayee = `PW Persist ${Date.now()}`;
  await createTransaction(page, uniquePayee);
  const rows = registerRows(page);

  await filterRegisterByText(page, uniquePayee);
  await expect(rows).toHaveCount(1);

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();

  await gotoAllTransactions(page);
  const bar = page.getByTestId("register-filter-bar");
  await expect(bar).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(uniquePayee);
});

test("filter with no matches shows the empty state and Clear search restores rows", async ({
  page,
}) => {
  const rows = registerRows(page);
  const totalBefore = await rows.count();
  expect(totalBefore).toBeGreaterThan(0);

  await filterRegisterByText(page, `zzz-no-such-payee-${Date.now()}`);
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("No transactions match your search")).toBeVisible();

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByTestId("register-filter-bar")).toBeHidden();
  await expect(rows).toHaveCount(totalBefore);
});

test("picking a payee suggestion jumps to a payee-filtered register", async ({
  page,
}) => {
  // Unit tests assert the modal fires onJump({ kind: "payee" }); only e2e
  // can show the register actually filters and renders the Payee chip.
  const uniquePayee = `PW PayeeJump ${Date.now()}`;
  await createTransaction(page, uniquePayee);
  const rows = registerRows(page);

  await page.getByRole("button", { name: "Filter transactions" }).click();
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  // Full payee name in payee: context mode offers the exact-match suggestion.
  await page.getByTestId("global-search-input").fill(`payee:${uniquePayee}`);
  const suggestion = modal.getByRole("option", { name: uniquePayee });
  await expect(suggestion.first()).toBeVisible();
  await suggestion.first().click();

  await expect(modal).toBeHidden();
  const bar = page.getByTestId("register-filter-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Edit Payee filter" })).toContainText(
    uniquePayee
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(uniquePayee);
});

test("clicking a transaction result focuses its row and switches account", async ({
  page,
}) => {
  // The transaction jump switches accountFilter, pushes /transactions/:id,
  // clears any stale filter, and selects + scrolls to the row — all owner
  // wiring (BudgetApp + TransactionsView focus effect) with no unit tests.
  const uniquePayee = `PW TxJump ${Date.now()}`;
  await createTransaction(page, uniquePayee);

  await page.getByRole("button", { name: "Filter transactions" }).click();
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("global-search-input").fill(uniquePayee);
  // The tx row carries both payee and date; the "Search everything" and
  // payee suggestion options do not carry the date.
  const txOption = modal
    .getByRole("option")
    .filter({ hasText: uniquePayee })
    .filter({ hasText: "2026-06-15" });
  await expect(txOption).toHaveCount(1);
  await txOption.click();

  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(/\/transactions\/\d+/);
  // Jumped-to account, not All Transactions; no stale filter bar.
  await expect(page.getByTestId("register-filter-bar")).toBeHidden();
  const selected = page
    .locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row.is-sel")
    .filter({ hasText: uniquePayee });
  await expect(selected).toBeVisible();
});

test("Cmd+K opens a fresh search from the Budget view and applies to the register", async ({
  page,
}) => {
  // The global keyboard listener lives in BudgetApp (untested in units):
  // Cmd+K must open a fresh modal (no resumed edit session) from any view,
  // and applying must land in the filtered register.
  const uniquePayee = `PW CmdK ${Date.now()}`;
  await createTransaction(page, uniquePayee);

  await page.getByRole("button", { name: "Budget", exact: true }).click();
  await expect(page.getByTestId("month-nav-picker")).toBeVisible();

  await page.keyboard.press("Meta+k");
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("global-search-input")).toHaveValue("");

  await page.getByTestId("global-search-input").fill(uniquePayee);
  await page.getByRole("button", { name: "Show in register" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("register-filter-bar")).toBeVisible();
  const rows = registerRows(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(uniquePayee);
});
