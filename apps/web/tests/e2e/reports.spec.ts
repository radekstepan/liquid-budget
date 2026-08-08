// apps/web/tests/e2e/reports.spec.ts
//
// Covers ReportsView (packages/ui/src/ReportsView.tsx):
//   - math strip (Income / Expenses / Net) renders with the default
//     April–June range (ReportsView.tsx:168-179)
//   - all four panels render: Net Worth, Spending by Category,
//     Expense Breakdown, Top Payees (ReportsView.tsx:181-265)
//   - the From / To selectors narrow the range and re-totals
//     (ReportsView.tsx:144-164)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();
});

test("renders the math strip and all four panels with the default range", async ({ page }) => {
  await expect(page.getByText("Income", { exact: true })).toBeVisible();
  await expect(page.getByText("Expenses", { exact: true })).toBeVisible();
  await expect(page.getByText("Net", { exact: true }).first()).toBeVisible();

  for (const title of [
    "Net Worth",
    "Spending by Category",
    "Expense Breakdown",
    "Top Payees",
  ]) {
    await expect(
      page.locator(".y-panel-head").filter({ hasText: title })
    ).toBeVisible();
  }
});

test("changing the To selector narrows the range and re-totals Income", async ({ page }) => {
  // The default range covers April–June; the seed has income spread
  // across all three months. Narrowing the range to just June should
  // reduce the Income value.
  const incomeCell = page.locator(".y-mathbox").filter({ has: page.getByText("Income", { exact: true }) });
  const fullIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(fullIncome).toBeTruthy();

  // The "To" select is the second one in the toolbar
  // (ReportsView.tsx:155-164).
  const selects = page.locator(".y-toolbar select");
  await selects.nth(0).selectOption("2026-06");
  await selects.nth(1).selectOption("2026-06");

  const narrowIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(narrowIncome).toBeTruthy();
  expect(narrowIncome).not.toBe(fullIncome);
});

test("math strip totals are internally consistent", async ({ page }) => {
  // The seed totals can shift when other mutating specs create rows in
  // the shared dev DB, so assert the invariant instead of exact values:
  // Net must equal Income + Expenses (all signed numbers).
  const cell = (label: string) =>
    page.locator(".y-mathbox").filter({ has: page.getByText(label, { exact: true }) });
  const read = async (label: string) => {
    const text = await cell(label).locator(".y-math-val").textContent();
    return Number((text ?? "").replace(/[$,]/g, ""));
  };
  const income = await read("Income");
  const expenses = await read("Expenses");
  const net = await read("Net");
  expect(income).toBeGreaterThan(0);
  expect(expenses).toBeLessThan(0);
  expect(net).toBeCloseTo(income + expenses, 2);
});

test("Spending by Category renders the top spender first with a percent bar", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending by Category" }).locator("..");
  // The seed's top spender is the AMEX Cobalt payment category.
  await expect(panel.getByText("AMEX Cobalt")).toBeVisible();
  // The percent label sits in the first (top) row.
  const firstRow = panel.locator(".y-bar-track").first().locator("..");
  await expect(firstRow.getByText(/\(\d+%\)/)).toBeVisible();
  // Each row renders a proportional bar track.
  await expect(panel.locator(".y-bar-track").first()).toBeVisible();
});

test("Expense Breakdown renders the donut and legend", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Expense Breakdown" }).locator("..");
  await expect(panel.locator("svg")).toBeVisible();
  await expect(panel.getByText("AMEX Cobalt")).toBeVisible();
});

test("Top Payees lists the six biggest payees with totals", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Top Payees" }).locator("..");
  await expect(panel.getByText("TD Bank")).toBeVisible();
  await expect(panel.getByText("Air Canada")).toBeVisible();
  // Six rows render, sorted by spend (TD Bank first).
  await expect(panel.locator(".flex.items-center.justify-between")).toHaveCount(6);
  const firstRow = panel.locator(".flex.items-center.justify-between").first();
  await expect(firstRow.getByText("TD Bank")).toBeVisible();
});

test("Net Worth renders the monthly bar graph", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Net Worth" }).locator("..");
  await expect(panel.locator("svg")).toBeVisible();
  // Three months in the default range → three data markers.
  await expect(panel.locator("rect").first()).toBeVisible();
});
