// apps/web/tests/e2e/helpers.ts
//
// Searchable fields (searchable <Select> and <SearchList>) render their
// search input only while the dropdown is open. When closed, the field is a
// button showing the placeholder (empty) or the current value. These helpers
// open the field before interacting with its input.

import { expect, type Locator, type Page } from "@playwright/test";

/** Open a closed searchable <Select> so its search input appears. */
export async function openSearchField(
  scope: Locator,
  placeholder: string
): Promise<Locator> {
  const input = scope.locator(`input[placeholder="${placeholder}"]`).first();
  if (!(await input.isVisible().catch(() => false))) {
    await scope
      .locator('.y-select-wrap--searchable button[aria-haspopup="listbox"]')
      .filter({ hasText: placeholder })
      .first()
      .click();
    await expect(input).toBeVisible();
  }
  return input;
}

/** Open and fill a closed <SearchList> (free-text) field, e.g. the payee. */
export async function fillSearchlist(
  scope: Locator,
  placeholder: string,
  value: string
): Promise<void> {
  const input = scope.locator(`input[placeholder="${placeholder}"]`).first();
  if (!(await input.isVisible().catch(() => false))) {
    await scope.locator(".y-searchlist-trigger").first().click();
    await expect(input).toBeVisible();
  }
  await input.fill(value);
  await input.press("Enter");
}

/**
 * Pick a sub-transaction category/transfer by clicking the first sub-row
 * field that still shows the placeholder, then choosing the option (by index
 * within the open dropdown, or by accessible name). Clicking the sub-row
 * trigger closes any other open dropdown (e.g. a typed payee) before its own
 * dropdown opens.
 */
export async function pickSubCategory(
  scope: Locator,
  page: Page,
  option: string | number
): Promise<void> {
  await scope
    .locator('.y-select-wrap--searchable button[aria-haspopup="listbox"]')
    .filter({ hasText: "Category or Transfer…" })
    .first()
    .click();
  if (typeof option === "number") {
    await page.locator('.y-dropdown button[role="option"]').nth(option).click();
  } else {
    await page.getByRole("option", { name: option, exact: true }).click();
  }
}
