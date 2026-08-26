import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createRecurringTransaction,
  createSplitWithChildren,
  createTransaction,
  createTransfer,
  postRecurringTransaction,
  upsertAssignment,
  withTransaction,
  TransactionError,
} from "../src/index.js";

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

describe("SQLite transaction concurrency & serialization", () => {
  let db: Db;

  beforeEach(() => {
    db = openMigratedDb();
  });

  it("handles 25 concurrent createTransaction calls on a single connection without transaction errors", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 0, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Living" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Groceries" });

    const amounts = Array.from({ length: 25 }, (_, i) => -(i + 1) * 100);
    const totalExpectedDelta = amounts.reduce((sum, a) => sum + a, 0);

    const promises = amounts.map((amt, idx) =>
      createTransaction(db, {
        accountId: acct.id,
        categoryId: cat.id,
        date: "2026-07-01",
        payee: `Store ${idx}`,
        memo: `Memo ${idx}`,
        amount: amt,
      })
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(25);

    // Verify account balance
    const [updatedAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(updatedAcct?.balance).toBe(totalExpectedDelta);

    // Verify count of transactions
    const txRows = await db.select().from(schema.transactions).where(eq(schema.transactions.accountId, acct.id));
    expect(txRows).toHaveLength(25);
  });

  it("handles mixed concurrent mutations (create, transfer, split, assignment, group)", async () => {
    const acct1 = await createAccount(db, { name: "Account 1", balance: 100000, onBudget: true });
    const acct2 = await createAccount(db, { name: "Account 2", balance: 50000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Main Group" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Dining" });

    const tasks = [
      // 1. Plain transaction
      createTransaction(db, {
        accountId: acct1.id,
        categoryId: cat.id,
        date: "2026-07-02",
        payee: "Cafe",
        amount: -1500,
      }),
      // 2. Transfer between accounts
      createTransfer(db, {
        accountId: acct1.id,
        transferAccountId: acct2.id,
        date: "2026-07-02",
        amount: -5000,
      }),
      // 3. Split transaction
      createSplitWithChildren(
        db,
        {
          accountId: acct1.id,
          date: "2026-07-02",
          payee: "Supermarket",
          amount: -3000,
        },
        [
          { categoryId: cat.id, amount: -2000, memo: "Food" },
          { categoryId: cat.id, amount: -1000, memo: "Household" },
        ]
      ),
      // 4. Budget assignment
      upsertAssignment(db, {
        categoryId: cat.id,
        month: "2026-07",
        amount: 25000,
      }),
      // 5. Another category group
      createCategoryGroup(db, { name: "Savings" }),
    ];

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(5);

    // Verify Account 1 balance:
    // starting: 100,000
    // starting balance transaction row created by createAccount (+100,000)
    // tx 1: -1,500
    // tx 2 (transfer): -5,000
    // tx 3 (split): -3,000
    // Total = 100,000 - 1,500 - 5,000 - 3,000 = 90,500
    const [freshAcct1] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct1.id));
    expect(freshAcct1?.balance).toBe(90500);

    // Account 2 balance: 50,000 + 5,000 = 55,000
    const [freshAcct2] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct2.id));
    expect(freshAcct2?.balance).toBe(55000);
  });

  it("isolates rollbacks when some concurrent mutations fail", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 10000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Essentials" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Rent" });

    const validPromises = [
      createTransaction(db, { accountId: acct.id, categoryId: cat.id, date: "2026-07-01", payee: "Valid 1", amount: -1000 }),
      createTransaction(db, { accountId: acct.id, categoryId: cat.id, date: "2026-07-01", payee: "Valid 2", amount: -2000 }),
      createTransaction(db, { accountId: acct.id, categoryId: cat.id, date: "2026-07-01", payee: "Valid 3", amount: -3000 }),
    ];

    const invalidPromises = [
      // Invalid: Transfer to same account throws TransactionError
      createTransfer(db, { accountId: acct.id, transferAccountId: acct.id, date: "2026-07-01", amount: -1000 }),
      // Invalid: NaN amount throws TransactionError
      createTransaction(db, { accountId: acct.id, categoryId: cat.id, date: "2026-07-01", payee: "Invalid 2", amount: NaN }),
    ];

    const all = [...validPromises, ...invalidPromises].map((p) =>
      p.then(
        (val) => ({ status: "fulfilled" as const, value: val }),
        (err) => ({ status: "rejected" as const, reason: err })
      )
    );

    const settled = await Promise.all(all);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    for (const r of rejected) {
      expect((r as any).reason).toBeInstanceOf(TransactionError);
    }

    // Balance should accurately reflect starting 10,000 - 1,000 - 2,000 - 3,000 = 4,000
    const [freshAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(freshAcct?.balance).toBe(4000);
  });

  it("handles re-entrant nested transactions via savepoints and allows inner rollback", async () => {
    const acct = await createAccount(db, { name: "Savings", balance: 0, onBudget: true });

    await withTransaction(db, async () => {
      // Step 1: Insert row 1
      await db.insert(schema.transactions).values({
        accountId: acct.id,
        date: "2026-07-01",
        payee: "Step 1",
        amount: 1000,
        status: "c",
        memo: "",
        categoryId: null,
      });

      // Step 2: Nested transaction that throws
      try {
        await withTransaction(db, async () => {
          await db.insert(schema.transactions).values({
            accountId: acct.id,
            date: "2026-07-01",
            payee: "Step 2 (should fail)",
            amount: 2000,
            status: "c",
            memo: "",
            categoryId: null,
          });
          throw new Error("Inner transaction failure");
        });
      } catch (innerErr) {
        expect((innerErr as Error).message).toBe("Inner transaction failure");
      }

      // Step 3: Insert row 3
      await db.insert(schema.transactions).values({
        accountId: acct.id,
        date: "2026-07-01",
        payee: "Step 3",
        amount: 3000,
        status: "c",
        memo: "",
        categoryId: null,
      });
    });

    const txRows = await db.select().from(schema.transactions).where(eq(schema.transactions.accountId, acct.id));
    const payees = txRows.map((t) => t.payee);
    expect(payees).toContain("Step 1");
    expect(payees).not.toContain("Step 2 (should fail)");
    expect(payees).toContain("Step 3");
  });

  it("correctly executes postRecurringTransaction concurrently with other mutations", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 50000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Monthly Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Gym" });

    const rec = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Gym Membership",
      amount: -5000,
      frequency: "monthly",
      nextDate: "2026-07-01",
    });

    const concurrentTasks = [
      postRecurringTransaction(db, rec.id),
      createTransaction(db, {
        accountId: acct.id,
        categoryId: cat.id,
        date: "2026-07-01",
        payee: "Protein Shake",
        amount: -800,
      }),
    ];

    const results = await Promise.all(concurrentTasks);
    expect(results).toHaveLength(2);

    // Verify next date on recurring
    const [updatedRec] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec.id));
    expect(updatedRec?.nextDate).toBe("2026-08-01");

    // Balance: 50,000 - 5,000 - 800 = 44,200
    const [freshAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(freshAcct?.balance).toBe(44200);
  });
});
