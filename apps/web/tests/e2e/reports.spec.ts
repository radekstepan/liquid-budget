// apps/web/tests/e2e/reports.spec.ts
//
// Covers ReportsView (packages/ui/src/ReportsView.tsx):
//   - Overview tab shows the math strip (Income / Expenses / Net) and the
//     Top Payees panel (ReportsView.tsx:198-218).
//   - The From / To selectors narrow the range and re-totals
//     (ReportsView.tsx:161-183).
//   - The chart subpages (Net Worth, Spending by Category) each render
//     their full-screen chart via the matching tab.
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

  // Top Payees panel only — the charts moved to tabs.
  await expect(
    page.locator(".y-panel-head").filter({ hasText: "Top Payees" })
  ).toBeVisible();

  for (const tab of ["Net Worth", "Spending Trends", "Spending by Category"]) {
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
  await pickMonth(/from month/i, "5");
  await pickMonth(/to month/i, "5");

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

test("Spending by Category tab renders the top spender with a percent bar and toggles Bars/Donut view", async ({ page }) => {
  await page.getByRole("button", { name: "Spending by Category", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending by Category" }).locator("..");
  // The seed's top spender category is Mortgage Interest.
  await expect(panel.getByText("Mortgage Interest")).toBeVisible();
  // Percent labels now render without parenthesised percent (e.g. "54%").
  await expect(panel.getByText(/\b\d+%/).first()).toBeVisible();
  await expect(panel.locator(".y-bar-track").first()).toBeVisible();

  // Toggle buttons
  const barsBtn = panel.getByRole("button", { name: "Bars", exact: true });
  const donutBtn = panel.getByRole("button", { name: "Donut", exact: true });
  await expect(barsBtn).toBeVisible();
  await expect(donutBtn).toBeVisible();

  // Switch to Donut view
  await donutBtn.click();
  await expect(panel.locator("svg")).toBeVisible();
  await expect(panel.getByText("TOTAL", { exact: true })).toBeVisible();
  await expect(panel.getByText("Mortgage Interest")).toBeVisible();

  // Switch back to Bars view
  await barsBtn.click();
  await expect(panel.locator(".y-bar-track").first()).toBeVisible();
});

test("Net Worth tab renders the full-screen chart and toggles Linear/Log scale", async ({ page }) => {
  await page.getByRole("button", { name: "Net Worth", exact: true }).click();
  const panel = page.locator("main .y-panel-head").filter({ hasText: "Net Worth" }).locator("..");
  await expect(panel.locator("svg")).toBeVisible();
  // Three months in the default range → bar markers visible.
  await expect(panel.locator("rect").first()).toBeVisible();

  // Scale toggle
  const linearBtn = panel.getByRole("button", { name: "Linear", exact: true });
  const logBtn = panel.getByRole("button", { name: "Log", exact: true });
  await expect(linearBtn).toBeVisible();
  await expect(logBtn).toBeVisible();

  // Switch to Log scale
  await logBtn.click();
  await expect(panel.locator("svg")).toBeVisible();
  await expect(panel.locator("rect").first()).toBeVisible();

  // Switch back to Linear scale
  await linearBtn.click();
  await expect(panel.locator("svg")).toBeVisible();
});

test("Spending Trends tab renders stacked multi-month chart and supports multi-level drill-down", async ({ page }) => {
  await page.getByRole("button", { name: "Spending Trends", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");

  // SVG chart with stacked bars and X axis labels
  await expect(panel.locator("svg.overflow-visible")).toBeVisible();
  await expect(panel.locator("g rect").first()).toBeVisible();

  // Breadcrumb at top level
  await expect(panel.getByRole("button", { name: "All Categories" })).toBeVisible();

  // Category filter trigger is visible
  await expect(panel.getByTitle("Filter included categories")).toBeVisible();

  // Top level constituents list is visible
  const constituentsTable = panel.locator(".bg-white");
  await expect(constituentsTable.getByText("Master Category")).toBeVisible();

  // Drill down into a master category (e.g. first available category group row in table)
  const firstGroupRow = constituentsTable.locator(".cursor-pointer").first();
  const groupName = (await firstGroupRow.locator(".truncate.font-medium").textContent())?.trim();
  expect(groupName).toBeTruthy();
  await firstGroupRow.click();

  // Breadcrumb now shows All Categories > Group Name
  await expect(panel.getByRole("button", { name: groupName! })).toBeVisible();
  await expect(panel.getByRole("button", { name: "↑ Up" })).toBeVisible();
  await expect(constituentsTable.getByText("Subcategory")).toBeVisible();

  // Drill down into a constituent subcategory
  const firstCatRow = constituentsTable.locator(".cursor-pointer").first();
  const catName = (await firstCatRow.locator(".truncate.font-medium").textContent())?.trim();
  expect(catName).toBeTruthy();
  await firstCatRow.click();

  // Subcategory level shows transaction register table with standard y-table and y-row styling
  await expect(panel.getByText(`${catName} Transactions`)).toBeVisible();
  await expect(panel.locator("table.y-table")).toBeVisible();
  await expect(panel.locator("thead.y-thead")).toBeVisible();
  await expect(panel.locator("tbody tr.y-row").first()).toBeVisible();

  // Navigate back to master category using Up button
  await panel.getByRole("button", { name: "↑ Up" }).click();
  await expect(panel.getByRole("button", { name: groupName! })).toBeVisible();
  await expect(constituentsTable.getByText("Subcategory")).toBeVisible();

  // Open contextual category filter for this group
  const filterBtn = panel.getByTitle("Filter included categories");
  await filterBtn.click();
  await expect(panel.getByText(`Filter: ${groupName}`)).toBeVisible();
  // Close filter
  await filterBtn.click();

  // Navigate back to All Categories using breadcrumb
  await panel.getByRole("button", { name: "All Categories" }).click();
  await expect(constituentsTable.getByText("Master Category")).toBeVisible();
});

test("Spending Trends handles wide multi-year range with readable X-axis stride", async ({ page }) => {
  await page.getByRole("button", { name: "Spending Trends", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");

  // Change From year to an earlier year (e.g. 2016)
  await page.getByRole("button", { name: /from year/i }).click();
  const earliestYearOption = page.locator('.y-dropdown [role="option"]').first();
  await earliestYearOption.click();

  // Ensure SVG chart renders with readable axis labels (fewer than 15 labels across the chart)
  const chartSvg = panel.locator("svg.overflow-visible");
  await expect(chartSvg).toBeVisible();

  const labels = chartSvg.locator("text.y-num");
  const count = await labels.count();
  // Y-axis ticks (~5) + X-axis labels (~6-10) should not exceed 25 total text elements
  expect(count).toBeLessThan(25);
});
