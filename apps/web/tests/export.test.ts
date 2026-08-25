import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { extractYnab4DataFromZip, getDefaultDb, resetDatabase, seedDatabase } from "@ynab/server";
import { GET } from "../src/app/api/export/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("GET /api/export", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetDatabase(db);
    await seedDatabase(db);
  }, 20000);

  it("exports YNAB4 backup archive (.y4backup) by default", async () => {
    const req = new NextRequest("http://localhost:3000/api/export");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain(".y4backup");

    const arrayBuf = await res.arrayBuffer();
    expect(arrayBuf.byteLength).toBeGreaterThan(100);

    const extracted = extractYnab4DataFromZip(arrayBuf);
    expect(extracted.ynabData).toBeDefined();
    expect(extracted.settingsXml).toBeDefined();
    expect(extracted.ynabData.accounts.length).toBeGreaterThan(0);
    expect(extracted.ynabData.transactions.length).toBeGreaterThan(0);
  });

  it("exports CSV with formatted dollar amounts (not raw cents)", async () => {
    const req = new NextRequest("http://localhost:3000/api/export?format=csv");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(".csv");

    const text = await res.text();
    expect(text).toContain("Type,ID,Name,Kind,Group,Balance,On Budget,Archived");
    expect(text).toContain("Type,ID,AccountID,CategoryID,Date,Payee,Memo,Amount,Status,Flag,TransferAccountID,ParentID,IsIncome");

    // Ensure dollar formatting with decimal point (e.g., "0.00" or numbers like "123.45", "-50.00")
    // and verify no raw integer cent format is leaking without decimals in money columns.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const txLines = lines.filter((l) => l.startsWith("Transaction,"));
    expect(txLines.length).toBeGreaterThan(0);
    for (const line of txLines) {
      const parts = line.split(",");
      const amountField = parts[7]; // Amount column
      expect(amountField).toMatch(/^-?\d+\.\d{2}$/);
    }

    const acctLines = lines.filter((l) => l.startsWith("Account,"));
    expect(acctLines.length).toBeGreaterThan(0);
    for (const line of acctLines) {
      const parts = line.split(",");
      const balField = parts[5]; // Balance column
      expect(balField).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it("exports JSON budget data", async () => {
    const req = new NextRequest("http://localhost:3000/api/export?format=json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const json = await res.json();
    expect(json.accounts).toBeDefined();
    expect(json.transactions).toBeDefined();
  });

  it("exports SQLite DB binary", async () => {
    const req = new NextRequest("http://localhost:3000/api/export?format=sqlite");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-sqlite3");
    const arrayBuf = await res.arrayBuffer();
    expect(arrayBuf.byteLength).toBeGreaterThan(0);
  });
});

