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

test("Inspector Settings cog reveals Backup YNAB4 option and no CSV/JSON/SQLite options", async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);

  await page.getByTitle("Settings").click();
  await expect(page.getByText("Backup YNAB4")).toBeVisible();
  await expect(page.getByText("Export as CSV")).toBeHidden();
  await expect(page.getByText("Export as JSON")).toBeHidden();
  await expect(page.getByText("Backup SQLite DB")).toBeHidden();
});

test.describe("API /api/export contracts", () => {
  test("GET /api/export returns YNAB4 backup archive", async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get("/api/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/octet-stream");
    expect(res.headers()["content-disposition"]).toContain(".y4backup");

    const body = await res.body();
    expect(body.length).toBeGreaterThan(100);
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
