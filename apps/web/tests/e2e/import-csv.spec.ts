// apps/web/tests/e2e/import-csv.spec.ts
//
// E2E for the CSV transaction import path:
//
//   - API contract: POST /api/import/csv with the repo's sample
//     import.csv inserts every row as a cleared transaction for the
//     chosen account (apps/web/src/app/api/import/csv/route.ts)
//   - API contract: malformed CSV is rejected with 400 and the DB is
//     left untouched
//   - UI flow: Settings cog → "Import CSV" opens a YNAB4-style
//     preview where the user picks the account, toggles "Swap Payee
//     and Memo", and imports (Inspector.tsx + CsvImportModal.tsx)
//
// Like import.spec.ts this mutates a shared test DB, so it is serial
// and resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const REAL_CSV = fs.readFileSync(path.join(ROOT, "import.csv"), "utf-8");

const SWAP_CSV = [
  "Date,Payee,Category,Memo,Outflow,Inflow",
  "13/08/2026,PHNOM PENH RESTAURANT,,Vancouver,28.08,",
  "13/08/2026,UBER TRIP,,Toronto,18.63,",
].join("\n");

async function resetToDemo(request: import("@playwright/test").APIRequestContext) {
  const res = await request.post("/api/reset");
  expect(res.ok()).toBe(true);
}

test("POST /api/import/csv imports the sample file and updates the account", async ({
  request,
}) => {
  await resetToDemo(request);

  const budget = await (await request.get("/api/budget")).json();
  const chequing = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  const balanceBefore = chequing.balance;

  const res = await request.post("/api/import/csv", {
    data: { accountId: chequing.id, swap: false, csv: REAL_CSV },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.imported).toBe(49);

  const after = await (await request.get("/api/budget")).json();
  const payee = after.transactions.find((t: { payee: string }) =>
    t.payee.includes("PHNOM PENH RESTAURANT")
  );
  expect(payee).toBeTruthy();
  expect(payee.amount).toBe("-2808");
  expect(payee.status).toBe("c");
  const chequingAfter = after.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  expect(Number(chequingAfter.balance)).not.toBe(Number(balanceBefore));

  await resetToDemo(request);
});

test("POST /api/import/csv rejects malformed CSV without touching the DB", async ({
  request,
}) => {
  await resetToDemo(request);

  const budget = await (await request.get("/api/budget")).json();
  const countBefore = budget.transactions.length;

  const res = await request.post("/api/import/csv", {
    data: { accountId: 1, swap: false, csv: "not,a,valid,csv\n1,2,3,4\n" },
  });
  expect(res.status()).toBe(400);

  const after = await (await request.get("/api/budget")).json();
  expect(after.transactions.length).toBe(countBefore);

  await resetToDemo(request);
});

test("POST /api/import/csv skips duplicate rows on a second import", async ({ request }) => {
  await resetToDemo(request);

  const budget = await (await request.get("/api/budget")).json();
  const chequing = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );

  const first = await request.post("/api/import/csv", {
    data: { accountId: chequing.id, swap: false, csv: SWAP_CSV },
  });
  expect(first.status()).toBe(200);
  expect((await first.json()).imported).toBe(2);

  const second = await request.post("/api/import/csv", {
    data: { accountId: chequing.id, swap: false, csv: SWAP_CSV },
  });
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.imported).toBe(0);
  expect(secondBody.skipped).toHaveLength(2);
  expect(secondBody.skipped[0].reason).toBe("Matches an existing transaction");

  await resetToDemo(request);
});

test("importing through the Settings menu previews, swaps Payee/Memo, and imports", async ({
  page,
  request,
}) => {
  await resetToDemo(request);

  await page.goto("/");
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("TD Unlimited Chequing")).toBeVisible();

  await page.getByTitle("Settings").click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Import CSV").click(),
  ]);
  await chooser.setFiles({
    name: "import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(SWAP_CSV, "utf-8"),
  });

  const modal = page.locator(".y-modal").last();
  await expect(modal.getByText(/Import CSV/)).toBeVisible();
  await expect(modal.getByText("PHNOM PENH RESTAURANT")).toBeVisible();
  await expect(modal.getByRole("button", { name: /^Import 2 transactions$/ })).toBeEnabled();

  await modal.getByText("Swap Payee and Memo").click();
  const firstRow = modal.locator("table.y-table tbody tr.y-row").first();
  await expect(firstRow.locator("td").nth(1)).toHaveText("Vancouver");
  await expect(firstRow.locator("td").nth(2)).toHaveText("PHNOM PENH RESTAURANT");

  await modal.getByRole("button", { name: /^Import 2 transactions$/ }).click();
  await expect(modal).toBeHidden();

  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("Vancouver", { exact: true })).toBeVisible();

  await resetToDemo(request);
});
