// apps/web/tests/e2e/duplicates.spec.ts
//
// E2E for the duplicate analysis API (apps/web/src/app/api/duplicates/route.ts).
//
//   - POST /api/duplicates finds exact duplicates (same account, date,
//     amount, normalized payee/memo), marks the unflagged ones with the
//     internal "duplicate" flag, and reports already-flagged / reconciled
//     duplicates without touching them.
//   - The analysis is idempotent: running it twice does not double-mark.
//   - Re-running after a duplicate is removed clears the stale marker.
//
// Self-cleaning: it resets to the demo baseline around every test.
test.describe.configure({ mode: "serial" });
import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function resetToDemo() {
  const res = await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

test("POST /api/duplicates marks unflagged duplicates with the internal flag", async ({ request }) => {
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
  expect(new Set(flagged.map((t: { flagColor: string | null }) => t.flagColor))).toEqual(
    new Set([null, "duplicate"])
  );

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
  expect(second.clearedCount).toBe(0);

  await resetToDemo();
});

test("POST /api/duplicates clears the marker when only one transaction remains", async ({ request }) => {
  await resetToDemo();

  const budget = await (await request.get("/api/budget")).json();
  const account =
    budget.accounts.find((a: { name: string }) => a.name === "EQ Bank") ??
    budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];

  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-17",
    payee: "Duplicate Clear Payee",
    memo: "",
    amount: -555,
    cleared: true,
  };
  await request.post("/api/transactions", { data: payload });
  await request.post("/api/transactions", { data: payload });

  const first = await (await request.post("/api/duplicates")).json();
  expect(first.flaggedCount).toBe(1);

  const afterFirst = await (await request.get("/api/budget")).json();
  const dupRows = afterFirst.transactions.filter(
    (t: { payee: string }) => t.payee === "Duplicate Clear Payee"
  );
  expect(dupRows.filter((t: { flagColor: string | null }) => t.flagColor === "duplicate")).toHaveLength(1);

  // Delete the keeper (the unflagged row) — the flagged row is now unique.
  const keeperId = dupRows.find(
    (t: { flagColor: string | null }) => t.flagColor == null
  )!.id;
  const del = await request.delete(`/api/transactions?id=${keeperId}`);
  expect(del.status()).toBe(200);

  const second = await (await request.post("/api/duplicates")).json();
  expect(second.duplicateCount).toBe(0);
  expect(second.clearedCount).toBe(1);

  const afterSecond = await (await request.get("/api/budget")).json();
  const remaining = afterSecond.transactions.filter(
    (t: { payee: string }) => t.payee === "Duplicate Clear Payee"
  );
  expect(remaining).toHaveLength(1);
  expect(remaining[0].flagColor).toBeNull();

  await resetToDemo();
});

test("POST /api/duplicates leaves a manual yellow flag untouched", async ({ request }) => {
  await resetToDemo();

  const budget = await (await request.get("/api/budget")).json();
  const account =
    budget.accounts.find((a: { name: string }) => a.name === "EQ Bank") ??
    budget.accounts.find((a: { kind: string }) => a.kind === "liquid");
  const category = budget.categories[0];

  const payload = {
    accountId: account.id,
    categoryId: category.id,
    date: "2026-06-18",
    payee: "Duplicate Manual Yellow Payee",
    memo: "",
    amount: -321,
    cleared: true,
  };
  // Insert the unflagged row first so it becomes the keeper; the manual
  // yellow flag sits on the duplicate itself and must be left untouched.
  await request.post("/api/transactions", { data: payload });
  await request.post("/api/transactions", { data: { ...payload, flagColor: "yellow" } });

  const res = await (await request.post("/api/duplicates")).json();
  expect(res.flaggedCount).toBe(0);
  expect(res.alreadyFlaggedCount).toBe(1);

  const after = await (await request.get("/api/budget")).json();
  const flagged = after.transactions.filter(
    (t: { payee: string }) => t.payee === "Duplicate Manual Yellow Payee"
  );
  expect(new Set(flagged.map((t: { flagColor: string | null }) => t.flagColor))).toEqual(
    new Set([null, "yellow"])
  );

  await resetToDemo();
});
