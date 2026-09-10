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

/**
 * Narrow the register via the toolbar "Filter transactions" button and the
 * global search modal (the inline "Search register" input was removed by the
 * search-ux rework). Fills the modal input with free text, applies it with
 * "Show in register", and waits for the register filter bar to appear.
 * Any pre-existing filter is cleared first so the Filter button is visible.
 * Blank text clears the filter instead (the modal's "Show in register"
 * only appears for non-empty queries).
 */
export async function filterRegisterByText(page: Page, text: string): Promise<void> {
  if (text.trim() === "") {
    await clearRegisterFilter(page);
    return;
  }
  const bar = page.getByTestId("register-filter-bar");
  const filterBtn = page.getByRole("button", { name: "Filter transactions" });
  // Retry: an owner-held filter can re-apply asynchronously after
  // navigation/account switches (register remount + nonce effect),
  // replacing the Filter button with the bar between our check and click.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await bar.isVisible().catch(() => false)) {
      await bar.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(bar).toBeHidden();
    }
    try {
      await filterBtn.click({ timeout: 5000 });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  const modal = page.getByTestId("global-search-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("global-search-input").fill(text);
  await page.getByRole("button", { name: "Show in register" }).click();
  await expect(modal).toBeHidden();
  await expect(bar).toBeVisible();
}

/** Clear an applied register filter via the filter bar's Clear button. */
export async function clearRegisterFilter(page: Page): Promise<void> {
  const bar = page.getByTestId("register-filter-bar");
  await bar.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(bar).toBeHidden();
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
