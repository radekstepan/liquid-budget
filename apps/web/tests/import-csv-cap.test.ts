import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createAccount, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { POST } from "../src/app/api/import/csv/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("POST /api/import/csv row cap (P1 bulk-cap)", () => {
  beforeEach(async () => {
    await resetAndSeedDatabase(getDefaultDb());
  });

  it("rejects imports over 1000 rows with 413", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    const lines = ["Date,Payee,Amount"];
    for (let i = 0; i < 1001; i++) {
      lines.push(`2026-08-01,Payee ${i},-1.00`);
    }
    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account!.id, csv: lines.join("\n") }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toMatch(/1000 rows/);
  });
});
