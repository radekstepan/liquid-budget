import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import { getBudgetData, isSeeded } from "../src/queries/budget.js";
import { createAccount, createTransaction } from "../src/index.js";
import { computeBudget, invalidateBudgetIndex } from "@ynab/logic";
import { createMockDb, type MockDb } from "./mock-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe("budget queries", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("getBudgetData issues 9 select queries in parallel", async () => {
    mock.respondWith("select:*", []);
    const callsBefore = mock.calls.length;
    await getBudgetData(mock.db);
    const newCalls = mock.calls.slice(callsBefore);
    const selects = newCalls.filter((c) => c.op === "select");
    expect(selects).toHaveLength(9);
    const tables = selects.map((c) => c.table).sort();
    expect(tables).toEqual(
      [
        "accounts",
        "assignments",
        "category_groups",
        "categories",
        "payees",
        "recurring",
        "recurring_sub_transactions",
        "rename_rules",
        "transactions",
      ].sort()
    );
  });

  it("getBudgetData returns the selected rows in the BudgetData shape", async () => {
    mock.respondWith("select:accounts", [{ id: 1, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: 10000, onBudget: true, sort: 0 }]);
    mock.respondWith("select:category_groups", [{ id: 1, name: "G", sort: 0, isCreditCardPayments: false }]);
    mock.respondWith("select:categories", []);
    mock.respondWith("select:assignments", []);
    mock.respondWith("select:transactions", []);
    mock.respondWith("select:recurring", []);
    mock.respondWith("select:recurring_sub_transactions", []);
    mock.respondWith("select:rename_rules", []);
    mock.respondWith("select:payees", []);

    const data = await getBudgetData(mock.db);
    expect(data.payees).toEqual([]);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]!.name).toBe("Checking");
    expect(data.groups).toHaveLength(1);
  });

  it("getBudgetData correctly associates recurring sub-transactions (UNI-48 / BUG-41)", async () => {
    mock.respondWith("select:accounts", []);
    mock.respondWith("select:category_groups", []);
    mock.respondWith("select:categories", []);
    mock.respondWith("select:assignments", []);
    mock.respondWith("select:transactions", []);
    mock.respondWith("select:recurring", [
      { id: 10, accountId: 1, categoryId: null, payee: "Costco", amount: -20000, frequency: "monthly", nextDate: "2026-08-01", active: true, transferAccountId: null },
    ]);
    mock.respondWith("select:recurring_sub_transactions", [
      { id: 1, recurringId: 10, categoryId: 5, transferAccountId: null, amount: -15000, memo: "Food", sort: 0 },
      { id: 2, recurringId: 10, categoryId: 6, transferAccountId: null, amount: -5000, memo: "Gas", sort: 1 },
      { id: 3, recurringId: 99, categoryId: 7, transferAccountId: null, amount: -1000, memo: "Other", sort: 0 },
    ]);

    const data = await getBudgetData(mock.db);
    expect(data.recurring).toHaveLength(1);
    expect(data.recurring[0]!.subTransactions).toHaveLength(2);
    expect(data.recurring[0]!.subTransactions[0]!.amount).toBe("-15000");
    expect(data.recurring[0]!.subTransactions[1]!.amount).toBe("-5000");
  });

  it("isSeeded issues a select count query", async () => {
    const result = await isSeeded(mock.db);
    expect(result).toBe(false);
    const selectCalls = mock.calls.filter((c) => c.op === "select");
    expect(selectCalls.length).toBeGreaterThanOrEqual(1);
  });

  // BUG-02: TBB and category available balances must reflect transaction
  // mutations across successive getBudgetData calls, without a full page
  // reload. Mirrors the web app flow: compute from the previous data snapshot,
  // invalidate it, then compute from a fresh snapshot after mutating.
  it("TBB and category available update after transaction mutations across getBudgetData calls (BUG-02)", async () => {
    const db = openMigratedDb();

    const acct = await createAccount(db, { name: "Checking", kind: "liquid" });
    const [group] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday", sort: 0 })
      .returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0 })
      .returning();

    await createTransaction(db, {
      accountId: acct.id,
      categoryId: null,
      date: "2026-08-01",
      payee: "Employer",
      memo: "Salary",
      amount: 50000, // $500
    });

    // First snapshot: index built and attached by getBudgetData
    const data1 = await getBudgetData(db);
    const res1 = computeBudget(data1, "2026-08");
    expect(res1.tbb).toBe(50000);
    expect(res1.groups[0]?.rows[0]?.available).toBe(0);

    await createTransaction(db, {
      accountId: acct.id,
      categoryId: cat!.id,
      date: "2026-08-15",
      payee: "Supermarket",
      memo: "Food",
      amount: -10000, // -$100
    });

    // Mimic BudgetAppShell.setData: invalidate the previous snapshot object
    invalidateBudgetIndex(data1);

    const data2 = await getBudgetData(db);
    const res2 = computeBudget(data2, "2026-08");
    expect(res2.tbb).toBe(50000); // expense does not change TBB
    expect(res2.groups[0]?.rows[0]?.outflow).toBe(-10000);
    expect(res2.groups[0]?.rows[0]?.available).toBe(-10000);

    db.$client.close();
  });
});
