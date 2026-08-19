// apps/web/tests/e2e/duplicates.spec.ts
//
// E2E for the duplicate analysis API (apps/web/src/app/api/duplicates/route.ts).
//
//   - POST /api/duplicates finds exact duplicates (same account, date,
//     amount, normalized payee/memo), flags the unflagged ones yellow,
//     and reports already-flagged / reconciled duplicates without
//     touching them.
//   - The analysis is idempotent: running it twice does not double-flag.
//
// Self-cleaning: it resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function resetToDemo() {
  const res = await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

test("POST /api/duplicates flags unflagged duplicates yellow", async ({ request }) => {
  await resetToDemo();

  const budget = await (await request.get("/api/budget")).json();
  const account =
    budget.accounts.find((a: { name: string }) => a.name === "EQ Bank") ??
    budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];
  expect(account?.id).toBeTruthy();

  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-15",
    payee: "Duplicate E2E Payee",
    memo: "",
    amount: -4321,
    cleared: true,
  };

  const first = await request.post("/api/transactions", { data: payload });
  expect(first.status()).toBe(200);
  const second = await request.post("/api/transactions", { data: payload });
  expect(second.status()).toBe(200);

  const res = await request.post("/api/duplicates");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.duplicateCount).toBe(1);
  expect(body.flaggedCount).toBe(1);
  expect(body.groups).toHaveLength(1);

  const after = await (await request.get("/api/budget")).json();
  const flagged = after.transactions.filter(
    (t: { payee: string }) => t.payee === "Duplicate E2E Payee"
  );
  expect(flagged).toHaveLength(2);
  expect(flagged.map((t: { flagColor: string | null }) => t.flagColor).sort()).toEqual([
    null,
    "yellow",
  ]);

  await resetToDemo();
});

test("POST /api/duplicates is idempotent", async ({ request }) => {
  await resetToDemo();

  const budget = await (await request.get("/api/budget")).json();
  const account =
    budget.accounts.find((a: { name: string }) => a.name === "EQ Bank") ??
    budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];

  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-16",
    payee: "Duplicate Idempotent Payee",
    memo: "",
    amount: -777,
    cleared: true,
  };
  await request.post("/api/transactions", { data: payload });
  await request.post("/api/transactions", { data: payload });

  const first = await (await request.post("/api/duplicates")).json();
  expect(first.flaggedCount).toBe(1);

  const second = await (await request.post("/api/duplicates")).json();
  expect(second.flaggedCount).toBe(0);
  expect(second.alreadyFlaggedCount).toBe(1);

  await resetToDemo();
});
