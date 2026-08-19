// apps/web/tests/e2e/import.spec.ts
//
// E2E for the YNAB4 backup import path — the one feature with zero
// end-to-end coverage:
//
//   - API contract: uploading a valid .y4backup zip replaces the whole
//     budget (apps/web/src/app/api/import/route.ts)
//   - API contract: a zip with no .ynab4 entry is rejected with 400
//   - UI flow: Settings cog → "Import YNAB4 Backup" opens the file
//     picker; uploading a backup reloads the app with the imported
//     data (packages/ui/src/Inspector.tsx + BudgetAppShell.importYnab4)
//
// An import wipes the DB, so this file is self-cleaning: every test
// starts by resetting to the demo baseline and restores it when done.
// That keeps it safe against both the CI-only global reset and a
// developer's locally-running dev server. The tests must not run in
// parallel — each one owns the whole DB while it runs.
test.describe.configure({ mode: "serial" });
import { test, expect } from "@playwright/test";
import AdmZip from "adm-zip";

const IMPORTED_ACCOUNT = "Imported Chequing";
const IMPORTED_PAYEE = "Imported Payee";

// A minimal-but-realistic YNAB4 backup payload. Enough surface to
// prove the import replaced the demo data: one account, one OUTFLOW
// group with a subcategory, one transaction, one scheduled entry.
const ynabData = {
  accounts: [
    {
      entityId: "acc1",
      accountName: IMPORTED_ACCOUNT,
      accountType: "Checking",
      onBudget: true,
    },
  ],
  payees: [{ entityId: "p1", name: IMPORTED_PAYEE }],
  masterCategories: [
    {
      entityId: "mc1",
      name: "Imported Group",
      type: "OUTFLOW",
      subCategories: [{ entityId: "sc1", name: "Imported Category" }],
    },
  ],
  transactions: [
    {
      entityId: "t1",
      accountId: "acc1",
      date: "2026-08-01",
      amount: -42.5,
      cleared: "Cleared",
      payeeId: "p1",
      categoryId: "sc1",
    },
  ],
  scheduledTransactions: [
    {
      entityId: "s1",
      accountId: "acc1",
      date: "2026-09-01",
      amount: -100,
      frequency: "monthly",
      payeeId: "p1",
      categoryId: "sc1",
    },
  ],
  monthlyBudgets: [
    {
      month: "2026-08-01",
      monthlySubCategoryBudgets: [{ categoryId: "sc1", budgeted: 200 }],
    },
  ],
};

function buildBackup(): Buffer {
  const zip = new AdmZip();
  zip.addFile("budget.ynab4", Buffer.from(JSON.stringify(ynabData), "utf-8"));
  return zip.toBuffer();
}

async function resetToDemo(baseURL: string) {
  const res = await fetch(`${baseURL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

test("POST /api/import replaces the budget with the backup contents", async ({ request }) => {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
  await resetToDemo(base);

  const backup = buildBackup();
  const res = await request.post("/api/import", {
    multipart: {
      file: {
        name: "backup.y4backup",
        mimeType: "application/zip",
        buffer: backup,
      },
    },
  });
  expect(res.status()).toBe(200);

  const budget = await (await request.get("/api/budget")).json();
  const names = (arr: Array<{ name: string }>) => arr.map((a) => a.name);
  expect(names(budget.accounts)).toEqual([IMPORTED_ACCOUNT]);
  expect(names(budget.groups)).toContain("Imported Group");
  expect(names(budget.categories)).toContain("Imported Category");
  expect(
    budget.transactions.some((t: { payee: string }) => t.payee === IMPORTED_PAYEE)
  ).toBe(true);
  expect(
    budget.transactions.find((t: { payee: string }) => t.payee === IMPORTED_PAYEE)?.amount
  ).toBe("-4250");
  expect(budget.recurring.some((r: { payee: string }) => r.payee === IMPORTED_PAYEE)).toBe(true);
  // The imported assignment is present.
  expect(budget.assignments.some((a: { month: string }) => a.month === "2026-08")).toBe(true);

  // The demo accounts are gone.
  expect(names(budget.accounts)).not.toContain("TD Unlimited Chequing");

  await resetToDemo(base);
});

test("POST /api/import rejects a zip without a .ynab4 entry with 400", async ({ request }) => {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
  await resetToDemo(base);

  const zip = new AdmZip();
  zip.addFile("not-a-backup.txt", Buffer.from("hello"));
  const res = await request.post("/api/import", {
    multipart: {
      file: {
        name: "bad.zip",
        mimeType: "application/zip",
        buffer: zip.toBuffer(),
      },
    },
  });
  expect(res.status()).toBe(400);

  // The demo data is untouched.
  const budget = await (await request.get("/api/budget")).json();
  expect(budget.accounts.some((a: { name: string }) => a.name === "TD Unlimited Chequing")).toBe(true);

  await resetToDemo(base);
});

test("POST /api/import reports plain duplicate entries that were skipped", async ({
  request,
}) => {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
  await resetToDemo(base);

  const zip = new AdmZip();
  zip.addFile(
    "budget.ynab4",
    Buffer.from(
      JSON.stringify({
        ...ynabData,
        transactions: [
          ...ynabData.transactions,
          {
            entityId: "t1-dup",
            accountId: "acc1",
            date: "2026-08-01",
            amount: -42.5,
            cleared: "Cleared",
            payeeId: "p1",
            categoryId: "sc1",
          },
        ],
      }),
      "utf-8"
    )
  );
  const res = await request.post("/api/import", {
    multipart: {
      file: {
        name: "backup.y4backup",
        mimeType: "application/zip",
        buffer: zip.toBuffer(),
      },
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.summary.transactions).toBe(1);
  expect(body.summary.duplicatesSkipped).toHaveLength(1);
  expect(body.summary.duplicatesSkipped[0]).toMatchObject({
    payee: IMPORTED_PAYEE,
    reason: "Duplicate of an earlier transaction in this backup",
  });

  const budget = await (await request.get("/api/budget")).json();
  expect(
    budget.transactions.filter((t: { payee: string }) => t.payee === IMPORTED_PAYEE)
  ).toHaveLength(1);

  await resetToDemo(base);
});

test("uploading a backup through the Settings menu reloads the app with imported data", async ({ page, request }) => {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
  await resetToDemo(base);

  await page.goto("/");
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("TD Unlimited Chequing")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Import YNAB4 Backup").click(),
  ]);
  await chooser.setFiles({
    name: "backup.y4backup",
    mimeType: "application/zip",
    buffer: buildBackup(),
  });

  // The app reloads after a successful import.
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(IMPORTED_ACCOUNT)).toBeVisible();
  await expect(page.getByText("TD Unlimited Chequing")).toHaveCount(0);

  // And the imported transaction shows up in the register. (The scheduled
  // drawer also renders "Imported Payee", so scope to the register row.)
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText(IMPORTED_PAYEE).first()).toBeVisible();

  await resetToDemo(base);
});
