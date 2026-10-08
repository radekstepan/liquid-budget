// apps/web/tests/e2e/themes.spec.ts
//
// Covers the cog-menu Themes page: every theme is offered, the selection
// applies immediately (via <html data-theme>) and survives a reload through
// localStorage. Each test gets a fresh browser context, so no cleanup is
// needed.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function openThemes(page: Page) {
  await page.goto("/");
  await waitForReady(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Themes" }).click();
  await expect(page.getByRole("heading", { name: "Themes" })).toBeVisible();
}

test("offers every theme with Classic Blue active by default", async ({
  page,
}) => {
  await openThemes(page);
  for (const label of [
    "Classic Blue",
    "Midnight",
    "Ocean",
    "Forest",
    "Ember",
    "Wine",
    "Mocha",
    "Graphite",
    "Onyx",
  ]) {
    await expect(page.getByRole("radio", { name: label })).toBeVisible();
  }
  await expect(page.getByRole("radio", { name: "Classic Blue" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
});

test("applies the selected theme and remembers it across reload", async ({
  page,
}) => {
  // The pre-paint script sets data-theme before hydration; <html> carries
  // suppressHydrationWarning so this must never surface as a mismatch.
  const hydrationErrors: string[] = [];
  const collect = (text: string) => {
    if (/hydrat/i.test(text)) hydrationErrors.push(text);
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") collect(msg.text());
  });
  page.on("pageerror", (err) => collect(String(err)));

  await openThemes(page);
  await page.getByRole("radio", { name: "Forest" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await expect(
    page.evaluate(() => window.localStorage.getItem("ynab:theme:id"))
  ).resolves.toBe('"forest"');

  await page.reload();
  await waitForReady(page);
  // The pre-paint script restores the theme before React mounts.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Themes" }).click();
  await expect(page.getByRole("radio", { name: "Forest" })).toBeChecked();

  expect(hydrationErrors).toEqual([]);
});
