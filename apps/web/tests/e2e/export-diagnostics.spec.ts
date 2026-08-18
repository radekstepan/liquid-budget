// apps/web/tests/e2e/export-diagnostics.spec.ts
//
// Covers Data Export and Diagnostics features:
//   - Settings menu export items (Inspector.tsx:150-176)
//   - /api/export endpoint (CSV, JSON, SQLite DB)
//   - /api/diagnostics/balance-integrity (GET verification & POST repair)
//   - /api/diagnostics/budget-integrity (GET budget reconciliation audit)
import { test, expect, request as apiRequest, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

test("Inspector Settings cog reveals all export and backup options", async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Export as CSV")).toBeVisible();
  await expect(page.getByText("Export as JSON")).toBeVisible();
  await expect(page.getByText("Backup SQLite DB")).toBeVisible();
});

test.describe("API /api/export contracts", () => {
  test("GET /api/export returns full budget CSV export", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get("/api/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const text = await res.text();
    // Headers for various budget sections
    expect(text).toContain("Account,");
    expect(text).toContain("Category,");
    expect(text).toContain("Transaction,");
    expect(text).toContain("Assignment,");
    expect(text).toContain("Recurring,");
    await ctx.dispose();
  });

  test("GET /api/export?format=json returns complete budget JSON payload", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get("/api/export?format=json");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");

    const body = await res.json();
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(Array.isArray(body.assignments)).toBe(true);
    expect(Array.isArray(body.recurring)).toBe(true);
    await ctx.dispose();
  });

  test("GET /api/export?format=sqlite returns binary SQLite database", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get("/api/export?format=sqlite");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/x-sqlite3");

    const body = await res.body();
    // SQLite header starts with "SQLite format 3\0"
    expect(body.length).toBeGreaterThan(100);
    const header = body.subarray(0, 15).toString("utf-8");
    expect(header).toBe("SQLite format 3");
    await ctx.dispose();
  });
});

test.describe("API /api/diagnostics contracts", () => {
  test("GET & POST /api/diagnostics/balance-integrity reports and repairs balance consistency", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const getRes = await ctx.get("/api/diagnostics/balance-integrity");
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();
    expect(getBody).toHaveProperty("ok");
    expect(getBody).toHaveProperty("issueCount");
    expect(Array.isArray(getBody.issues)).toBe(true);

    const postRes = await ctx.post("/api/diagnostics/balance-integrity");
    expect(postRes.status()).toBe(200);
    const postBody = await postRes.json();
    expect(postBody).toHaveProperty("ok");
    expect(postBody).toHaveProperty("repairedCount");
    expect(Array.isArray(postBody.remainingIssues)).toBe(true);
    await ctx.dispose();
  });

  test("GET /api/diagnostics/budget-integrity reports budget equation health", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get("/api/diagnostics/budget-integrity");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("difference");
    await ctx.dispose();
  });
});
