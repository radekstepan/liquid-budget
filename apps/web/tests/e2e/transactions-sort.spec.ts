// apps/web/tests/e2e/transactions-sort.spec.ts
//
// Covers the sortable + sticky register header in TransactionsView:
//   - each transaction column header is clickable and toggles asc/desc
//   - aria-sort reflects the active column and direction
//   - the header stays sticky (position: sticky) while the register scrolls
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test("register header is sticky and Date sort state follows header clicks", async ({ page }) => {
  const register = page.locator("table.y-table:not(.y-scheduled-table)");
  const dateTh = register.locator("thead th").filter({ hasText: "Date" });

  await expect(dateTh).toHaveCSS("position", "sticky");
  await expect(dateTh).toHaveAttribute("aria-sort", "descending");

  // Scroll the register to the bottom; the header must remain visible.
  await page.locator("div.y-scroll").first().evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(dateTh).toBeVisible();

  // Click the Date header to flip to ascending; aria-sort follows.
  await dateTh.locator("button").click();
  await expect(dateTh).toHaveAttribute("aria-sort", "ascending");

  await dateTh.locator("button").click();
  await expect(dateTh).toHaveAttribute("aria-sort", "descending");

  // The selection column keeps its width when the sort key moves to Payee —
  // indicator space is reserved in every sortable header so the table never
  // reflows (this is the "checkbox padding" regression).
  const checkboxTh = register.locator("thead th").first();
  const widthBefore = await checkboxTh.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthBefore).toBeGreaterThanOrEqual(34);

  await register.locator("thead th").filter({ hasText: "Payee" }).locator("button").click();
  await expect(
    register.locator("thead th").filter({ hasText: "Payee" })
  ).toHaveAttribute("aria-sort", "ascending");
  const widthAfter = await checkboxTh.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBe(widthBefore);
});

test("sorts transactions by flag when the F header is clicked", async ({ page }) => {
  const stamp = Date.now();
  const payeeNone = `SORTF None ${stamp}`;
  const payeeRed = `SORTF Red ${stamp}`;
  const payeePurple = `SORTF Purple ${stamp}`;

  const ids: number[] = [];
  for (const [payee, flagColor] of [
    [payeeNone, null],
    [payeeRed, "red"],
    [payeePurple, "purple"],
  ] as const) {
    const res = await page.request.post("/api/transactions", {
      data: { accountId: 1, date: "2026-09-01", payee, amount: -100, status: "u", memo: "", flagColor },
    });
    ids.push((await res.json()).id);
  }

  // The client state predates these rows; reload to pick them up, then scope
  // the register to just the three rows.
  await page.reload();
  await waitForReady(page);
  await gotoAllTransactions(page);
  await page.getByPlaceholder("Search register").fill(String(stamp));

  const register = page.locator("table.y-table:not(.y-scheduled-table)");
  const rows = register.locator("tbody tr.y-row");
  await expect(rows).toHaveCount(3);

  // Ascending: unflagged, red, then purple. The flag button's accessible name
  // stays exactly "F" (the sort arrow is aria-hidden), so it is always found.
  const flagBtn = register.getByRole("button", { name: /^F$/ });
  const flagTh = flagBtn.locator("..");
  await flagBtn.click();
  await expect(flagTh).toHaveAttribute("aria-sort", "ascending");
  await expect(rows.nth(0)).toContainText(payeeNone);
  await expect(rows.nth(1)).toContainText(payeeRed);
  await expect(rows.nth(2)).toContainText(payeePurple);

  // Descending: purple, red, then none.
  await flagBtn.click();
  await expect(flagTh).toHaveAttribute("aria-sort", "descending");
  await expect(rows.nth(0)).toContainText(payeePurple);
  await expect(rows.nth(1)).toContainText(payeeRed);
  await expect(rows.nth(2)).toContainText(payeeNone);

  // Clean up the rows we created.
  for (const id of ids) {
    await page.request.delete(`/api/transactions?id=${id}`);
  }
});

test("sorts transactions by payee when the header is clicked", async ({ page }) => {
  const stamp = Date.now();
  const payeeA = `AAA Sort ${stamp}`;
  const payeeZ = `ZZZ Sort ${stamp}`;

  const a = await (
    await page.request.post("/api/transactions", {
      data: { accountId: 1, date: "2026-09-01", payee: payeeA, amount: -100, status: "u", memo: "" },
    })
  ).json();
  const z = await (
    await page.request.post("/api/transactions", {
      data: { accountId: 1, date: "2026-09-01", payee: payeeZ, amount: -100, status: "u", memo: "" },
    })
  ).json();

  // The client state predates these rows; reload to pick them up.
  await page.reload();
  await waitForReady(page);
  await gotoAllTransactions(page);

  const register = page.locator("table.y-table:not(.y-scheduled-table)");
  const payeeTh = register.locator("thead th").filter({ hasText: "Payee" });
  const rows = register.locator("tbody tr.y-row");

  // Default sort is Date descending; same-date rows tie-break by id desc,
  // so the later-created ZZZ row sits above AAA.
  await expect(rows.first()).toContainText(payeeZ);

  // Payee ascending → AAA first.
  await payeeTh.locator("button").click();
  await expect(payeeTh).toHaveAttribute("aria-sort", "ascending");
  await expect(rows.first()).toContainText(payeeA);

  // Payee descending → ZZZ first.
  await payeeTh.locator("button").click();
  await expect(payeeTh).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toContainText(payeeZ);

  // Clean up the rows we created.
  await page.request.delete(`/api/transactions?id=${a.id}`);
  await page.request.delete(`/api/transactions?id=${z.id}`);
});
