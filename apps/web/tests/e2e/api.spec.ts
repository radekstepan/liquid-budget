// apps/web/tests/e2e/api.spec.ts
//
// Direct API contract tests. Uses Playwright's APIRequestContext so
// these run without booting a browser. They exercise the same handlers
// the React client uses and so catch server-only regressions (bad
// status codes, missing fields, broken validation).
//
// The tests are written to be self-cleaning where possible:
//   - the transaction create/delete pair is balanced, so the row
//     count ends where it started
//   - the assignment upsert uses a far-future month so it does not
//     surface in the budget UI but is still round-tripped by the API
import { test, expect, request as apiRequest } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test("GET /api/health returns ok", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const res = await ctx.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  await ctx.dispose();
});

test("GET /api/budget returns the six expected collections", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const res = await ctx.get("/api/budget");
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const key of [
    "accounts",
    "groups",
    "categories",
    "assignments",
    "transactions",
    "recurring",
  ]) {
    expect(Array.isArray(body[key]), `body.${key} should be an array`).toBe(true);
  }
  await ctx.dispose();
});

test("POST + DELETE /api/transactions round-trips a row", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });

  // Discover a real account + category from the live budget so the
  // created transaction doesn't trip FK constraints.
  const budget = await (await ctx.get("/api/budget")).json();
  const account = budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];
  expect(account?.id).toBeTruthy();
  expect(category?.id).toBeTruthy();

  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-15",
    payee: "PW API Contract",
    memo: "Created by api.spec.ts",
    amount: -1.23,
    cleared: true,
  };
  const created = await ctx.post("/api/transactions", { data: payload });
  expect(created.status()).toBe(200);
  const createdRow = await created.json();
  expect(createdRow.id).toBeGreaterThan(0);
  expect(createdRow.payee).toBe(payload.payee);

  // Confirm it shows up in the budget.
  const after = await (await ctx.get("/api/budget")).json();
  expect(
    after.transactions.some((t: { id: number }) => t.id === createdRow.id)
  ).toBe(true);

  // Clean up.
  const del = await ctx.delete(`/api/transactions?id=${createdRow.id}`);
  expect(del.status()).toBe(200);

  const cleaned = await (await ctx.get("/api/budget")).json();
  expect(
    cleaned.transactions.some((t: { id: number }) => t.id === createdRow.id)
  ).toBe(false);
  await ctx.dispose();
});

test("PUT /api/assignments upserts a row", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const budget = await (await ctx.get("/api/budget")).json();
  const categoryId = budget.categories[0].id;

  // Use a far-future month so this never collides with seed data
  // and never surfaces in the default budget view.
  const month = "2099-12";
  const amount = 12.34;

  const put = await ctx.put("/api/assignments", {
    data: { categoryId, month, amount },
  });
  expect(put.status()).toBe(200);
  const row = await put.json();
  expect(row.categoryId).toBe(categoryId);
  expect(row.month).toBe(month);
  expect(Number(row.amount)).toBeCloseTo(amount, 2);

  // It should appear in the budget response.
  const after = await (await ctx.get("/api/budget")).json();
  expect(
    after.assignments.some(
      (a: { categoryId: number; month: string }) =>
        a.categoryId === categoryId && a.month === month
    )
  ).toBe(true);
  await ctx.dispose();
});

test("POST /api/transactions creates a transfer and updates both balances", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const budget = await (await ctx.get("/api/budget")).json();
  // Use a date far in the future and a specific account pair to avoid
  // contention with other tests mutating the same accounts.
  const source = budget.accounts.find(
    (a: { name: string }) => a.name === "Cash"
  );
  const dest = budget.accounts.find(
    (a: { name: string }) => a.name === "Scotia e-Chequing"
  );
  expect(source?.id).toBeTruthy();
  expect(dest?.id).toBeTruthy();

  const sourceBalBefore = Number(source.balance);
  const destBalBefore = Number(dest.balance);
  const amount = -123.45;
  const date = "2099-06-15";

  const created = await ctx.post("/api/transactions", {
    data: {
      accountId: source.id,
      categoryId: null,
      date,
      payee: "",
      memo: "API transfer test",
      amount,
      transferAccountId: dest.id,
    },
  });
  expect(created.status()).toBe(200);
  const row = await created.json();
  expect(row.transferAccountId).toBe(dest.id);
  expect(row.categoryId).toBeNull();
  expect(row.payee).toMatch(/^Transfer : /);

  // Both balances updated.
  const after = await (await ctx.get("/api/budget")).json();
  const sourceAfter = after.accounts.find(
    (a: { id: number }) => a.id === source.id
  );
  const destAfter = after.accounts.find(
    (a: { id: number }) => a.id === dest.id
  );
  expect(Number(sourceAfter.balance)).toBeCloseTo(sourceBalBefore + amount, 2);
  expect(Number(destAfter.balance)).toBeCloseTo(destBalBefore - amount, 2);

  // Clean up the transfer.
  await ctx.delete(`/api/transactions?id=${row.id}`);
  await ctx.dispose();
});

test("POST /api/transactions with subTransactions creates a balanced split", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const budget = await (await ctx.get("/api/budget")).json();
  // Use TD (an account the other tests in this file don't touch) to
  // avoid contention with the parallel transfer test above.
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "TD Unlimited Chequing"
  );
  const catA = budget.categories[0];
  const catB = budget.categories[1];
  expect(account?.id).toBeTruthy();

  const accountBalBefore = Number(account.balance);
  const parentAmount = -50.0;
  const date = "2099-06-16";

  const created = await ctx.post("/api/transactions", {
    data: {
      accountId: account.id,
      categoryId: null,
      date,
      payee: "API split test",
      memo: "",
      amount: parentAmount,
      subTransactions: [
        { categoryId: catA.id, amount: -30 },
        { categoryId: catB.id, amount: -20 },
      ],
    },
  });
  expect(created.status()).toBe(200);
  const result = await created.json();
  expect(result.parent.categoryId).toBeNull();
  expect(result.parent.amount).toBeCloseTo(parentAmount, 2);
  expect(result.children).toHaveLength(2);
  expect(result.children[0].parentId).toBe(result.parent.id);

  // Account balance reflects only the children (parent has no balance effect).
  const after = await (await ctx.get("/api/budget")).json();
  const accountAfter = after.accounts.find(
    (a: { id: number }) => a.id === account.id
  );
  expect(Number(accountAfter.balance)).toBeCloseTo(accountBalBefore + parentAmount, 2);

  // Clean up — delete the parent, cascade should drop the children.
  await ctx.delete(`/api/transactions?id=${result.parent.id}`);
  await ctx.dispose();
});

test("POST /api/transactions rejects an unbalanced split with 400", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const budget = await (await ctx.get("/api/budget")).json();
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "Cash"
  );
  const cat = budget.categories[0];

  const res = await ctx.post("/api/transactions", {
    data: {
      accountId: account.id,
      categoryId: null,
      date: "2099-06-17",
      payee: "Bad split",
      memo: "",
      amount: -50,
      subTransactions: [
        { categoryId: cat.id, amount: -30 },
        { categoryId: cat.id, amount: -19.99 },
      ],
    },
  });
  expect(res.status()).toBe(400);
  await ctx.dispose();
});

test("POST /api/transactions rejects a transfer to the same account with 400", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  const budget = await (await ctx.get("/api/budget")).json();
  const account = budget.accounts.find(
    (a: { name: string }) => a.name === "Cash"
  );

  const res = await ctx.post("/api/transactions", {
    data: {
      accountId: account.id,
      categoryId: null,
      date: "2099-06-18",
      payee: "Self transfer",
      memo: "",
      amount: -50,
      transferAccountId: account.id,
    },
  });
  expect(res.status()).toBe(400);
  await ctx.dispose();
});
