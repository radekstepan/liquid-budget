// apps/web/tests/e2e/overdraft.spec.ts
//
// Covers the "overbudgeted" UX that none of the existing specs
// touch. When the budget is overbudgeted (tbb < 0 — see
// budget-engine.ts:139, 146), two affordances appear in the UI:
//
//   1. Inspector ATB card flips from "To Be Budgeted" → "Overbudgeted"
//      and shows a "Zero out N overdrafted" button
//      (Inspector.tsx:110-127).
//   2. BudgetView shows a red banner with a "Zero out overdrafts"
//      button above the table (BudgetView.tsx:191-212).
//
// Both buttons call the same `clearOverdraft(categoryIds)` callback,
// which sets every overdrafted category's `assigned` to 0 in the
// current month (BudgetApp.tsx:211-216). This in turn raises the
// TBB (since `tbb = totalIncome - totalAssigned + priorSurplus`).
//
// To force the overbudgeted state in a self-contained way we
// raise a single category's assignment via the API until TBB
// goes negative, while keeping at least one other category
// overdrafted (its assigned is below its outflow) so the "Zero
// out N overdrafted" button has N > 0.
//
// Mutating tests rely on the CI global setup for determinism.
import { test, expect, type Page } from "@playwright/test";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
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

async function getTbb(page: Page): Promise<number> {
  const res = await page.request.get("/api/budget");
  // The TBB is not in the GET response (it lives only in the
  // computed budget tree), so we read the Inspector's ATB value
  // off the DOM. The ATB card (Inspector.tsx:110-127) renders the
  // value as the first `.y-num` text inside `.y-atb`.
  const text = await page.locator(".y-atb .y-num").first().textContent();
  expect(text, "ATB value should be visible").toBeTruthy();
  // "$17,510.99" → 17510.99. The text may also be negative ("-$9,490").
  const cleaned = text!.replace(/[$,]/g, "").replace(/[−–]/g, "-");
  return Number(cleaned);
}

async function forceOverbudgeted(
  page: Page,
  overdraftCategoryId: number,
  bumpCategoryId: number
) {
  // The seed month is "2026-06". Raise the bump category's
  // assignment until the ATB goes negative. We use a generous
  // bump because the seed has prior-surplus carryforward of
  // ~$18K plus June income ~$8.8K, so we need a bump of at least
  // $30K to flip the sign.
  const month = "2026-06";

  // First, make the overdraft category definitely in the red by
  // zeroing its assignment. It has June outflow from the seed
  // (Groceries gets ~$681 in June), so available = 0 - outflow < 0.
  await setAssignment(page, overdraftCategoryId, month, 0);

  // Then push the bump category's assignment high enough to flip
  // TBB negative. We retry in 5K increments to avoid an
  // over-shoot that would take multiple round-trips to recover.
  for (const bump of [30000, 40000, 50000, 60000]) {
    await setAssignment(page, bumpCategoryId, month, bump);
    await page.reload();
    await waitForReady(page);
    const tbb = await getTbb(page);
    if (tbb < 0) return;
  }
  throw new Error("could not force overbudgeted state — TBB stayed positive");
}

test("Inspector ATB card shows Overbudgeted and the Zero out button appears", async ({ page }) => {
  // Groceries (id 11) has June outflow and gets the small/zero
  // assignment so it's overdrafted. Rent (id 7) gets the big
  // assignment to push TBB negative.
  await forceOverbudgeted(page, 11, 7);

  // The Inspector ATB card flips to the red "Overbudgeted" tone
  // (Inspector.tsx:111 → `y-atb--red`). There are two `.y-atb`
  // cards in the app — one in BudgetHeader, one in Inspector —
  // so scope to the inspector aside.
  const atbCard = page.locator(".y-inspector .y-atb--red");
  await expect(atbCard).toBeVisible();
  await expect(atbCard.getByText("Overbudgeted", { exact: true })).toBeVisible();

  // The "Zero out N overdrafted" button is visible with N >= 1.
  const zeroBtn = atbCard.getByRole("button", { name: /Zero out \d+ overdrafted/ });
  await expect(zeroBtn).toBeVisible();
  const label = await zeroBtn.textContent();
  const n = Number(label!.match(/(\d+)/)?.[1] ?? "0");
  expect(n, "expected at least one overdrafted category").toBeGreaterThan(0);
});

test("BudgetView shows the overbudgeted banner with a Zero out overdrafts button", async ({ page }) => {
  await forceOverbudgeted(page, 11, 7);

  // The banner lives just above the budget table
  // (BudgetView.tsx:191-212). Its text reads
  // "You've overbudgeted by $X.XX this month." plus the button.
  const banner = page.getByText(/You've overbudgeted by/);
  await expect(banner).toBeVisible();

  // The banner is its own little row above the table; the
  // "Zero out overdrafts" button is the one inside it.
  const bannerRow = page.locator("div").filter({ has: banner }).first();
  // The button is the next-sibling element within the banner row.
  const zeroBtn = bannerRow.getByRole("button", { name: "Zero out overdrafts" });
  await expect(zeroBtn).toBeVisible();
});

test("clicking the Inspector's Zero out button PATCHes every overdrafted category to assigned=0", async ({
  page,
}) => {
  // The "Zero out N overdrafted" button calls
  //   api.assign(id, 0, month)
  // for every category with `available < 0` (BudgetApp.tsx:211-216).
  // We assert the side effect: every overdrafted category's
  // assignment in the current month is 0 after the click.
  await forceOverbudgeted(page, 11, 7);

  // Capture which categories the Inspector considers overdrafted
  // *before* the click. The button label is "Zero out N
  // overdrafted"; the ids themselves aren't exposed in the DOM,
  // so we infer the set from the budget: any non-CC category
  // with `available < 0` in the current month.
  const before = await page.request.get("/api/budget");
  const beforeBody = await before.json();
  const month = "2026-06";
  // The Inspector's `overdraftCats` excludes the CC-payments
  // group (Inspector.tsx:40-43 mirrors the same condition).
  const ccGroupId = beforeBody.groups.find(
    (g: { isCreditCardPayments: boolean }) => g.isCreditCardPayments
  )?.id;
  const overdraftedIds = beforeBody.categories
    .filter((c: { groupId: number }) => c.groupId !== ccGroupId)
    .map((c: { id: number }) => c.id)
    .filter((id: number) => {
      // `available` is computed on the client from
      // carryover + assigned + outflow. Replicate the engine
      // by reading assignments + transactions.
      const assigned = beforeBody.assignments
        .filter((a: { categoryId: number; month: string }) =>
          a.categoryId === id && a.month === month
        )
        .reduce(
          (s: number, a: { amount: string }) => s + Number(a.amount),
          0
        );
      const outflow = beforeBody.transactions
        .filter(
          (t: {
            categoryId: number | null;
            date: string;
            amount: string;
            status: string;
            parentId: number | null;
          }) =>
            t.categoryId === id &&
            t.date.startsWith(month) &&
            t.status !== "u" &&
            t.parentId == null
        )
        .reduce((s: number, t: { amount: string }) => s + Number(t.amount), 0);
      const carryover = Number(
        beforeBody.categories.find(
          (c: { id: number }) => c.id === id
        )?.carryover ?? 0
      );
      return carryover + assigned + outflow < -0.005;
    });
  expect(overdraftedIds.length, "precondition: ≥1 overdrafted category").toBeGreaterThan(0);

  // Capture the PUT /api/assignments traffic triggered by the
  // click. Each call carries { categoryId, month, amount: 0 }.
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

  // Click the button.
  const atbCard = page.locator(".y-inspector .y-atb--red");
  await atbCard.getByRole("button", { name: /Zero out \d+ overdrafted/ }).click();

  // Wait for at least one PUT to land, then drain the rest.
  await expect
    .poll(() => putCalls.length, { timeout: 5_000 })
    .toBeGreaterThan(0);

  // The PUT traffic covered every overdrafted id, with amount=0.
  for (const id of overdraftedIds) {
    const hit = putCalls.find(
      (c) => c.categoryId === id && Math.abs(c.amount) < 0.005
    );
    expect(
      hit,
      `expected PUT /api/assignments { categoryId: ${id}, amount: 0 }`
    ).toBeTruthy();
  }
});
