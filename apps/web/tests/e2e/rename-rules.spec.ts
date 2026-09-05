// apps/web/tests/e2e/rename-rules.spec.ts
//
// E2E for automatic payee rename rules:
//
//   - importing BCF1, renaming it, then importing + renaming BCF2
//     generalises the two exact rules into `BCF[N] -> BC Ferries`
//   - the learned rule is applied automatically to future CSV imports
//   - the CRUD API for rename rules (create/update/delete) works
//   - the Settings page displays the stored rules
//
// Like import.spec.ts this mutates a shared test DB, so it is serial
// and resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

const BCF1_CSV = ["Date,Payee,Outflow", "13/08/2026,BCF1,28.08"].join("\n");
const BCF2_CSV = ["Date,Payee,Outflow", "14/08/2026,BCF2,18.63"].join("\n");
const BCF3_CSV = ["Date,Payee,Outflow", "15/08/2026,BCF3,9.99"].join("\n");

async function resetToDemo(baseURL: string) {
  const res = await fetch(`${baseURL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

test("renaming two BCF transactions learns a BCF[N] rule that applies to future imports", async ({
  request,
}) => {
  await resetToDemo(BASE);

  const budget = await (await request.get("/api/budget")).json();
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  expect(account?.id).toBeTruthy();

  // 1. Import BCF1 and rename it -> exact rule BCF1 -> BC Ferries
  const first = await request.post("/api/import/csv", {
    data: { accountId: account.id, swap: false, csv: BCF1_CSV },
  });
  expect((await first.json()).imported).toBe(1);

  const afterFirst = await (await request.get("/api/budget")).json();
  const bcf1 = afterFirst.transactions.find((t: { payee: string }) => t.payee === "BCF1");
  expect(bcf1).toBeTruthy();

  const patch1 = await request.patch("/api/transactions", {
    data: { id: bcf1.id, payee: "BC Ferries" },
  });
  expect(patch1.status()).toBe(200);

  let rules = await (await request.get("/api/rename-rules")).json();
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    sourcePattern: "BCF1",
    targetPayee: "BC Ferries",
  });

  // 2. Import BCF2 and rename it -> the two exact rules generalise to BCF[N]
  const second = await request.post("/api/import/csv", {
    data: { accountId: account.id, swap: false, csv: BCF2_CSV },
  });
  expect((await second.json()).imported).toBe(1);

  const afterSecond = await (await request.get("/api/budget")).json();
  const bcf2 = afterSecond.transactions.find((t: { payee: string }) => t.payee === "BCF2");
  expect(bcf2).toBeTruthy();

  const patch2 = await request.patch("/api/transactions", {
    data: { id: bcf2.id, payee: "BC Ferries" },
  });
  expect(patch2.status()).toBe(200);

  rules = await (await request.get("/api/rename-rules")).json();
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    sourcePattern: "BCF[N]",
    targetPayee: "BC Ferries",
  });

  // 3. A future import of a sibling is renamed automatically
  const third = await request.post("/api/import/csv", {
    data: { accountId: account.id, swap: false, csv: BCF3_CSV },
  });
  expect((await third.json()).imported).toBe(1);

  const afterThird = await (await request.get("/api/budget")).json();
  const bcf3 = afterThird.transactions.find((t: { payee: string }) => t.payee === "BCF3");
  expect(bcf3).toBeFalsy();
  const renamed = afterThird.transactions.find(
    (t: { payee: string; amount: string }) => t.payee === "BC Ferries" && t.amount === "-999"
  );
  expect(renamed).toBeTruthy();

  await resetToDemo(BASE);
});

test("rename rule CRUD through the API", async ({ request }) => {
  await resetToDemo(BASE);

  const created = await request.post("/api/rename-rules", {
    data: { sourcePattern: "UBER", targetPayee: "Uber" },
  });
  expect(created.status()).toBe(200);
  const createdBody = await created.json();
  expect(createdBody.id).toBeTruthy();

  const updated = await request.patch("/api/rename-rules", {
    data: { id: createdBody.id, targetPayee: "Uber Trip" },
  });
  expect(updated.status()).toBe(200);
  expect((await updated.json()).targetPayee).toBe("Uber Trip");

  const rules = await (await request.get("/api/rename-rules")).json();
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ sourcePattern: "UBER", targetPayee: "Uber Trip" });

  const deleted = await request.delete(`/api/rename-rules?id=${createdBody.id}`);
  expect(deleted.status()).toBe(200);
  expect(await (await request.get("/api/rename-rules")).json()).toHaveLength(0);

  await resetToDemo(BASE);
});

test("the Settings page lists rename rules and explains [N]", async ({ page, request }) => {
  await resetToDemo(BASE);
  const created = await request.post("/api/rename-rules", {
    data: { sourcePattern: "BCF[N]", targetPayee: "BC Ferries" },
  });
  expect(created.status()).toBe(200);

  await page.goto("/");
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: /^settings$/i }).first().click();
  await page.getByText("Rename rules").click();
  await expect(page.getByText("Payee Rename Rules")).toBeVisible();
  await expect(page.getByRole("cell", { name: "BCF[N]", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "BC Ferries", exact: true })).toBeVisible();

  await resetToDemo(BASE);
});
