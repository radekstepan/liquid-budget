import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { GET as budgetGET } from "../src/app/api/diagnostics/budget-integrity/route";
import {
  GET as balanceGET,
  POST as balancePOST,
} from "../src/app/api/diagnostics/balance-integrity/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("diagnostics storage integrity (P2 operational)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("GET /api/diagnostics/budget-integrity surfaces PRAGMA integrity_check as storage", async () => {
    const res = await budgetGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("difference");
    expect(body.storage).toEqual({ ok: true, errors: [] });
    expect(body.ok).toBe(body.difference === 0);
  });

  it("GET /api/diagnostics/balance-integrity surfaces PRAGMA integrity_check as storage", async () => {
    const res = await balanceGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("issueCount");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.storage).toEqual({ ok: true, errors: [] });
    expect(body.ok).toBe(body.issueCount === 0);
  });

  it("POST /api/diagnostics/balance-integrity repair reports storage too", async () => {
    const res = await balancePOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("repairedCount");
    expect(Array.isArray(body.remainingIssues)).toBe(true);
    expect(body.storage).toEqual({ ok: true, errors: [] });
    expect(body.ok).toBe(true);
  });
});
