// apps/web/tests/e2e/calendar.spec.ts
//
// Covers CalendarView (packages/ui/src/CalendarView.tsx):
//   - the month label matches the active month
//   - clicking an empty day cell opens Add Transaction pre-dated to
//     that day (CalendarView.tsx:107-110)
//   - days with transactions render the per-day payee pills
//     (CalendarView.tsx:133-147)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByText("Calendar", { exact: true }).first()).toBeVisible();
});

test("toolbar reflects the active month", async ({ page }) => {
  // The MonthNav now exposes a month+year picker (blocks.tsx:57-86)
  // instead of a static text label, so we read the active month off
  // the Inspector badge (Inspector.tsx:38-53) which stays in sync.
  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jun 2026");
});

test("year dropdown jumps to the same month in the chosen year", async ({ page }) => {
  // Same MonthNav as the Budget view, so the picker is wired through
  // CalendarView.tsx:60-72 and shares the year+month selects.
  const picker = page.getByTestId("month-nav-picker");
  const yearSelect = picker.getByLabel("Year", { exact: true });
  await expect(yearSelect).toHaveValue("2026");

  await yearSelect.selectOption("2028");

  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jun 2028");
  await expect(picker.getByLabel("Month", { exact: true })).toHaveValue("5");
});

test("clicking an empty day opens the Add Transaction modal pre-dated to that day", async ({ page }) => {
  // The seed has no transactions on 2026-06-05 — the cell carries the
  // aria-label "Add transaction on YYYY-MM-DD" (CalendarView.tsx:113).
  await page.getByRole("button", { name: "Add transaction on 2026-06-05" }).click();

  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText("Add Transaction", { exact: true })).toBeVisible();
  await expect(modal.locator('input[type="date"]').first()).toHaveValue("2026-06-05");
});

test("a day with multiple transactions shows the payee pills", async ({ page }) => {
  // 2026-06-25 has 3 transactions in the seed (Fortis BC, Costco,
  // Susie share). Each renders as a pill in the day cell with the
  // payee as visible text (CalendarView.tsx:142-145). The cell itself
  // carries the role="button" + aria-label, regardless of whether
  // transactions exist (CalendarView.tsx:112-113).
  const cell = page
    .locator('div[role="button"][aria-label="Add transaction on 2026-06-25"]');
  await expect(cell).toBeVisible();
  await expect(cell).toContainText("Fortis BC");
  await expect(cell).toContainText("Costco");
});
