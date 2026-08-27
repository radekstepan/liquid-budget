import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { importCsvTransactions } from "../src/import-csv.js";
import { getBudgetData } from "../src/queries/budget.js";
import { eq, sql } from "drizzle-orm";
import { TransactionError, createSplitWithChildren, createTransfer } from "../src/queries/transactions.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

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

const row = (over: Partial<CsvImportRow>): CsvImportRow => ({
  rowNumber: 2,
  date: "2026-08-13",
  payee: "Store",
  memo: "",
  category: "",
  amountCents: -2808,
  error: null,
  ...over,
});

describe("importCsvTransactions", () => {
  let db: Db;

  beforeEach(() => {
    db = openMigratedDb();
  });

  async function seedAccount(balance = 100000) {
    const [a] = await db
      .insert(schema.accounts)
      .values({
        name: "Chequing",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance,
        onBudget: true,
        sort: 0,
      })
      .returning();
    return a!.id;
  }

  it("inserts transactions and updates the account balance", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "Store", amountCents: -2808 }),
        row({ rowNumber: 3, payee: "Employer", amountCents: 50000 }),
      ],
    });
    expect(out.count).toBe(2);

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(2);
    expect(data.transactions.find((t) => t.payee === "Store")?.amount).toBe("-2808");
    expect(data.transactions.find((t) => t.payee === "Employer")?.amount).toBe("50000");
    expect(data.accounts.find((a) => a.id === accountId)?.balance).toBe(
      String(100000 - 2808 + 50000)
    );
  });

  it("imports a slice of the sample bank export after CSV conversion", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({
          rowNumber: 2,
          date: "2026-08-13",
          payee: "PHNOM PENH RESTAURANT   VANCOUVER",
          amountCents: -2808,
        }),
        row({
          rowNumber: 3,
          date: "2026-08-13",
          payee: "UBER TRIP               TORONTO",
          amountCents: -1863,
        }),
        row({
          rowNumber: 22,
          date: "2026-08-03",
          payee: "PAYMENT RECEIVED - THANK YOU",
          amountCents: 190803,
        }),
        row({
          rowNumber: 44,
          date: "2026-07-21",
          payee: "PAYPAL *EBAY CA         0015125826083",
          amountCents: 1231,
        }),
      ],
    });
    expect(out.count).toBe(4);

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(4);
    const byPayee = (p: string) => data.transactions.find((t) => t.payee === p);
    const restaurant = byPayee("PHNOM PENH RESTAURANT   VANCOUVER");
    expect(restaurant?.amount).toBe("-2808");
    expect(restaurant?.date).toBe("2026-08-13");
    expect(restaurant?.status).toBe("c");
    expect(byPayee("PAYMENT RECEIVED - THANK YOU")?.amount).toBe("190803");
    expect(byPayee("PAYPAL *EBAY CA         0015125826083")?.amount).toBe("1231");
    expect(data.accounts.find((a) => a.id === accountId)?.balance).toBe(
      String(100000 - 2808 - 1863 + 190803 + 1231)
    );
  });

  it("marks positive uncategorized on-budget rows as income", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "Employer", amountCents: 50000 })],
    });
    const data = await getBudgetData(db);
    expect(data.transactions[0]!.isIncome).toBe(true);
  });

  it("does not mark positive categorized rows as income", async () => {
    const accountId = await seedAccount();
    const [g] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday", sort: 0, isCreditCardPayments: false })
      .returning();
    await db.insert(schema.categories).values({
      groupId: g!.id,
      name: "Income",
      sort: 0,
      carryover: 0,
      goalTarget: null,
      linkedAccountId: null,
      overspendCarriesOver: false,
    });
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "Employer", category: "Income", amountCents: 50000 })],
    });
    const data = await getBudgetData(db);
    expect(data.transactions[0]!.isIncome).toBe(false);
  });

  it("resolves category names case-insensitively", async () => {
    const accountId = await seedAccount();
    const [g] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday", sort: 0, isCreditCardPayments: false })
      .returning();
    await db.insert(schema.categories).values({
      groupId: g!.id,
      name: "Groceries",
      sort: 0,
      carryover: 0,
      goalTarget: null,
      linkedAccountId: null,
      overspendCarriesOver: false,
    });
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ category: "groceries" })],
    });
    const data = await getBudgetData(db);
    const catId = data.categories.find((c) => c.name === "Groceries")?.id;
    expect(data.transactions[0]!.categoryId).toBe(catId);
  });

  it("leaves unmatched category names uncategorized", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ category: "Does Not Exist" })],
    });
    const data = await getBudgetData(db);
    expect(data.transactions[0]!.categoryId).toBeNull();
  });

  it("partially imports valid rows and skips invalid or zero amount rows (BUG-32)", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "Good", amountCents: -1000 }),
        row({ rowNumber: 3, payee: "Bad", amountCents: 0 }),
      ],
    });
    expect(out.count).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({
      rowNumber: 3,
      payee: "Bad",
      reason: "Amount is zero",
    });

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]!.payee).toBe("Good");
    expect(data.accounts[0]!.balance).toBe(String(100000 - 1000));
  });

  it("skips rows with blank or whitespace-only payees (BUG-31)", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "Valid Payee", amountCents: -1000 }),
        row({ rowNumber: 3, payee: "", amountCents: -2000 }),
        row({ rowNumber: 4, payee: "   ", amountCents: -3000 }),
      ],
    });
    expect(out.count).toBe(1);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped[0]).toMatchObject({
      rowNumber: 3,
      reason: "Missing payee",
    });
    expect(out.skipped[1]).toMatchObject({
      rowNumber: 4,
      reason: "Missing payee",
    });

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]!.payee).toBe("Valid Payee");
  });

  it("rejects a missing account with 404", async () => {
    await expect(
      importCsvTransactions(db, { accountId: 999, rows: [] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("skips duplicate rows within the same file and keeps the first", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "Store", amountCents: -1000 }),
        row({ rowNumber: 3, payee: "Store", amountCents: -1000 }),
        row({ rowNumber: 4, payee: "Other", amountCents: -2000 }),
      ],
    });
    expect(out.count).toBe(2);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({
      rowNumber: 3,
      payee: "Store",
      amount: -1000,
      reason: "Duplicate of row 2 in this file",
      accountName: "Chequing",
    });

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(2);
    expect(data.accounts.find((a) => a.id === accountId)?.balance).toBe(
      String(100000 - 1000 - 2000)
    );
  });

  it("skips rows that duplicate existing transactions without double-counting balance", async () => {
    const accountId = await seedAccount();
    const first = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "Store", amountCents: -1000 })],
    });
    expect(first.count).toBe(1);

    const second = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "Store", amountCents: -1000 })],
    });
    expect(second.count).toBe(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe("Matches an existing transaction");

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(1);
    expect(data.accounts.find((a) => a.id === accountId)?.balance).toBe(String(100000 - 1000));
  });

  it("normalizes whitespace/case when comparing payee and memo", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "  PHNOM PENH   RESTAURANT ", memo: " Lunch " })],
    });
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "phnom penh restaurant", memo: "lunch" })],
    });
    expect(out.count).toBe(0);
    expect(out.skipped).toHaveLength(1);
  });

  it("reports errored and invalid rows in skipped instead of silently dropping them", async () => {
    const accountId = await seedAccount();
    const out = await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "Valid Store", amountCents: -1000 }),
        row({ rowNumber: 3, payee: "Zero Row", error: "Amount is zero", amountCents: 0 }),
        row({ rowNumber: 4, payee: "Bad Date", error: "Invalid date", date: null }),
        row({ rowNumber: 5, payee: "Bad Amount", error: "Invalid amount", amountCents: null }),
      ],
    });
    expect(out.count).toBe(1);
    expect(out.skipped).toHaveLength(3);
    expect(out.skipped[0]).toMatchObject({
      rowNumber: 3,
      payee: "Zero Row",
      amount: 0,
      reason: "Amount is zero",
      accountName: "Chequing",
    });
    expect(out.skipped[1]).toMatchObject({
      rowNumber: 4,
      payee: "Bad Date",
      reason: "Invalid date",
      accountName: "Chequing",
    });
    expect(out.skipped[2]).toMatchObject({
      rowNumber: 5,
      payee: "Bad Amount",
      reason: "Invalid amount",
      accountName: "Chequing",
    });

    const data = await getBudgetData(db);
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]!.payee).toBe("Valid Store");
  });

  it("skips re-import of a transaction that was converted to a split (BUG-21)", async () => {
    const accountId = await seedAccount();
    const [g] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday", sort: 0, isCreditCardPayments: false })
      .returning();
    const [c1] = await db
      .insert(schema.categories)
      .values({ groupId: g!.id, name: "Groceries", sort: 0, carryover: 0 })
      .returning();
    const [c2] = await db
      .insert(schema.categories)
      .values({ groupId: g!.id, name: "Household", sort: 1, carryover: 0 })
      .returning();

    // 1. Initial import of bank row
    const first = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "Costco", amountCents: -5000, memo: "Weekly run" })],
    });
    expect(first.count).toBe(1);

    // 2. Delete plain row and recreate as split with children (simulates user converting it)
    const initialData = await getBudgetData(db);
    const plainTx = initialData.transactions[0]!;
    await db.delete(schema.transactions).where(eq(schema.transactions.id, plainTx.id));
    await db
      .update(schema.accounts)
      .set({ balance: sql`${schema.accounts.balance} - ${Number(plainTx.amount)}` })
      .where(eq(schema.accounts.id, accountId));

    await createSplitWithChildren(
      db,
      {
        accountId,
        date: "2026-08-13",
        payee: "Costco",
        memo: "Weekly run",
        amount: -5000,
      },
      [
        { categoryId: c1!.id, amount: -3000, memo: "Food" },
        { categoryId: c2!.id, amount: -2000, memo: "Household" },
      ]
    );

    // 3. Re-import statement containing the same row
    const second = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "Costco", amountCents: -5000, memo: "Weekly run" })],
    });
    expect(second.count).toBe(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe("Matches an existing transaction");

    // Balance should remain unchanged (100000 - 5000 = 95000)
    const afterData = await getBudgetData(db);
    expect(afterData.accounts.find((a) => a.id === accountId)?.balance).toBe("95000");
  });

  it("skips re-import of a transaction that was converted to a transfer (BUG-21)", async () => {
    const accountId = await seedAccount();
    const [savings] = await db
      .insert(schema.accounts)
      .values({
        name: "Savings",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 50000,
        onBudget: true,
        sort: 1,
      })
      .returning();

    // 1. Create a transfer from accountId to savings
    await createTransfer(
      db,
      {
        accountId,
        transferAccountId: savings!.id,
        date: "2026-08-13",
        payee: "Transfer : Savings",
        memo: "Monthly savings",
        amount: -20000,
        categoryId: null,
      },
      savings!.id
    );

    // 2. Re-import statement on source account (Chequing)
    const sourceImport = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "Transfer : Savings", memo: "Monthly savings", amountCents: -20000 })],
    });
    expect(sourceImport.count).toBe(0);
    expect(sourceImport.skipped).toHaveLength(1);
    expect(sourceImport.skipped[0]!.reason).toBe("Matches an existing transaction");

    // 3. Re-import statement on destination account (Savings)
    const destImport = await importCsvTransactions(db, {
      accountId: savings!.id,
      rows: [row({ rowNumber: 2, payee: "Transfer : Chequing", memo: "Monthly savings", amountCents: 20000 })],
    });
    expect(destImport.count).toBe(0);
    expect(destImport.skipped).toHaveLength(1);
    expect(destImport.skipped[0]!.reason).toBe("Matches an existing transaction");
  });
});
