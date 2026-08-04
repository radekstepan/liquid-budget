// apps/web/tests/e2e/projections.spec.ts
//
// Covers ProjectionsView (packages/ui/src/ProjectionsView.tsx):
//   - three MathCells (Liquid Balance / Projected Monthly Flow /
//     Projected in 12 mo) (ProjectionsView.tsx:62-78)
//   - 12-Month forecast SVG (ProjectionsView.tsx:80-121)
//   - projection table with 13 rows (months 0–12)
//     (ProjectionsView.tsx:122-152)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Projections", exact: true }).click();
  await expect(page.getByText("Projections", { exact: true }).first()).toBeVisible();
});

test("renders the three summary cells and the forecast panel", async ({ page }) => {
  await expect(page.getByText("Liquid Balance", { exact: true })).toBeVisible();
  await expect(page.getByText("Projected Monthly Flow", { exact: true })).toBeVisible();
  await expect(page.getByText("Projected in 12 mo", { exact: true })).toBeVisible();

  await expect(
    page.locator(".y-panel-head").filter({ hasText: "12-Month Liquid Balance Forecast" })
  ).toBeVisible();
  // The forecast SVG sits inside the panel body.
  await expect(page.locator("svg").filter({ has: page.locator("path") }).first()).toBeVisible();
});

test("renders 13 monthly rows in the projection table", async ({ page }) => {
  // The table body is in the last y-panel on the page.
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(13);
});
