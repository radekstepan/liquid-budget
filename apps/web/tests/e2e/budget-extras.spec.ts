// apps/web/tests/e2e/budget-extras.spec.ts
//
// Covers BudgetView features not tested in budget.spec.ts:
//   - Quick Fill popover menu on category budget cells (BudgetView.tsx:970-1085)
//   - "Today" toolbar button jumping back to the current month (BudgetView.tsx:214-218)
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("Today button appears when viewing other months and jumps to current month", async ({ page }) => {
  // The Today button is always rendered: it shows the primary "Jump to
  // current month" state when today is out of view and a soft
  // "Current month is in view" state otherwise (BudgetView toolbar).
  const prevBtn = page.getByRole("button", { name: /previous month/i });
  const todayBtn = page.getByRole("button", { name: /Today/i });
  await expect(todayBtn).toBeVisible();

  // Step back until today leaves the viewport so the jump state engages.
  for (let i = 0; i < 5; i++) {
    if ((await todayBtn.getAttribute("title")) === "Jump to current month") break;
    await prevBtn.click();
  }
  await expect(todayBtn).toHaveAttribute("title", "Jump to current month");

  // Click Today — back on today's month the button flips to its soft state
  // and the picker shows the real today.
  await todayBtn.click();
  await expect(todayBtn).toHaveAttribute("title", "Current month is in view");
  const now = new Date();
  const picker = page.getByTestId("month-nav-picker");
  await expect(picker.getByRole("button", { name: "Month" })).toHaveText(MONTHS_LONG[now.getMonth()]!);
  await expect(picker.getByRole("button", { name: "Year" })).toHaveText(String(now.getFullYear()));
});
