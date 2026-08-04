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
