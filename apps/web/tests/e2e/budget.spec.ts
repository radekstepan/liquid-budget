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

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// App init defaults to today's month (BudgetApp useState fallback), so
// expectations anchor on the real current date, not the seed data month.
function currentMonthParts() {
  const now = new Date();
  return { monthIdx: now.getMonth(), year: now.getFullYear() };
}

function shiftMonthParts(monthIdx: number, year: number, delta: number) {
  const total = year * 12 + monthIdx + delta;
  return { monthIdx: ((total % 12) + 12) % 12, year: Math.floor(total / 12) };
}

function shortLabel(monthIdx: number, year: number) {
  return `${MONTHS_SHORT[monthIdx]} ${year}`;
}

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("inline-edits a category assigned amount", async ({ page }) => {
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
  // The MonthNav picker reflects the active month/year and stays in
  // sync as the month shifts (blocks.tsx:57-86). Init anchors on
  // today's month, where Next is capped — so go back first, then forward.
  const { monthIdx, year } = currentMonthParts();
  const prev = shiftMonthParts(monthIdx, year, -1);
  const picker = page.getByTestId("month-nav-picker");
  const monthBtn = picker.getByRole("button", { name: "Month" });
  const yearBtn = picker.getByRole("button", { name: "Year" });
  await expect(monthBtn).toHaveText(MONTHS_LONG[monthIdx]!);
  await expect(yearBtn).toHaveText(String(year));

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(monthBtn).toHaveText(MONTHS_LONG[prev.monthIdx]!);
  await expect(yearBtn).toHaveText(String(prev.year));

  await page.getByRole("button", { name: "Next month" }).click();
  await expect(monthBtn).toHaveText(MONTHS_LONG[monthIdx]!);
  await expect(yearBtn).toHaveText(String(year));
});

test("year dropdown beyond the future cap clamps to the latest allowed month", async ({ page }) => {
  // The MonthNav year select (blocks.tsx:74-85) is keyed off
  // `aria-label="Year"` and is scoped to the picker container
  // (data-testid="month-nav-picker") so the surrounding prev/next
  // buttons don't match. Navigation clamps to one month past today
  // (BudgetApp handleSetMonth), so jumping two years out lands on the cap.
  const now = new Date();
  const maxTotal = now.getFullYear() * 12 + now.getMonth() + 1;
  const maxMonth = MONTHS_LONG[((maxTotal % 12) + 12) % 12]!;
  const maxYear = String(Math.floor(maxTotal / 12));
  const picker = page.getByTestId("month-nav-picker");
  const yearSelect = picker.getByRole("button", { name: "Year" });
  await expect(yearSelect).toHaveText(String(now.getFullYear()));

  // One click jumps to a different year — replaces the multi-click
  // prev-arrow flow for any in-range year.
  await yearSelect.click();
  await page.locator(`.y-dropdown [data-value="${now.getFullYear() + 2}"]`).click();

  // The MonthNav picker stays in sync, clamped to the latest allowed month.
  await expect(yearSelect).toHaveText(maxYear);
  await expect(picker.getByRole("button", { name: "Month" })).toHaveText(maxMonth);
});

test("month dropdown jumps to the chosen month in the current year", async ({ page }) => {
  const { monthIdx, year } = currentMonthParts();
  const picker = page.getByTestId("month-nav-picker");
  const monthSelect = picker.getByRole("button", { name: "Month" });
  const yearSelect = picker.getByRole("button", { name: "Year" });

  await expect(monthSelect).toHaveText(MONTHS_LONG[monthIdx]!);
  await expect(yearSelect).toHaveText(String(year));

  await monthSelect.click();
  await page.locator('.y-dropdown [data-value="0"]').click(); // January is index 0

  await expect(monthSelect).toHaveText("January");
  await expect(yearSelect).toHaveText(String(year));
});

test("year dropdown range is derived from data and includes a future cap", async ({ page }) => {
  // The year select should include 2026 (the data's anchor year) and
  // extend at least 5 years into the future so users can budget ahead
  // (BudgetApp.tsx derives {minYear, maxYear} from data + thisYear + 5).
  const picker = page.getByTestId("month-nav-picker");
  const yearSelect = picker.getByRole("button", { name: "Year" });
  await yearSelect.click();
  const optionsText = await page.locator('.y-dropdown .y-dropdown-item-label').allTextContents();
  expect(optionsText).toContain("2026");
  const years = optionsText.map((t) => Number(t)).filter((n) => Number.isFinite(n));
  const maxOption = Math.max(...years);
  // The future cap adds at least 5 years beyond current year and data anchor year.
  const currentYear = new Date().getFullYear();
  expect(maxOption).toBeGreaterThanOrEqual(currentYear + 5);
  await page.keyboard.press("Escape");
});

test("Toggling a group collapses and expands its category rows", async ({ page }) => {
  // The first "Housing" group's row (Mortgage Principal) should be visible
  // when expanded.
  const mortgageRow = page.getByRole("row").filter({ hasText: "Mortgage Principal" });
  await expect(mortgageRow).toBeVisible();

  // Toggle group
  const housingToggle = page.getByRole("button", { name: "Toggle Housing group" });
  await housingToggle.click();
  await expect(mortgageRow).toBeHidden();

  await housingToggle.click();
  await expect(mortgageRow).toBeVisible();
});

test("clicking a real history bar in the Inspector jumps to that month", async ({ page }) => {
  // June 2026 is a "real" history bar (a month with assignments in the
  // seed). Shift one month back so the jump produces a visible change.
  const { monthIdx, year } = currentMonthParts();
  const prev = shiftMonthParts(monthIdx, year, -1);
  await page.getByRole("button", { name: "Previous month" }).click();
  const picker = page.getByTestId("month-nav-picker");
  const monthBtn = picker.getByRole("button", { name: "Month" });
  await expect(monthBtn).toHaveText(MONTHS_LONG[prev.monthIdx]!);

  // Inspector history bar (Inspector.tsx) uses aria-label
  // "Jump to <MonthShort> <Year>" — MONTHS is the 3-letter array
  // (Inspector.tsx:5, format.ts:1-14), so it's "Jun 2026", not "June 2026".
  await page.getByRole("button", { name: "Jump to Jun 2026" }).click();
  await expect(monthBtn).toHaveText("June");
  await expect(picker.getByRole("button", { name: "Year" })).toHaveText("2026");
});

test("month column group divider has a visible 2px left border in both header and body", async ({ page }) => {
  // Each month group is separated by a 2px border-strong delimiter
  // (.y-table-colgroup-divider). The first month group is not a divider
  // (it's the leftmost), so we look at the second group — both in the
  // header and in a body row. Init centers today's column in the
  // scroller, so it is on-screen, not behind the scrollbar.
  // Step 3 months back so the current (blue-edged) month leaves the
  // window: dividers beside it deliberately paint blue/none instead of
  // the 2px chrome this test pins. The anchor month is centered in the
  // scroller, so it is on-screen, not behind the scrollbar.
  const { monthIdx: curIdx, year: curYear } = currentMonthParts();
  const anchor = shiftMonthParts(curIdx, curYear, -3);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Previous month" }).click();
  }
  // The month-label th also hosts the quick-budget trigger button, so its
  // accessible name is not exactly the label — match the label span text.
  await expect(
    page.locator("th.y-table-th--month-label", { hasText: shortLabel(anchor.monthIdx, anchor.year) })
  ).toBeVisible();

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

test("multi-month header has no seam: month labels are ~27px and the sub-header sticks at exactly 27px", async ({ page }) => {
  // Default is 3 months, so the two-row header is rendered. The month-label
  // row targets 27px tall (border-box, incl. its 1px bottom border), but it
  // never measures exactly that: table cells treat height as a minimum and
  // real font metrics add ~1px on top of the 16px line + 10px padding, so
  // pin a tight range instead of an exact pixel value. The Budgeted/
  // Outflows/Balance sub-row must stick at top: 27px so nothing shines
  // through the seam and the Category cell (rowSpan=2) bottoms out flush
  // with the sub-row.
  const monthLabel = page.locator("th.y-table-th--month-label").first();
  await expect(monthLabel).toBeVisible();
  const h = await monthLabel.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(26);
  expect(h).toBeLessThanOrEqual(30);

  const subTop = await page
    .locator("table.y-table thead tr:nth-child(2) th")
    .first()
    .evaluate((el) => getComputedStyle(el).top);
  expect(subTop).toBe("27px");

  // The rowSpan=2 Category cell ends flush with the sub-row's bottom.
  const catCell = page
    .locator("table.y-table thead th.y-table-td--sticky-cat")
    .first();
  const catBottom = await catCell.evaluate((el) => el.getBoundingClientRect().bottom);
  const firstSub = await page
    .locator("table.y-table thead tr:nth-child(2) th")
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom;
    });
  expect(catBottom - firstSub).toBe(0);
});

test("today's month column is scrolled into view on init", async ({ page }) => {
  // Regression: on init today's month must be visible in the UI, not
  // stuck behind the horizontal scrollbar/fold at scrollLeft 0.
  // BudgetView centers today's header in the scroller on mount.
  // Wait for the grid first: a bare evaluate() doesn't retry, so without
  // this the check can run while the app is still loading (no scroller
  // rendered yet) and fail spuriously.
  await expect(page.locator("th.y-table-th--month-label").first()).toBeVisible();
  const scrolled = await page.evaluate(() => {
    const container = document.querySelector(".overflow-auto.y-scroll") as HTMLElement | null;
    if (!container) return { ok: false, reason: "no scroller" };
    // No overflow → everything is visible by construction.
    if (container.scrollWidth <= container.clientWidth + 1) return { ok: true, reason: "fits" };
    // Overflow → today's column must have been scrolled into view.
    const target = document.querySelector("th.y-table-th--month-current") as HTMLElement | null;
    if (!target) return { ok: false, reason: "no today column" };
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const fullyVisible = t.left >= c.left - 1 && t.right <= c.right + 1;
    return { ok: fullyVisible, reason: fullyVisible ? "visible" : "behind fold" };
  });
  expect(scrolled.reason, "today's month column must be visible on init").toBeTruthy();
  expect(scrolled.ok).toBe(true);
});

test("month-count control switches the budget to N side-by-side month columns", async ({ page }) => {
  // Default is 3 months anchored on today's month. The header shows three
  // "Budgeted" sub-headers, one per visible month, plus per-month labels.
  const { monthIdx, year } = currentMonthParts();
  const prev = shiftMonthParts(monthIdx, year, -1);
  const next = shiftMonthParts(monthIdx, year, 1);
  const thead = page.locator("table.y-table thead");
  // The month-label th also hosts the quick-budget trigger button, so its
  // accessible name is not exactly the label — match the label span text.
  const monthHeader = (label: string) =>
    thead.locator("th.y-table-th--month-label", { hasText: label });

  await expect(thead.getByText("Budgeted", { exact: true })).toHaveCount(3);
  await expect(monthHeader(shortLabel(prev.monthIdx, prev.year))).toBeVisible();
  await expect(monthHeader(shortLabel(monthIdx, year))).toBeVisible();
  await expect(monthHeader(shortLabel(next.monthIdx, next.year))).toBeVisible();

  // Switch to 6 months. The 6-month window is capped at one month past
  // today, so first shift back 4 months to give it headroom: the window
  // then spans 6 full columns ending at last month.
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Previous month" }).click();
  }
  const start = shiftMonthParts(monthIdx, year, -6);
  const end = shiftMonthParts(monthIdx, year, -1);
  await page.getByRole("button", { name: "6 months" }).click();
  await expect(monthHeader(shortLabel(start.monthIdx, start.year))).toBeVisible();
  await expect(monthHeader(shortLabel(end.monthIdx, end.year))).toBeVisible();
  await expect(thead.getByText("Budgeted", { exact: true })).toHaveCount(6);

  // Switch back to 1 month — per-month labels collapse, only the classic
  // Category / Budgeted / Outflows / Balance header is shown.
  await page.getByRole("button", { name: "1 month" }).click();
  await expect(monthHeader(shortLabel(start.monthIdx, start.year))).toBeHidden();
  await expect(thead.getByText("Budgeted", { exact: true })).toHaveCount(1);
});

