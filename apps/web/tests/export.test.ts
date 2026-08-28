import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { extractYnab4DataFromZip, exportYnab4Zip, getDefaultDb, resetAndSeedDatabase, transactions } from "@ynab/server";
import { GET } from "../src/app/api/export/route";
import { POST as importPOST } from "../src/app/api/import/route";
import { POST as importCsvPOST } from "../src/app/api/import/csv/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("GET /api/export", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
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

  it("can feed multi-section CSV export back to /api/import/csv without error (BUG-50)", async () => {
    const exportReq = new NextRequest("http://localhost:3000/api/export?format=csv");
    const exportRes = await GET(exportReq);
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();

    const importReq = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: 1,
        swap: false,
        csv,
      }),
    });
    const importRes = await importCsvPOST(importReq);
    expect(importRes.status).toBe(200);
    const json = await importRes.json();
    expect(json.ok).toBe(true);
    expect(json.imported).toBeGreaterThanOrEqual(0);
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

  it("exports SQLite DB binary including newest writes (BUG-29)", async () => {
    const db = getDefaultDb();
    await db.insert(transactions).values({
      accountId: 1,
      categoryId: null,
      date: "2026-06-25",
      payee: "Brand New WAL Write",
      memo: "Checking WAL flush",
      amount: -12345,
      status: "c",
    });

    const req = new NextRequest("http://localhost:3000/api/export?format=sqlite");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-sqlite3");
    const arrayBuf = await res.arrayBuffer();
    expect(arrayBuf.byteLength).toBeGreaterThan(0);

    const exportedSqlite = new Database(Buffer.from(arrayBuf));
    const row = exportedSqlite
      .prepare("SELECT * FROM transactions WHERE payee = ?")
      .get("Brand New WAL Write") as { payee: string; amount: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.amount).toBe(-12345);
    exportedSqlite.close();
  });
});

describe("POST /api/import", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  }, 20000);

  it("extracts and passes settingsXml, returning parsed settings in summary (BUG-49)", async () => {
    const db = getDefaultDb();
    const zipBuffer = await exportYnab4Zip(db, {
      budgetName: "My Custom & Saved Budget",
      currencySymbol: "£",
    });

    const file = new File([new Uint8Array(zipBuffer)], "budget.y4backup", {
      type: "application/octet-stream",
    });

    const formData = new FormData();
    formData.append("file", file);

    const req = new NextRequest("http://localhost:3000/api/import", {
      method: "POST",
      body: formData,
    });

    const res = await importPOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.summary).toBeDefined();
    expect(json.summary.settings).toBeDefined();
    expect(json.summary.settings.budgetName).toBe("My Custom & Saved Budget");
    expect(json.summary.settings.currencySymbol).toBe("£");
  });
});

