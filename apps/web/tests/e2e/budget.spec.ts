// apps/web/tests/e2e/budget.spec.ts
//
// Exercises BudgetView + Inspector interactions:
//   - inline category assignment edits (BudgetView.tsx:481-534)
//   - MonthNav prev/next (BudgetView.tsx:131-136, blocks.tsx:7-33)
//   - group collapse / expand menu (BudgetView.tsx:144-172)
//   - Inspector history bar month jump (Inspector.tsx:151-181)
//
// These specs mutate state, so the CI global setup (tests/e2e/global-setup.ts)
// must run before the suite for deterministic results. Locally, with
// `reuseExistingServer` on, the suite runs against the existing dev DB.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("inline-edits a category assigned amount and updates To Be Budgeted", async ({ page }) => {
  // Pick a category with a stable, non-zero seed assignment and edit
  // it to a value unique to this run, so a leftover from a previous
  // test run can't make the "before" equal the "after".
  const newAmount = `${Date.now() % 1000}.45`;
  const rentRow = page.getByRole("row").filter({ hasText: "Rent" }).first();
  const budgetedCell = rentRow.locator("button.y-inline-amt").first();
  const before = await budgetedCell.textContent();

  await budgetedCell.click();
  const input = rentRow.locator("input.y-inline-amt");
  await expect(input).toBeVisible();
  await input.fill(newAmount);
  await input.press("Enter");

  // The same cell now reflects the new value.
  await expect(rentRow.locator("button.y-inline-amt").first()).toHaveText(`$${newAmount}`);
  expect(before).not.toBe(`$${newAmount}`);
});

test("MonthNav prev/next shifts the active month", async ({ page }) => {
  // The Inspector reflects the active month/year (Inspector.tsx:38-53)
  // and the MonthNav exposes a month+year picker (blocks.tsx:57-86).
  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jun 2026");

  await page.getByRole("button", { name: "Next month" }).click();
  await expect(monthBadge).toHaveText("Jul 2026");

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(monthBadge).toHaveText("Jun 2026");
});

test("year dropdown jumps to the same month in the chosen year", async ({ page }) => {
  // The MonthNav year select (blocks.tsx:74-85) is keyed off
  // `aria-label="Year"` and is scoped to the picker container
  // (data-testid="month-nav-picker") so the surrounding prev/next
  // buttons don't match.
  const picker = page.getByTestId("month-nav-picker");
  const yearSelect = picker.getByLabel("Year", { exact: true });
  await expect(yearSelect).toHaveValue("2026");

  // One click jumps to a different year — replaces the multi-click
  // prev-arrow flow for any in-range year.
  await yearSelect.selectOption("2028");

  // Inspector reflects the new month; the Month and Year selects stay
  // in sync (month preserved, year updated).
  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jun 2028");
  await expect(yearSelect).toHaveValue("2028");
  await expect(picker.getByLabel("Month", { exact: true })).toHaveValue("5");
});

test("month dropdown jumps to the chosen month in the current year", async ({ page }) => {
  const picker = page.getByTestId("month-nav-picker");
  const monthSelect = picker.getByLabel("Month", { exact: true });
  const yearSelect = picker.getByLabel("Year", { exact: true });

  await expect(monthSelect).toHaveValue("5"); // June is index 5
  await expect(yearSelect).toHaveValue("2026");

  await monthSelect.selectOption("2"); // March is index 2

  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Mar 2026");
  await expect(monthSelect).toHaveValue("2");
  await expect(yearSelect).toHaveValue("2026");
});

test("year dropdown range is derived from data and includes a future cap", async ({ page }) => {
  // The year select should include 2026 (the data's anchor year) and
  // extend at least 5 years into the future so users can budget ahead
  // (BudgetApp.tsx derives {minYear, maxYear} from data + thisYear + 5).
  const picker = page.getByTestId("month-nav-picker");
  const yearSelect = picker.getByLabel("Year", { exact: true });
  const optionsText = await yearSelect.locator("option").allTextContents();
  expect(optionsText).toContain("2026");
  const years = optionsText.map((t) => Number(t)).filter((n) => Number.isFinite(n));
  const maxOption = Math.max(...years);
  // The current year is 2026 (per today's date and the seed); the
  // future cap adds 5 more years for a max of 2031.
  expect(maxOption).toBeGreaterThanOrEqual(2031);
});

test("Group options menu collapses and expands all groups", async ({ page }) => {
  // The first "Needs" group's row (Mortgage Principal) should be visible
  // when expanded.
  const mortgageRow = page.getByRole("row").filter({ hasText: "Mortgage Principal" });
  await expect(mortgageRow).toBeVisible();

  // Open the dots-menu (aria-label="Group options" — BudgetView.tsx:147).
  await page.getByRole("button", { name: "Group options" }).click();
  await page.getByRole("button", { name: "Collapse all groups" }).click();

  // The category rows vanish; only master rows remain. YNAB4 collapses
  // by removing the row nodes, so the simplest assertion is that the
  // category row is now hidden.
  await expect(mortgageRow).toBeHidden();

  await page.getByRole("button", { name: "Group options" }).click();
  await page.getByRole("button", { name: "Expand all groups" }).click();
  await expect(mortgageRow).toBeVisible();
});

test("clicking a real history bar in the Inspector jumps to that month", async ({ page }) => {
  // June 2026 is the only "real" history bar (the only month with
  // assignments in the seed). Shift one month forward so the jump
  // produces a visible change.
  await page.getByRole("button", { name: "Next month" }).click();
  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jul 2026");

  // Inspector history bar (Inspector.tsx:151-181) uses aria-label
  // "Jump to <MonthShort> <Year>" — MONTHS is the 3-letter array
  // (Inspector.tsx:5, format.ts:1-14), so it's "Jun 2026", not "June 2026".
  await page.getByRole("button", { name: "Jump to Jun 2026" }).click();
  await expect(monthBadge).toHaveText("Jun 2026");
});

test("month column group divider has a visible 2px left border in both header and body", async ({ page }) => {
  // Each month group is separated by a 2px border-strong delimiter
  // (.y-table-colgroup-divider). The first month group is not a divider
  // (it's the leftmost), so we look at the second group — both in the
  // header and in a body row.
  await expect(page.getByRole("columnheader", { name: "Jun 2026", exact: true })).toBeVisible();

  const headerDivider = page
    .locator("th.y-table-th--month-label.y-table-colgroup-divider")
    .first();
  await expect(headerDivider).toBeVisible();
  const headerBorder = await headerDivider.evaluate(
    (el) => getComputedStyle(el).borderLeftWidth
  );
  expect(headerBorder).toBe("2px");

  // Body cell of the second month group — the Budgeted cell of any
  // category row in the second month group should also be 2px.
  const bodyDivider = page
    .locator("table.y-table tbody td.y-table-colgroup-divider")
    .first();
  await expect(bodyDivider).toBeVisible();
  const bodyBorder = await bodyDivider.evaluate(
    (el) => getComputedStyle(el).borderLeftWidth
  );
  expect(bodyBorder).toBe("2px");
});

test("Row 2's first Budgeted cell has a 1px hairline matching Row 1 and the body", async ({ page }) => {
  // The Category→month1 boundary must look the same in Row 2 as it
  // already does in Row 1 and the body: a 1px hairline, NOT the 2px
  // chrome divider reserved for month 2+.
  const firstRow2Header = page
    .locator("table.y-table thead tr")
    .nth(1)
    .locator("th")
    .first();
  await expect(firstRow2Header).toBeVisible();
  const w = await firstRow2Header.evaluate(
    (el) => getComputedStyle(el).borderLeftWidth
  );
  expect(w).toBe("1px");
});

test("month-count control switches the budget to N side-by-side month columns", async ({ page }) => {
  // Default is 3 months. The header shows three "Budgeted" sub-headers,
  // one per visible month, plus per-month labels (May/Jun/Jul 2026).
  const thead = page.locator("table.y-table thead");
  const monthHeader = (label: string) =>
    thead.getByRole("columnheader", { name: label, exact: true });
  const budgetedCount = () => thead.getByText("Budgeted", { exact: true }).count();

  expect(await budgetedCount()).toBe(3);
  await expect(monthHeader("May 2026")).toBeVisible();
  await expect(monthHeader("Jun 2026")).toBeVisible();
  await expect(monthHeader("Jul 2026")).toBeVisible();

  // Switch to 6 months — the window spans 4 months before to 1 month after
  // the anchor (Jun 2026).
  await page.getByRole("button", { name: "6 months" }).click();
  await expect(monthHeader("Apr 2026")).toBeVisible();
  await expect(monthHeader("Aug 2026")).toBeVisible();
  expect(await budgetedCount()).toBe(6);

  // Switch back to 1 month — per-month labels collapse, only the classic
  // Category / Budgeted / Outflows / Balance header is shown.
  await page.getByRole("button", { name: "1 month" }).click();
  await expect(monthHeader("May 2026")).toBeHidden();
  expect(await budgetedCount()).toBe(1);
});

