import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { eq } from "drizzle-orm";
import {
  getLatestCategoryByPayee,
  importCsvTransactions,
  MAX_CSV_IMPORT_ROWS,
} from "../src/import-csv.js";
import { createRenameRule } from "../src/queries/rename-rules.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

const row = (over: Partial<CsvImportRow>): CsvImportRow => ({
  rowNumber: 2,
  date: "2026-08-13",
  payee: "Store",
  memo: "",
  category: "",
  amountCents: -100,
  error: null,
  ...over,
});

/** Execution counters wired under drizzle (counts runs, not prepares). */
function instrument(raw: Database) {
  const counts = { txSelects: 0, accountUpdates: 0 };
  const origPrepare = raw.prepare.bind(raw);
  (raw as { prepare: unknown }).prepare = (sqlText: string, ...rest: unknown[]) => {
    const stmt = (origPrepare as (...a: unknown[]) => Record<string, unknown>)(sqlText, ...rest);
    const head = sqlText.trim().split(/\s+/)[0]?.toUpperCase();
    const isTxSelect = head === "SELECT" && sqlText.includes("transactions");
    const isAccountUpdate = head === "UPDATE" && sqlText.includes("accounts");
    if (isTxSelect || isAccountUpdate) {
      for (const method of ["all", "get", "run"] as const) {
        const orig = (stmt[method] as (...a: unknown[]) => unknown).bind(stmt);
        stmt[method] = (...args: unknown[]) => {
          if (isTxSelect) counts.txSelects++;
          else counts.accountUpdates++;
          return orig(...args);
        };
      }
    }
    return stmt;
  };
  return counts;
}

describe("importCsvTransactions perf (P1 csv-perf / bulk-cap)", () => {
  let raw: Database;
  let db: Db;
  let counts: { txSelects: number; accountUpdates: number };

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const drizzleDb = drizzle(raw, { schema });
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
    counts = instrument(raw);
    db = drizzleDb;
  });

  async function seedAccount(balance = 100000) {
    const [a] = await db
      .insert(schema.accounts)
      .values({ name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance, onBudget: true, sort: 0 })
      .returning();
    return a!.id;
  }

  async function seedGroup(): Promise<number> {
    const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
    return group!.id;
  }

  async function seedCategory(groupId: number, name: string): Promise<number> {
    const [cat] = await db.insert(schema.categories).values({ groupId, name, sort: 0 }).returning();
    return cat!.id;
  }

  it("issues one balance UPDATE for the whole import with the exact total", async () => {
    const accountId = await seedAccount();
    counts.txSelects = 0;
    counts.accountUpdates = 0;
    const result = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 1, payee: "A", amountCents: -100 }),
        row({ rowNumber: 2, payee: "B", amountCents: -200 }),
        row({ rowNumber: 3, payee: "C", amountCents: 500 }),
      ],
    });
    expect(result.count).toBe(3);
    expect(counts.accountUpdates).toBe(1);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
    expect(account!.balance).toBe(100000 - 100 - 200 + 500);
  });

  it("resolves every renamed row with one batched prior lookup (latest wins)", async () => {
    const accountId = await seedAccount();
    const groupId = await seedGroup();
    const groceries = await seedCategory(groupId, "Groceries");
    const dining = await seedCategory(groupId, "Dining");
    // Two categorized priors for the same clean payee: newer date wins.
    await db.insert(schema.transactions).values([
      { accountId, categoryId: groceries, date: "2026-07-01", payee: "Whole Foods", amount: -100 },
      { accountId, categoryId: dining, date: "2026-08-01", payee: "Whole Foods", amount: -200 },
    ]);
    await createRenameRule(db, { sourcePattern: "WHL", targetPayee: "Whole Foods", operator: "contains" });
    await createRenameRule(db, { sourcePattern: "TRD", targetPayee: "Trader Joes", operator: "contains" });

    counts.txSelects = 0;
    counts.accountUpdates = 0;
    const result = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 1, payee: "WHL #1", amountCents: -10 }),
        row({ rowNumber: 2, payee: "WHL #2", amountCents: -20 }),
        row({ rowNumber: 3, payee: "WHL #3", amountCents: -30 }),
        row({ rowNumber: 4, payee: "TRD #1", amountCents: -40 }),
        row({ rowNumber: 5, payee: "TRD #2", amountCents: -50 }),
      ],
    });
    expect(result.count).toBe(5);
    // Existing-fingerprints scan + one batched prior scan; the old code
    // issued one prior SELECT per renamed row (5 here).
    expect(counts.txSelects).toBe(2);
    expect(counts.accountUpdates).toBe(1);

    const stored = await db
      .select({ payee: schema.transactions.payee, categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.status, "u"));
    expect(stored).toHaveLength(5);
    for (const s of stored) {
      if (s.payee === "Whole Foods") expect(s.categoryId).toBe(dining);
      else expect(s.categoryId).toBeNull();
    }
  });

  it("getLatestCategoryByPayee returns the newest category per payee", async () => {
    const accountId = await seedAccount();
    const groupId = await seedGroup();
    const g = await seedCategory(groupId, "G");
    const d = await seedCategory(groupId, "D");
    await db.insert(schema.transactions).values([
      { accountId, categoryId: g, date: "2026-06-01", payee: "P", amount: -1 },
      { accountId, categoryId: d, date: "2026-08-01", payee: "P", amount: -1 },
      { accountId, categoryId: g, date: "2026-08-02", payee: "Q", amount: -1 },
    ]);
    expect(await getLatestCategoryByPayee(db, [])).toEqual(new Map());
    const latest = await getLatestCategoryByPayee(db, ["P", "Q", "Missing"]);
    expect(latest.get("P")).toBe(d);
    expect(latest.get("Q")).toBe(g);
    expect(latest.has("Missing")).toBe(false);
  });

  it("rejects imports over the row cap with 413", async () => {
    expect(MAX_CSV_IMPORT_ROWS).toBe(1000);
    const accountId = await seedAccount();
    const rows = Array.from({ length: MAX_CSV_IMPORT_ROWS + 1 }, (_, i) =>
      row({ rowNumber: i + 1, payee: `Payee ${i}`, amountCents: -100 })
    );
    await expect(importCsvTransactions(db, { accountId, rows })).rejects.toMatchObject({
      name: "TransactionError",
      status: 413,
    });
    // At exactly the cap the import proceeds.
    const ok = await importCsvTransactions(db, { accountId, rows: rows.slice(0, MAX_CSV_IMPORT_ROWS) });
    expect(ok.count).toBe(MAX_CSV_IMPORT_ROWS);
  });

  it("skipped-only imports issue no balance UPDATE", async () => {
    const accountId = await seedAccount();
    counts.accountUpdates = 0;
    const result = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 1, payee: "", amountCents: -100 })],
    });
    expect(result.count).toBe(0);
    expect(counts.accountUpdates).toBe(0);
  });
});
