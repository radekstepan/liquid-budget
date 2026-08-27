import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createAccount, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { POST } from "../src/app/api/import/csv/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("POST /api/import/csv", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("rejects structurally invalid CSV header with 400", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account!.id,
        swap: false,
        csv: "Col1,Col2,Col3\n1,2,3\n",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Could not find/);
  });

  it("BUG-32: imports valid rows and returns skipped invalid rows in partial import", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    const csv = [
      "Date,Payee,Amount",
      "2026-08-01,Valid Store,-10.00",
      "2026-08-02,Bad Amount,invalid_amt",
      "invalid-date,Another Store,-15.00",
      "2026-08-03,Zero Store,0.00",
      "2026-08-04,Another Valid Store,25.00",
    ].join("\n");

    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account!.id,
        swap: false,
        csv,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.imported).toBe(2);
    expect(json.skipped).toHaveLength(3);

    const reasons = json.skipped.map((s: { reason: string }) => s.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Invalid amount/),
        expect.stringMatching(/Invalid date/),
        expect.stringMatching(/Amount is zero/),
      ])
    );
  });

  it("BUG-31: skips blank payee rows when swap is enabled with empty memo", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    const csv = [
      "Date,Payee,Memo,Amount",
      "2026-08-01,Store,, -10.00", // Memo is empty -> becomes blank payee upon swap
      "2026-08-02,,Real Merchant,-20.00", // Payee is empty -> becomes valid payee upon swap
    ].join("\n");

    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account!.id,
        swap: true,
        csv,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.imported).toBe(1);
    expect(json.skipped).toHaveLength(1);
    expect(json.skipped[0].rowNumber).toBe(2);
    expect(json.skipped[0].reason).toMatch(/Missing payee/);
  });

  it("BUG-51: rejects CSV with unclosed quotes with 400 and clear line error", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    const csv = [
      "Date,Payee,Amount",
      '2026-08-01,"Store without closing quote,-10.00',
    ].join("\n");

    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account!.id,
        swap: false,
        csv,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Unclosed quote in CSV on line 2");
  });
});
