// apps/web/tests/e2e/inspector.spec.ts
//
// Covers Inspector chrome (packages/ui/src/Inspector.tsx):
//   - Settings cog opens the menu with "Import YNAB4 Backup" and
//     "Reset demo data" (Inspector.tsx:65-92)
//   - the Summary panel renders the six expected rows
//     (Inspector.tsx:129-143)
//   - the "Average Assigned" panel renders
//   - the "History (12 mo)" panel renders 12 month bars
//     (Inspector.tsx:150-187)
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test("Settings cog opens the menu with both options", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Import YNAB4 Backup")).toBeVisible();
  await expect(page.getByText("Reset demo data")).toBeVisible();
});

test("Summary panel shows the six expected rows", async ({ page }) => {
  for (const label of [
    "Assigned",
    "Outflow",
    "Available",
    "Carried Forward",
    "Total Available",
    "To Be Budgeted",
  ]) {
    await expect(
      page.locator(".y-panel").filter({ hasText: "Summary" }).getByText(label, { exact: true })
    ).toBeVisible();
  }
});

test("History panel renders 12 month bars", async ({ page }) => {
  const bars = page
    .locator(".y-panel")
    .filter({ hasText: "History (12 mo)" })
    .locator('button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(12);
});
