// apps/web/tests/e2e/overdraft.spec.ts
//
// Covers the "overdrafted category" UX. A category row is overdrafted
// when its available balance goes negative (assigned below outflow):
//
//   1. The Inspector renders no ATB banner — even when the budget as a
//      whole is overbudgeted (tbb < 0), no "Overbudgeted" card appears
//      in the sidebar (the banner was removed from Inspector.tsx).
//   2. Each overdrafted category row with assigned > 0 gets an inline
//      "Unassign $X" button that sets that category's assigned to 0,
//      while an overdrafted row with assigned = 0 shows a plain
//      "overspent" label instead.
//
// To force the overbudgeted state in a self-contained way we
// raise a single category's assignment via the API until TBB
// goes negative, while keeping at least one other category
// overdrafted (its assigned is below its outflow). TBB is read from
// the budget-integrity diagnostics API rather than the DOM, since the
// sidebar banner that used to display it no longer exists.
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function resetToDemo(page: Page) {
  const res = await page.request.post("/api/reset");
  expect(res.ok()).toBe(true);
}

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await resetToDemo(page);
  // Anchor on the seed's data month: app init defaults to today's month.
  await page.goto("/budget/2026-06");
  await waitForReady(page);
});

async function setAssignment(
  page: Page,
  categoryId: number,
  month: string,
  amount: number
) {
  const res = await page.request.put("/api/assignments", {
    data: { categoryId, month, amount },
  });
  expect(res.status(), `PUT /api/assignments for ${categoryId}`).toBe(200);
}

async function getTbb(page: Page, month: string): Promise<number> {
  const res = await page.request.get("/api/diagnostics/budget-integrity", {
    params: { month },
  });
  expect(res.ok(), "GET /api/diagnostics/budget-integrity").toBe(true);
  const body = await res.json();
  expect(typeof body.tbb, "diagnostics response should include tbb").toBe("number");
  return Number(body.tbb);
}

async function forceOverbudgeted(
  page: Page,
  overdraftCategoryId: number,
  bumpCategoryId: number
) {
  const month = "2026-06";

  // Zero the overdraft category's assignment so it's in the red
  // (it has June outflow, so available = 0 - outflow < 0).
  await setAssignment(page, overdraftCategoryId, month, 0);

  // Push the bump category's assignment high enough to flip TBB negative.
  // TBB is checked via the diagnostics API (no reload needed — it reads
  // the DB directly); callers reload once afterwards for UI assertions.
  for (const bump of [5_000_000, 10_000_000, 15_000_000]) {
    await setAssignment(page, bumpCategoryId, month, bump);
    const tbb = await getTbb(page, month);
    if (tbb < 0) return;
  }
  throw new Error("could not force overbudgeted state — TBB stayed positive");
}

test("Inspector renders no ATB banner even when overbudgeted", async ({ page }) => {
  // Groceries (id 11) has June outflow and gets zero assignment so it's
  // overdrafted. Rent (id 7) gets the big assignment to push TBB negative.
  await forceOverbudgeted(page, 11, 7);
  await page.reload();
  await waitForReady(page);

  // The sidebar banner was removed: neither the element nor its labels
  // may appear, even in the overbudgeted state.
  const inspector = page.locator(".y-inspector");
  await expect(inspector.locator(".y-atb")).toHaveCount(0);
  await expect(
    inspector.getByText(/^(To Be Budgeted|Overbudgeted)$/)
  ).toHaveCount(0);
});

test("inline Unassign button PATCHes an overdrafted category to assigned=0", async ({
  page,
}) => {
  await forceOverbudgeted(page, 11, 7);
  await page.reload();
  await waitForReady(page);

  // Switch to 1-month mode — the Unassign button only renders in
  // single-month view (BudgetView.tsx:641-651 vs. MonthCells which
  // omits it for multi-month).
  await page.getByRole("button", { name: "1 month" }).click();

  // Groceries (id 11) should be overdrafted with assigned=0 (we zeroed it),
  // so it shows "overspent" text rather than an Unassign button.
  // Rent (id 7) has assigned > 0 from forceOverbudgeted, so if it's also
  // overdrafted we should see an Unassign button.
  await expect(
    page.getByText("overspent", { exact: true }).first()
  ).toBeVisible();
  //
  // We capture the PUT /api/assignments traffic triggered by the click.
  const putCalls: Array<{ categoryId: number; amount: number }> = [];
  page.on("request", (req) => {
    if (req.method() !== "PUT") return;
    if (!req.url().endsWith("/api/assignments")) return;
    try {
      const body = JSON.parse(req.postData() ?? "{}");
      putCalls.push({
        categoryId: Number(body.categoryId),
        amount: Number(body.amount),
      });
    } catch {
      // ignore non-JSON
    }
  });

  // Find an inline Unassign button.
  const unassignBtn = page.getByRole("button", { name: /unassign/i }).first();
  await expect(unassignBtn).toBeVisible();
  const label = await unassignBtn.textContent();
  const match = label?.match(/Unassign \$?([\d,]+\.?\d*)/i);

  await unassignBtn.click();

  // Wait for the PUT to land.
  await expect
    .poll(() => putCalls.length, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(1);

  // Verify every captured PUT sets amount = 0.
  for (const call of putCalls) {
    expect(call.amount).toBe(0);
  }
});
