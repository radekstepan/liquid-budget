// apps/web/tests/e2e/transactions-merge.spec.ts
//
// E2E for YNAB4-style merging of two register transactions into one
// (packages/server/src/queries/transactions.ts `mergeTransactions`,
// packages/logic/src/merge.ts, MergePreviewModal.tsx):
//
//   - API: merging a manual row with a CSV-imported duplicate keeps the
//     imported row, preserves manual curation (category/memo/flag), and
//     leaves exactly one balance impact
//   - API: merge validates its input (exactly two distinct existing ids,
//     no splits) without touching the DB
//   - UI: selecting two rows shows a "Merge (2)" action that opens an
//     editable preview (result form + both source rows) and merges on confirm
//   - UI: the Merge action only appears when exactly two rows are selected
//   - UI: a manual + imported pair previews with the imported data winning
//
// Like import.spec.ts this mutates a shared test DB, so it is serial
// and resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect, type Page } from "@playwright/test";
import { filterRegisterByText } from "./helpers";

type Tx = {
  id: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: string;
  status: string;
  flagColor: string | null;
  needsReview: boolean;
  parentId: number | null;
};

async function resetToDemo(request: import("@playwright/test").APIRequestContext) {
  const res = await request.post("/api/reset");
  expect(res.ok()).toBe(true);
}

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();
}

async function seedIds(request: import("@playwright/test").APIRequestContext) {
  const budget = await (await request.get("/api/budget")).json();
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  const groceries = budget.categories.find(
    (c: { name: string }) => c.name === "Groceries"
  );
  expect(account?.id).toBeTruthy();
  expect(groceries?.id).toBeTruthy();
  return { accountId: account.id as number, groceriesId: groceries.id as number };
}

test("POST /api/transactions?action=merge keeps the imported row and preserves manual curation", async ({
  request,
}) => {
  await resetToDemo(request);
  const { accountId, groceriesId } = await seedIds(request);

  const before = await (await request.get("/api/budget")).json();
  const countBefore = before.transactions.length as number;
  const balanceBefore = Number(
    before.accounts.find((a: { id: number }) => a.id === accountId).balance
  );

  // Manual entry with curation (category, memo, flag).
  const manualRes = await request.post("/api/transactions", {
    data: {
      accountId,
      categoryId: groceriesId,
      date: "2026-08-02",
      payee: "Whole Foods",
      memo: "weekly shop",
      amount: -4999,
      cleared: true,
      flagColor: "red",
    },
  });
  expect(manualRes.status()).toBe(200);
  const manual = (await manualRes.json()) as { id: number };

  // The bank's view of the same purchase arrives via CSV import.
  const importRes = await request.post("/api/import/csv", {
    data: {
      accountId,
      swap: false,
      csv: ["Date,Payee,Outflow", "21/08/2026,WHOLE FOODS #24,50.00"].join("\n"),
    },
  });
  expect(importRes.status()).toBe(200);
  expect((await importRes.json()).imported).toBe(1);

  const pair = await (await request.get("/api/budget")).json();
  const imported = pair.transactions.find(
    (t: Tx) => t.payee === "WHOLE FOODS #24" && t.amount === "-5000"
  ) as Tx;
  expect(imported).toBeTruthy();
  expect(imported.status).toBe("u");
  expect(imported.needsReview).toBe(true);

  const mergeRes = await request.post("/api/transactions?action=merge", {
    data: { ids: [manual.id, imported.id] },
  });
  expect(mergeRes.status()).toBe(200);
  const { merged, deletedId } = (await mergeRes.json()) as {
    merged: Record<string, unknown>;
    deletedId: number;
  };

  // The imported row survives; the manual duplicate is deleted.
  expect(merged.id).toBe(imported.id);
  expect(deletedId).toBe(manual.id);

  // Imported bank data wins...
  expect(merged.date).toBe("2026-08-21");
  expect(Number(merged.amount)).toBe(-5000);
  expect(merged.payee).toBe("WHOLE FOODS #24");
  expect(merged.status).toBe("u");
  expect(merged.needsReview).toBe(true);
  // ...while manual curation fills the gaps the import left empty.
  expect(merged.categoryId).toBe(groceriesId);
  expect(merged.memo).toBe("weekly shop");
  expect(merged.flagColor).toBe("red");

  const after = await (await request.get("/api/budget")).json();
  expect(after.transactions.length).toBe(countBefore + 1);
  const balanceAfter = Number(
    after.accounts.find((a: { id: number }) => a.id === accountId).balance
  );
  expect(balanceAfter - balanceBefore).toBe(-5000);

  await resetToDemo(request);
});

test("POST /api/transactions?action=merge rejects bad input without touching the DB", async ({
  request,
}) => {
  await resetToDemo(request);
  const { accountId, groceriesId } = await seedIds(request);

  const mk = (payee: string) =>
    request.post("/api/transactions", {
      data: { accountId, date: "2026-08-01", payee, amount: -100, cleared: true },
    });
  const a = (await (await mk("PW Merge Valid A")).json()) as { id: number };
  const b = (await (await mk("PW Merge Valid B")).json()) as { id: number };
  const c = (await (await mk("PW Merge Valid C")).json()) as { id: number };

  const splitRes = await request.post("/api/transactions", {
    data: {
      accountId,
      date: "2026-08-01",
      payee: "PW Merge Split",
      amount: -10000,
      subTransactions: [
        { categoryId: groceriesId, amount: -6000 },
        { categoryId: groceriesId, amount: -4000 },
      ],
    },
  });
  expect(splitRes.status()).toBe(200);
  const withSplit = await (await request.get("/api/budget")).json();
  const splitParent = withSplit.transactions.find(
    (t: Tx) => t.payee === "PW Merge Split" && t.parentId == null
  ) as Tx;
  expect(splitParent).toBeTruthy();

  const countBefore = withSplit.transactions.length as number;

  // Length mismatches fail schema validation, whose v4 message is terse
  // ("ids: Invalid input") — the status plus the ids path is the contract.
  const badMerges: { ids: number[]; status: number; match: RegExp }[] = [
    { ids: [a.id], status: 400, match: /ids:/i },
    { ids: [a.id, b.id, c.id], status: 400, match: /ids:/i },
    { ids: [a.id, a.id], status: 400, match: /itself/i },
    { ids: [a.id, 999999], status: 404, match: /not found/i },
    { ids: [splitParent.id, a.id], status: 400, match: /split/i },
  ];
  for (const bad of badMerges) {
    const res = await request.post("/api/transactions?action=merge", {
      data: { ids: bad.ids },
    });
    expect(res.status()).toBe(bad.status);
    expect((await res.json()).error).toMatch(bad.match);
  }

  const after = await (await request.get("/api/budget")).json();
  expect(after.transactions.length).toBe(countBefore);

  await resetToDemo(request);
});

test("selecting two rows previews the merge and combines them into one", async ({
  page,
  request,
}) => {
  await resetToDemo(request);
  const { accountId } = await seedIds(request);
  const stamp = Date.now();
  const payeeA = `PW Merge A ${stamp}`;
  const payeeB = `PW Merge B ${stamp}`;

  // Two manual rows: the lower id survives, so A (created first) is kept.
  for (const [payee, amount] of [
    [payeeA, -2000],
    [payeeB, -2500],
  ] as const) {
    const res = await request.post("/api/transactions", {
      data: { accountId, date: "2026-08-01", payee, amount, cleared: true },
    });
    expect(res.status()).toBe(200);
  }

  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
  await filterRegisterByText(page, String(stamp));

  const rowA = page.getByRole("row").filter({ hasText: payeeA }).first();
  const rowB = page.getByRole("row").filter({ hasText: payeeB }).first();
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await rowA.locator('input[type="checkbox"]').click();
  await rowB.locator('input[type="checkbox"]').click();
  await expect(page.getByText("2 selected")).toBeVisible();

  await page.getByRole("button", { name: "Merge (2)" }).click();
  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Merge transactions");
  await expect(modal.getByTestId("merge-result")).toBeVisible();
  await expect(modal.getByTestId("merge-constituents")).toBeVisible();
  // The editable result is prepopulated with the surviving payee,
  // and the constituents table shows both source rows.
  await expect(page.getByLabel("Payee")).toHaveValue(payeeA);
  const constituents = modal.getByTestId("merge-constituents");
  await expect(constituents.getByText(payeeA)).toBeVisible();
  await expect(constituents.getByText(payeeB)).toBeVisible();

  // Edits to the result are saved on the merged row.
  const editedMemo = `PW merged memo ${stamp}`;
  await page.getByPlaceholder("Optional notes").fill(editedMemo);

  await modal.getByRole("button", { name: "Merge transactions", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText("Merged 2 transactions into one.")).toBeVisible();

  await expect(page.getByRole("row").filter({ hasText: payeeA })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: payeeB })).toHaveCount(0);

  const after = await (await request.get("/api/budget")).json();
  const survivors = after.transactions.filter((t: Tx) => t.payee === payeeA);
  expect(survivors).toHaveLength(1);
  expect(survivors[0].amount).toBe("-2000");
  expect(survivors[0].memo).toBe(editedMemo);

  await resetToDemo(request);
});

test("the Merge action only appears when exactly two rows are selected", async ({
  page,
  request,
}) => {
  await resetToDemo(request);
  const { accountId } = await seedIds(request);
  const stamp = Date.now();
  const payees = [1, 2, 3].map((n) => `PW Merge N${n} ${stamp}`);
  for (const payee of payees) {
    const res = await request.post("/api/transactions", {
      data: { accountId, date: "2026-08-01", payee, amount: -100, cleared: true },
    });
    expect(res.status()).toBe(200);
  }

  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
  await filterRegisterByText(page, String(stamp));

  const rows = payees.map((p) => page.getByRole("row").filter({ hasText: p }).first());
  for (const row of rows) await expect(row).toBeVisible();
  const mergeBtn = page.getByRole("button", { name: "Merge (2)" });

  await rows[0]!.locator('input[type="checkbox"]').click();
  await expect(page.getByText("1 selected")).toBeVisible();
  await expect(mergeBtn).toHaveCount(0);

  await rows[1]!.locator('input[type="checkbox"]').click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await expect(mergeBtn).toBeVisible();

  await rows[2]!.locator('input[type="checkbox"]').click();
  await expect(page.getByText("3 selected")).toBeVisible();
  await expect(mergeBtn).toHaveCount(0);

  await resetToDemo(request);
});

test("a manual + imported pair previews with the import winning", async ({
  page,
  request,
}) => {
  await resetToDemo(request);
  const { accountId, groceriesId } = await seedIds(request);
  const stamp = Date.now();
  const manualPayee = `PW Merge Manual ${stamp}`;
  const importedPayee = `PW MERGE IMPORT ${stamp}`;

  const manualRes = await request.post("/api/transactions", {
    data: {
      accountId,
      categoryId: groceriesId,
      date: "2026-08-02",
      payee: manualPayee,
      memo: "curated memo",
      amount: -4999,
      cleared: true,
    },
  });
  expect(manualRes.status()).toBe(200);

  const importRes = await request.post("/api/import/csv", {
    data: {
      accountId,
      swap: false,
      csv: ["Date,Payee,Outflow", `21/08/2026,${importedPayee},50.00`].join("\n"),
    },
  });
  expect((await importRes.json()).imported).toBe(1);

  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
  await filterRegisterByText(page, String(stamp));

  const manualRow = page.getByRole("row").filter({ hasText: manualPayee }).first();
  const importedRow = page.getByRole("row").filter({ hasText: importedPayee }).first();
  await expect(manualRow).toBeVisible();
  await expect(importedRow).toBeVisible();

  await manualRow.locator('input[type="checkbox"]').click();
  await importedRow.locator('input[type="checkbox"]').click();
  await page.getByRole("button", { name: "Merge (2)" }).click();

  const modal = page.locator(".y-modal").last();
  await expect(modal.locator(".y-modal-head")).toHaveText("Merge transactions");
  // The editable result shows the imported bank data with the manual
  // curation filled in, and both source rows below.
  await expect(page.getByLabel("Payee")).toHaveValue(importedPayee);
  await expect(page.getByLabel("Memo")).toHaveValue("curated memo");
  const constituents = modal.getByTestId("merge-constituents");
  await expect(constituents.getByText(manualPayee)).toBeVisible();
  await expect(constituents.getByText(importedPayee)).toBeVisible();

  await modal.getByRole("button", { name: "Merge transactions", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText("Merged 2 transactions into one.")).toBeVisible();

  const after = await (await request.get("/api/budget")).json();
  const merged = after.transactions.find((t: Tx) => t.payee === importedPayee) as Tx;
  expect(merged).toBeTruthy();
  expect(merged.amount).toBe("-5000");
  expect(merged.date).toBe("2026-08-21");
  expect(merged.memo).toBe("curated memo");
  expect(merged.categoryId).toBe(groceriesId);
  expect(after.transactions.filter((t: Tx) => t.payee === manualPayee)).toHaveLength(0);

  await resetToDemo(request);
});
