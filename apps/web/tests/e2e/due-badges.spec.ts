// apps/web/tests/e2e/due-badges.spec.ts
//
// YNAB4-style red due-count badge over accounts with overnight coverage:
//
//   - a scheduled transaction due today (or overdue) shows a red `.y-badge`
//     on its account row and on the Transactions nav row
//     (Sidebar.tsx:240-246 per-account 313-322, derived in
//     BudgetApp.tsx via countDueRecurring with `nextDate <= today`)
//   - when the app stays open across local midnight, the badge appears
//     without a manual reload: `useTodayISO` ticks over via its midnight
//     timeout (+ visibility/focus re-check) and `BudgetAppShell` re-runs
//     auto-post + reload on the date change.
//
// Strategy: Playwright's clock API mocks the *browser* Date/timers only —
// the Next.js server keeps the real date for auto-post. So the rollover
// test seeds a rule due "tomorrow" (real calendar), freezes the browser at
// 23:59:30 today, fast-forwards 2 minutes past midnight, then asserts the
// account badge count grows by exactly one AND the rollover fired auto-post
// + budget requests. It deliberately does NOT assert the server posted the
// rule (server still sees real-today), only that the requests fired.
//
// Serial suite (workers: 1 in playwright.config.ts); each test resets the
// shared DB via /api/reset like notifications.spec.ts. Seed data may carry
// its own due rules, so assertions diff against the loaded baseline rather
// than pinning exact counts.
import { test, expect, type Page, type Locator } from "@playwright/test";

/** Mirror of todayISO() in packages/logic/src/format.ts (local wall-date). */
function toLocalISODate(d: Date): string {
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("TD Unlimited Chequing").first()).toBeVisible();
}

/** Dismiss the mount auto-post toast if the seed had due rules, for a clean surface. */
async function dismissAutoToast(page: Page) {
  const autoToast = page.getByText(/Automatically entered \d+ scheduled transactions?\./);
  if (await autoToast.isVisible({ timeout: 500 }).catch(() => false)) {
    await autoToast.click();
    await expect(autoToast).toBeHidden();
  }
}

async function resetToDemo(page: Page) {
  const res = await page.request.post("/api/reset");
  expect(res.ok()).toBe(true);
}

async function createRecurring(
  page: Page,
  accountName: string,
  payee: string,
  nextDate: string
) {
  const budget = await (await page.request.get("/api/budget")).json();
  const account = (budget.accounts as { id: number; name: string }[]).find(
    (a) => a.name === accountName
  );
  expect(account, `seed account "${accountName}" exists`).toBeDefined();
  const created = await page.request.post("/api/recurring", {
    data: {
      accountId: account!.id,
      categoryId: null,
      payee,
      amount: -5000,
      frequency: "monthly",
      nextDate,
    },
  });
  expect(created.status()).toBe(200);
}

/** Current numeric badge on an account row, 0 when absent. */
async function accountBadgeCount(accountBtn: Locator): Promise<number> {
  const badge = accountBtn.locator(".y-badge");
  if ((await badge.count()) === 0) return 0;
  return parseInt((await badge.first().textContent()) ?? "0", 10) || 0;
}

test.describe("due-count badges", () => {
  test("overdue scheduled transaction shows a red badge on its account", async ({
    page,
  }) => {
    await resetToDemo(page);
    const payee = `PW DueBadge ${Date.now()}`;
    // Far-past nextDate: auto-post consumes the 5-occurrence catch-up cap
    // on load, leaving the rule still due (capped) so the badge persists.
    await createRecurring(page, "TD Unlimited Chequing", payee, "2020-01-15");

    await page.goto("/");
    await waitForReady(page);
    await dismissAutoToast(page);

    const accountBtn = page.getByRole("button", { name: /TD Unlimited Chequing/ });
    await expect(accountBtn.locator(".y-badge").first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await accountBadgeCount(accountBtn)).toBeGreaterThanOrEqual(1);
    await expect(page.getByLabel(/^\d+ due$/).first()).toBeVisible();
  });

  test("badge appears overnight without reload and rollover refires auto-post + reload", async ({
    page,
  }) => {
    await resetToDemo(page);

    // Rule due "tomorrow" in real-calendar terms: not due for the server
    // (real today) nor for the browser frozen at 23:59:30 today.
    const realNow = new Date();
    const tomorrowISO = toLocalISODate(addDays(realNow, 1));
    const payee = `PW DueBadge Overnight ${Date.now()}`;
    await createRecurring(page, "TD Unlimited Chequing", payee, tomorrowISO);

    // Freeze the browser just before midnight (same calendar day as real
    // today, so the rule is not yet due client-side either).
    const frozen = new Date(realNow);
    frozen.setHours(23, 59, 30, 0);
    await page.clock.install({ time: frozen });

    await page.goto("/");
    await waitForReady(page);
    await dismissAutoToast(page);

    const accountBtn = page.getByRole("button", { name: /TD Unlimited Chequing/ });
    const before = await accountBadgeCount(accountBtn);

    // Arm spies for the rollover network calls BEFORE fast-forwarding:
    // the mount effect already fired its own auto-post + reload, so the
    // next matching requests must come from the date-change effect.
    const autopostReq = page.waitForRequest(
      (req) => req.url().includes("/api/recurring") && req.method() === "POST"
    );
    const budgetReq = page.waitForRequest((req) =>
      req.url().includes("/api/budget")
    );

    // Cross midnight (+500ms hook buffer means 2 min is safely past it).
    await page.clock.fastForward(2 * 60 * 1000);

    // Badge count grows by exactly our rule, with no manual reload...
    await expect(accountBtn.locator(".y-badge")).toContainText(
      String(before + 1),
      { timeout: 15_000 }
    );

    // ...and the shell re-ran auto-post + full reload on the date change.
    await autopostReq;
    await budgetReq;
  });
});
