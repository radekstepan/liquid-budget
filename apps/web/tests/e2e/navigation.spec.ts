// apps/web/tests/e2e/navigation.spec.ts
//
// Covers the sidebar nav and the
// account → transactions deep-link. Each view exposes a toolbar with a title
// (e.g. "Reports") or a MonthNav, so we assert on those
// as mount signals.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

const NAV_ITEMS: { label: string; viewToolbar: string | RegExp; match?: string | RegExp }[] = [
  { label: "Budget", viewToolbar: /Master Category/ },
  { label: "Reports", viewToolbar: "Reports" },
  // The Transactions button's accessible name includes its running balance
  // (Sidebar.tsx y-side-amt), so it needs a regex match.
  { label: "Transactions", match: /^Transactions/, viewToolbar: "All Transactions" },
];

for (const { label, match, viewToolbar } of NAV_ITEMS) {
  test(`navigates to ${label} view via sidebar`, async ({ page }) => {
    await page
      .getByRole("button", { name: match ?? label, exact: match ? false : true })
      .click();
    // BudgetView shows the "Master Category" button in its toolbar
    // (BudgetView.tsx:138-140). Every other view puts a plain text
    // title in the toolbar (e.g. ReportsView.tsx:140).
    if (viewToolbar instanceof RegExp) {
      await expect(page.getByRole("button", { name: viewToolbar })).toBeVisible();
    } else {
      await expect(page.getByText(viewToolbar, { exact: true }).first()).toBeVisible();
    }
  });
}

test("clicking a sidebar account deep-links to its transaction filter", async ({ page }) => {
  // Sidebar lists the first on-budget account as a button (Sidebar.tsx:118-127).
  // TD Unlimited Chequing is the first one in the seed (seed.ts:114).
  const accountBtn = page.getByRole("button", { name: /TD Unlimited Chequing/ });
  await accountBtn.first().click();

  // The TransactionsView toolbar swaps its title from "All Transactions"
  // to the account name when filtered (TransactionsView.tsx:78-82). The
  // sidebar "Transactions" nav keeps the view on transactions — so we
  // target the toolbar title (a <span> with the bold class).
  const toolbarTitle = page.locator(".y-toolbar span.text-\\[13px\\]").first();
  await expect(toolbarTitle).toHaveText("TD Unlimited Chequing");
});
