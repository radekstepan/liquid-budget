// apps/web/tests/e2e/rename-suggest.spec.ts
//
// E2E for AI-assisted payee rename rules after a CSV import
// (apps/web/src/app/api/rename-rules/suggest/route.ts,
// packages/server/src/queries/rename-suggest.ts,
// SettingsView.tsx "Suggest with AI"):
//
//   - importing a CSV exposes its wonky payees as rename candidates
//   - the full UI flow: "Suggest with AI" (LLM response mocked) opens a
//     review modal, and accepting creates rules plus backfills the
//     already-imported transactions
//   - the review modal supports deselecting rows, editing names inline,
//     and skipping the backfill onto existing transactions
//   - the accept API persists suggestions as rules and drops them from
//     the candidate queue
//
// The LLM itself is mocked at the browser boundary (page.route): the
// suite must never depend on a real API key, model, or network. The GET
// status call passes through to the real server with only `enabled`
// forced on (so the button renders even without LLM env), the POST
// suggest call is fulfilled with a canned AI response, and the POST
// accept call passes through so rule creation + backfill are real.
//
// Like import.spec.ts this mutates a shared test DB, so it is serial
// and resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect, type Page, type Route } from "@playwright/test";

const WONKY_AMZN = "AMZN Mktp US*RT3ABCD12";
const WONKY_WHOLE = "WHOLE FOODS #24";

const THREE_ROW_CSV = [
  "Date,Payee,Category,Memo,Outflow,Inflow",
  `13/08/2026,${WONKY_AMZN},,Electronics order,28.08,`,
  `14/08/2026,${WONKY_WHOLE},,Weekly groceries,18.63,`,
  "15/08/2026,STARBUCKS,,Morning coffee,5.50,",
].join("\n");

const TWO_ROW_CSV = [
  "Date,Payee,Category,Memo,Outflow,Inflow",
  `13/08/2026,${WONKY_AMZN},,Electronics order,28.08,`,
  `14/08/2026,${WONKY_WHOLE},,Weekly groceries,18.63,`,
].join("\n");

type Tx = { id: number; payee: string; amount: string };
type Rule = { id: number; sourcePattern: string; targetPayee: string };

async function resetToDemo(request: import("@playwright/test").APIRequestContext) {
  const res = await request.post("/api/reset");
  expect(res.ok()).toBe(true);
}

async function importCsv(
  request: import("@playwright/test").APIRequestContext,
  csv: string
): Promise<number> {
  const budget = await (await request.get("/api/budget")).json();
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  expect(account?.id).toBeTruthy();
  const res = await request.post("/api/import/csv", {
    data: { accountId: account.id, swap: false, csv },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).imported as number;
}

async function gotoRenameRules(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: /^settings$/i }).first().click();
  await page.getByText("Rename Rules").click();
  await expect(page.getByText("Payee Rename Rules")).toBeVisible();
}

/**
 * Mock the LLM boundary: status passes through with `enabled` forced on
 * (real candidates from the CSV import are preserved), suggest returns
 * the canned AI response, and accept passes through to the real server.
 */
async function mockLlmBoundary(
  page: Page,
  canned: { suggestions: unknown[]; skipped?: unknown[]; processed: number }
) {
  await page.route("**/api/rename-rules/suggest**", async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET") {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      json.enabled = true;
      await route.fulfill({
        status: res.status(),
        contentType: "application/json",
        body: JSON.stringify(json),
      });
      return;
    }
    if (method === "POST" && url.searchParams.get("action") === "accept") {
      await route.continue();
      return;
    }
    if (method === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suggestions: canned.suggestions,
          skipped: canned.skipped ?? [],
          model: "e2e-mock-model",
          processed: canned.processed,
        }),
      });
      return;
    }
    await route.continue();
  });
}

test("importing a CSV exposes its payees as AI rename candidates", async ({ request }) => {
  await resetToDemo(request);
  expect(await importCsv(request, TWO_ROW_CSV)).toBe(2);

  const status = await (await request.get("/api/rename-rules/suggest")).json();
  expect(status.totalUnique).toBe(2);
  expect(status.truncated).toBe(false);
  const payees = (status.candidates as { payee: string; count: number }[]).map((c) => c.payee);
  expect(payees).toContain(WONKY_AMZN);
  expect(payees).toContain(WONKY_WHOLE);

  await resetToDemo(request);
});

test("Suggest with AI reviews mocked suggestions and backfills the imported rows", async ({
  page,
  request,
}) => {
  await resetToDemo(request);
  expect(await importCsv(request, THREE_ROW_CSV)).toBe(3);

  // The candidate pool also holds ambient scheduled rows that page-load
  // auto-post marks needsReview (see the route test "GET status grows
  // when auto-post materializes overdue scheduled rows"), so the button
  // count and the mock's batch size follow the live queue, not the
  // import alone. `processed` is filled in after the page loads (and
  // auto-posts); the mock reads it when the suggest POST fires.
  const canned = {
    suggestions: [
      {
        sourcePattern: WONKY_AMZN,
        targetPayee: "Amazon",
        count: 1,
        memos: ["Electronics order"],
      },
      {
        sourcePattern: WONKY_WHOLE,
        targetPayee: "Whole Foods",
        count: 1,
        memos: ["Weekly groceries"],
      },
    ],
    skipped: [{ source: "STARBUCKS", reason: "Already clean — no rename needed." }],
    processed: 0,
  };
  await mockLlmBoundary(page, canned);

  await gotoRenameRules(page);
  const queued = (
    (await (await request.get("/api/rename-rules/suggest")).json()) as { totalUnique: number }
  ).totalUnique;
  canned.processed = queued;

  const suggestBtn = page.getByRole("button", { name: "Suggest rename rules with AI" });
  await expect(suggestBtn).toBeVisible();
  await expect(suggestBtn).toContainText(`Suggest with AI (${queued})`);
  await expect(suggestBtn).toBeEnabled();

  await suggestBtn.click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("AI suggestions — e2e-mock-model");
  // Both drafts render with the memos the AI saw as review evidence.
  await expect(modal.getByText(WONKY_AMZN)).toBeVisible();
  await expect(modal.getByText(WONKY_WHOLE)).toBeVisible();
  await expect(modal.getByText(/Electronics order/)).toBeVisible();
  await expect(modal.getByText(/Weekly groceries/)).toBeVisible();
  await expect(modal.getByLabel(`Suggested name for ${WONKY_AMZN}`)).toHaveValue("Amazon");
  await expect(modal.getByLabel(`Suggested name for ${WONKY_WHOLE}`)).toHaveValue("Whole Foods");
  await expect(modal.getByText("1 payee skipped")).toBeVisible();

  // Backfill defaults on: the imported rows are renamed too.
  await expect(
    modal.getByRole("checkbox", {
      name: "Also rename matching transactions already in the budget",
    })
  ).toBeChecked();
  await modal.getByRole("button", { name: "Create 2 rules" }).click();
  await expect(modal).toBeHidden();

  await expect(page.getByText("AI rules created")).toBeVisible();
  await expect(page.getByText("Created 2 AI rename rules.")).toBeVisible();
  await expect(page.getByRole("cell", { name: WONKY_AMZN, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Amazon", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Whole Foods", exact: true })).toBeVisible();

  // Real rules were persisted and the imported rows backfilled.
  const rules = (await (await request.get("/api/rename-rules")).json()) as Rule[];
  expect(rules).toHaveLength(2);
  const budget = await (await request.get("/api/budget")).json();
  const payees = (budget.transactions as Tx[]).map((t) => t.payee);
  expect(payees).toContain("Amazon");
  expect(payees).toContain("Whole Foods");
  expect(payees).not.toContain(WONKY_AMZN);
  expect(payees).not.toContain(WONKY_WHOLE);
  // The skipped payee was never touched.
  expect(payees).toContain("STARBUCKS");

  // Accepted payees drop out of the candidate queue; the skipped import
  // payee and the ambient scheduled candidates stay.
  const status = await (await request.get("/api/rename-rules/suggest")).json();
  expect(status.totalUnique).toBe(queued - 2);

  await resetToDemo(request);
});

test("the AI review modal supports deselecting, inline edits, and skipping the backfill", async ({
  page,
  request,
}) => {
  await resetToDemo(request);
  expect(await importCsv(request, TWO_ROW_CSV)).toBe(2);

  // Single batch: claim the whole live queue (imports plus ambient
  // auto-posted scheduled rows) so the mock's drafts are not repeated.
  const canned = {
    suggestions: [
      { sourcePattern: WONKY_AMZN, targetPayee: "Amazon", count: 1 },
      { sourcePattern: WONKY_WHOLE, targetPayee: "Whole Foods", count: 1 },
    ],
    processed: 0,
  };
  await mockLlmBoundary(page, canned);

  await gotoRenameRules(page);
  canned.processed = (
    (await (await request.get("/api/rename-rules/suggest")).json()) as { totalUnique: number }
  ).totalUnique;
  await page.getByRole("button", { name: "Suggest rename rules with AI" }).click();

  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("AI suggestions — e2e-mock-model");

  // Deselect the second row (the sr-only checkbox toggles via its label).
  const wholeRow = modal.locator("tbody tr", { hasText: WONKY_WHOLE });
  await wholeRow.locator("label").click();
  await expect(wholeRow.locator('input[type="checkbox"]')).not.toBeChecked();

  // Edit the surviving draft inline.
  await modal.getByLabel(`Suggested name for ${WONKY_AMZN}`).fill("Amazon dot ca");

  // Opt out of renaming already-imported transactions.
  await modal.getByText("Also rename matching transactions already in the budget").click();
  await expect(
    modal.getByRole("checkbox", {
      name: "Also rename matching transactions already in the budget",
    })
  ).not.toBeChecked();

  await modal.getByRole("button", { name: "Create 1 rule" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText("Created 1 AI rename rule.")).toBeVisible();

  // Only the edited rule exists; the stored rows keep their raw payees.
  const rules = (await (await request.get("/api/rename-rules")).json()) as Rule[];
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    sourcePattern: WONKY_AMZN,
    targetPayee: "Amazon dot ca",
  });
  const budget = await (await request.get("/api/budget")).json();
  const payees = (budget.transactions as Tx[]).map((t) => t.payee);
  expect(payees).toContain(WONKY_AMZN);
  expect(payees).toContain(WONKY_WHOLE);
  expect(payees).not.toContain("Amazon dot ca");

  await resetToDemo(request);
});

test("POST /api/rename-rules/suggest?action=accept persists rules and backfills imports", async ({
  request,
}) => {
  await resetToDemo(request);
  expect(await importCsv(request, TWO_ROW_CSV)).toBe(2);

  // No LLM involved: reviewed drafts persist through the standard learner.
  const accept = await request.post("/api/rename-rules/suggest?action=accept", {
    data: {
      suggestions: [
        { sourcePattern: WONKY_AMZN, targetPayee: "Amazon" },
        { sourcePattern: WONKY_WHOLE, targetPayee: "Whole Foods" },
      ],
      applyToExisting: true,
    },
  });
  expect(accept.status()).toBe(200);
  const body = (await accept.json()) as {
    rules: Rule[];
    applied: { updated: number; skippedLocked: number };
    generalised: boolean;
  };
  expect(body.rules).toHaveLength(2);
  expect(body.applied.updated).toBe(2);
  expect(body.generalised).toBe(false);

  const budget = await (await request.get("/api/budget")).json();
  const payees = (budget.transactions as Tx[]).map((t) => t.payee);
  expect(payees).toContain("Amazon");
  expect(payees).toContain("Whole Foods");

  // Both payees are now covered, so nothing remains to suggest.
  const status = await (await request.get("/api/rename-rules/suggest")).json();
  expect(status.totalUnique).toBe(0);

  // The endpoint validates its input.
  const empty = await request.post("/api/rename-rules/suggest?action=accept", {
    data: { suggestions: [] },
  });
  expect(empty.status()).toBe(400);
  const unknown = await request.post("/api/rename-rules/suggest?action=nope", { data: {} });
  expect(unknown.status()).toBe(400);

  await resetToDemo(request);
});
