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
  const yearSelect = picker.getByRole("button", { name: "Year" });
  await expect(yearSelect).toHaveText("2026");

  await yearSelect.click();
  await page.locator('.y-dropdown [data-value="2028"]').click();

  const monthBadge = page
    .locator(".y-inspector")
    .locator("div.text-\\[12\\.5px\\].font-bold")
    .first();
  await expect(monthBadge).toHaveText("Jun 2028");
  await expect(picker.getByRole("button", { name: "Month" })).toHaveText("June");
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

test("a day with more than three transactions truncates and expands", async ({ page }) => {
  // 2026-06-01 has 6 transactions in the seed. Only three pills render
  // (CalendarView.tsx:108); a "+N more" button expands the cell to
  // reveal the rest (CalendarView.tsx:161-172). Which three are shown
  // first depends on the query order, so assert counts, not payees.
  const cell = page.locator(
    'div[role="button"][aria-label="Add transaction on 2026-06-01"]'
  );
  const pills = () =>
    cell.locator(
      "div.flex.items-center.gap-1.rounded.px-1.py-\\[1px\\].text-\\[10px\\]"
    );

  const moreButton = cell.getByRole("button", { name: /^\+\d+ more$/ });
  await expect(moreButton).toBeVisible();
  const moreText = (await moreButton.textContent()) ?? "";
  const moreCount = Number(moreText.match(/\+(\d+) more/)?.[1]);
  expect(moreCount).toBeGreaterThan(0);

  await expect(pills()).toHaveCount(3);
  await moreButton.click();
  // All items now visible: the 3 truncated + the overflow count.
  await expect(pills()).toHaveCount(3 + moreCount);
  await expect(cell.getByRole("button", { name: /more/ })).toHaveCount(0);
});

test("days with transactions show a day net equal to the sum of their pills", async ({ page }) => {
  // 2026-06-10 has two seed transactions (Telus -110.00, Fido -90.00).
  // The day-net label must equal the sum of the visible pill amounts —
  // robust even if a parallel spec adds another row to the day.
  const cell = page.locator(
    'div[role="button"][aria-label="Add transaction on 2026-06-10"]'
  );
  const amounts = await cell
    .locator("span.y-num.shrink-0")
    .allTextContents();
  expect(amounts.length).toBeGreaterThan(0);
  const sum = amounts.reduce((s, a) => s + Number(a.replace(/[$,]/g, "")), 0);
  const dayNet = await cell
    .locator("span.y-num.text-\\[10\\.5px\\].font-bold")
    .textContent();
  expect(Number((dayNet ?? "").replace(/[$,]/g, ""))).toBeCloseTo(sum, 2);
});

test("toolbar shows a Net this month equal to the sum of the day nets", async ({ page }) => {
  // The exact June total shifts when parallel mutating specs add
  // June-dated rows to the shared dev DB, so assert self-consistency:
  // Net this month must equal the sum of every visible day net.
  const net = page.locator(".y-toolbar").getByText("Net this month:");
  await expect(net).toBeVisible();
  const total = Number(
    ((await net.locator("span.y-num").textContent()) ?? "").replace(/[$,]/g, "")
  );

  const dayNets = page.locator(
    'div[role="button"][aria-label^="Add transaction on 2026-06-"] span.y-num.text-\\[10\\.5px\\].font-bold'
  );
  const sum = (await dayNets.allTextContents()).reduce(
    (s, a) => s + Number(a.replace(/[$,]/g, "")),
    0
  );
  expect(total).toBeCloseTo(sum, 2);
});
