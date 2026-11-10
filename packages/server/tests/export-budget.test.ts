import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultDb, resetDefaultDb } from "../src/client.js";
import { exportBudgetCsv, exportBudgetJson, exportBudgetSqlite } from "../src/export-budget.js";
import * as schema from "../src/schema.js";

describe("export-budget", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-export-budget-"));
    vi.stubEnv("DATABASE_URL", path.join(tmpRoot, "budget.db"));
    resetDefaultDb();
  });

  afterEach(() => {
    resetDefaultDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seed() {
    const db = getDefaultDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    await db.insert(schema.transactions).values({
      accountId: account!.id,
      payee: "=cmd|'/C calc'!A0",
      memo: "@note",
      amount: -1795,
      date: "2026-09-06",
      flagColor: "red",
    });
    return account!;
  }

  it("csv neutralizes formula cells but keeps numeric amounts exact", async () => {
    await seed();
    const out = await exportBudgetCsv(getDefaultDb(), "2026-09-07");
    expect(out.contentType).toContain("text/csv");
    expect(out.filename).toBe("liquid-budget-2026-09-07.csv");
    const text = out.body as string;
    expect(text).toContain("Type,ID,AccountID,CategoryID,Date,Payee,Memo,Amount,Status,Flag,TransferAccountID,ParentID,IsIncome");
    expect(text).toContain("'=cmd");
    expect(text).toContain("'@note");
    expect(text).not.toMatch(/,=cmd/);
    // Negative amount stays a bare number (no injection prefix, still parseable).
    expect(text).toContain(",-17.95,");
    // Flag enum maps to the YNAB4 colour name.
    expect(text).toContain(",Red,");
  });

  it("json round-trips the budget payload", async () => {
    await seed();
    const out = await exportBudgetJson(getDefaultDb(), "2026-09-07");
    expect(out.contentType).toContain("application/json");
    expect(out.filename).toBe("liquid-budget-2026-09-07.json");
    const json = JSON.parse(out.body as string) as { accounts: Array<{ name: string }> };
    expect(json.accounts.map((a) => a.name)).toContain("Checking");
  });

  it("sqlite copy opens and contains seeded rows", async () => {
    await seed();
    const out = await exportBudgetSqlite(getDefaultDb(), "2026-09-07");
    expect(out.contentType).toContain("application/x-sqlite3");
    expect(out.filename).toBe("budget-2026-09-07.db");
    fs.writeFileSync(path.join(tmpRoot, "exported.db"), Buffer.from(out.body as Uint8Array));
    const exported = new Database(path.join(tmpRoot, "exported.db"), { readonly: true });
    try {
      const row = exported.prepare("SELECT payee FROM transactions LIMIT 1").get() as { payee: string };
      expect(row.payee).toBe("=cmd|'/C calc'!A0");
    } finally {
      exported.close();
    }
  });
});
