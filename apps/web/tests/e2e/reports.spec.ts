// apps/web/tests/e2e/reports.spec.ts
//
// Covers ReportsView (packages/ui/src/ReportsView.tsx):
//   - Overview tab shows the math strip (Income / Expenses / Net) and the
//     Top Payees panel (ReportsView.tsx:198-218).
//   - The From / To selectors narrow the range and re-totals
//     (ReportsView.tsx:161-183).
//   - The three chart subpages (Net Worth, Spending by Category,
//     Expense Breakdown) each render their full-screen chart via
//     the matching tab.
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

test("Overview renders the math strip, Top Payees panel, and all chart tabs", async ({ page }) => {
  await expect(page.getByText("Income", { exact: true })).toBeVisible();
  await expect(page.getByText("Expenses", { exact: true })).toBeVisible();
  await expect(page.getByText("Net", { exact: true }).first()).toBeVisible();

  // Top Payees panel only — the three charts moved to tabs.
  await expect(
    page.locator(".y-panel-head").filter({ hasText: "Top Payees" })
  ).toBeVisible();

  for (const tab of ["Net Worth", "Spending by Category", "Expense Breakdown"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
});

test("changing the To selector narrows the range and re-totals Income", async ({ page }) => {
  const incomeCell = page.locator(".y-mathbox").filter({ has: page.getByText("Income", { exact: true }) });
  const fullIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(fullIncome).toBeTruthy();

  // Select is a custom button-based dropdown (not a native <select>); drive it
  // by opening the trigger and clicking the option with the matching data-value.
  const pickMonth = async (label: RegExp, value: string) => {
    await page.getByRole("button", { name: label }).click();
    await page.locator(`.y-dropdown [data-value="${value}"]`).click();
  };
  await pickMonth(/from month/i, "2026-06");
  await pickMonth(/to month/i, "2026-06");

  const narrowIncome = (await incomeCell.locator(".y-math-val").textContent())?.trim();
  expect(narrowIncome).toBeTruthy();
  expect(narrowIncome).not.toBe(fullIncome);
});

test("math strip totals are internally consistent", async ({ page }) => {
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

test("Top Payees lists the six biggest payees with totals", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Top Payees" }).locator("..");
  await expect(panel.getByText("TD Bank")).toBeVisible();
  await expect(panel.getByText("Air Canada")).toBeVisible();
  await expect(panel.locator(".flex.items-center.justify-between")).toHaveCount(6);
  const firstRow = panel.locator(".flex.items-center.justify-between").first();
  await expect(firstRow.getByText("TD Bank")).toBeVisible();
});

test("Spending by Category tab renders the top spender with a percent bar", async ({ page }) => {
  await page.getByRole("button", { name: "Spending by Category", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending by Category" }).locator("..");
  // The seed's top spender is the AMEX Cobalt category.
  await expect(panel.getByText("AMEX Cobalt")).toBeVisible();
  // Percent labels now render without parenthesised percent (e.g. "54%").
  await expect(panel.getByText(/\b\d+%/).first()).toBeVisible();
  await expect(panel.locator(".y-bar-track").first()).toBeVisible();
});

test("Expense Breakdown tab renders the donut and legend", async ({ page }) => {
  await page.getByRole("button", { name: "Expense Breakdown", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Expense Breakdown" }).locator("..");
  await expect(panel.locator("svg")).toBeVisible();
  await expect(panel.getByText("AMEX Cobalt")).toBeVisible();
});

test("Net Worth tab renders the full-screen chart", async ({ page }) => {
  await page.getByRole("button", { name: "Net Worth", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Net Worth" }).locator("..");
  await expect(panel.locator("svg")).toBeVisible();
  // Three months in the default range → bar markers visible.
  await expect(panel.locator("rect").first()).toBeVisible();
});
