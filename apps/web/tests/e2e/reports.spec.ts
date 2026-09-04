// apps/web/tests/e2e/reports.spec.ts
//
// Covers ReportsView (packages/ui/src/ReportsView.tsx):
//   - Spending Trends is the default tab; only the three tabs
//     (Spending Trends, Spending by Category, Net Worth) exist.
//   - The From / To selectors narrow the range and re-total.
//   - The chart subpages (Net Worth, Spending by Category) each render
//     their full-screen chart via the matching tab.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText("Reports", { exact: true }).first()).toBeVisible();
});

test("Spending Trends is the default tab and only three tabs exist", async ({ page }) => {
  // Spending Trends renders by default without clicking any tab.
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");
  await expect(panel.locator("svg.overflow-visible")).toBeVisible();

  for (const tab of ["Net Worth", "Spending Trends", "Spending by Category"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
});

test("changing the selectors narrows the range and re-totals Spending Trends", async ({ page }) => {
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");
  const totalValue = panel.locator("span").filter({ hasText: /^Total:/ }).locator(".y-num");
  const fullTotal = (await totalValue.textContent())?.trim();
  expect(fullTotal).toBeTruthy();

  // Select is a custom button-based dropdown (not a native <select>); drive it
  // by opening the trigger and clicking the option with the matching data-value.
  const pickMonth = async (label: RegExp, value: string) => {
    await page.getByRole("button", { name: label }).click();
    await page.locator(`.y-dropdown [data-value="${value}"]`).click();
  };
  await pickMonth(/from month/i, "5");
  await pickMonth(/to month/i, "5");

  const narrowTotal = (await totalValue.textContent())?.trim();
  expect(narrowTotal).toBeTruthy();
  expect(narrowTotal).not.toBe(fullTotal);
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
  await expect(panel.locator("svg").first()).toBeVisible();
  // Three months in the default range → bar markers visible.
  await expect(panel.locator("rect").first()).toBeVisible();

  // Scale toggle
  const linearBtn = panel.getByRole("button", { name: "Linear", exact: true });
  const logBtn = panel.getByRole("button", { name: "Log", exact: true });
  await expect(linearBtn).toBeVisible();
  await expect(logBtn).toBeVisible();

  // Switch to Log scale
  await logBtn.click();
  await expect(panel.locator("svg").first()).toBeVisible();
  await expect(panel.locator("rect").first()).toBeVisible();

  // Switch back to Linear scale
  await linearBtn.click();
  await expect(panel.locator("svg").first()).toBeVisible();
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
  // At the group drill level the constituent table shows subcategory rows
  await expect(constituentsTable.locator("tbody tr.y-row").first()).toBeVisible();

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
  await expect(constituentsTable.locator("tbody tr.y-row").first()).toBeVisible();

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

test("clicking Reports in sidebar when drilled down in Spending Trends resets back to root All Categories", async ({ page }) => {
  await page.getByRole("button", { name: "Spending Trends", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");

  // Top level constituents list is visible
  const constituentsTable = panel.locator(".bg-white");
  await expect(constituentsTable.getByText("Master Category")).toBeVisible();

  // Drill down into a master category
  const firstGroupRow = constituentsTable.locator(".cursor-pointer").first();
  await firstGroupRow.click();

  // Drill down into a constituent subcategory
  const firstCatRow = constituentsTable.locator(".cursor-pointer").first();
  await firstCatRow.click();

  // Subcategory level shows transactions register table
  await expect(panel.locator("table.y-table")).toBeVisible();

  // Click "Reports" in the sidebar
  await page.getByRole("button", { name: "Reports", exact: true }).click();

  // Should now be back at root All Categories with Master Category table
  await expect(constituentsTable.getByText("Master Category")).toBeVisible();
});

test("clicking a transaction in Spending Trends category view navigates to relevant account and checks the transaction", async ({ page }) => {
  await page.getByRole("button", { name: "Spending Trends", exact: true }).click();
  const panel = page.locator(".y-panel-head").filter({ hasText: "Spending Trends" }).locator("..");

  // Drill down: Master Category -> Category
  const constituentsTable = panel.locator(".bg-white");
  const firstGroupRow = constituentsTable.locator(".cursor-pointer").first();
  await firstGroupRow.click();

  const firstCatRow = constituentsTable.locator(".cursor-pointer").first();
  await firstCatRow.click();

  // Transactions list is visible
  const txnRow = panel.locator("table.y-table tbody tr.y-row").first();
  await expect(txnRow).toBeVisible();

  // Click transaction row
  await txnRow.click();

  // Should navigate to Transactions view
  await expect(page.locator("main .y-toolbar")).toBeVisible();
  await expect(page.getByText("1 selected")).toBeVisible();

  // The focused transaction row is checked
  const checkedCheckbox = page.locator("main table.y-table tbody tr input[type='checkbox']:checked");
  await expect(checkedCheckbox).toHaveCount(1);
});


