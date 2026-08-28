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
  autoPostDueRecurringTransactions,
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
  RecurringError,
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

  it("prevents duplicate ledger rows on concurrent postRecurringTransaction for the same occurrence (BUG-04)", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 10000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Subscriptions" });

    const rec = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Streaming Service",
      amount: -1500,
      frequency: "monthly",
      nextDate: "2026-07-01",
    });

    // Launch two simultaneous postRecurringTransaction calls for the same occurrence date
    const [res1, res2] = await Promise.allSettled([
      postRecurringTransaction(db, rec.id, "2026-07-01"),
      postRecurringTransaction(db, rec.id, "2026-07-01"),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    // Exactly one should succeed, and one should fail with 409 conflict
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "RecurringError",
      status: 409,
    });

    // Verify exactly ONE non-starting transaction was created for the recurring post
    const txRows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acct.id));
    // 1 starting balance row + 1 posted recurring row = 2 total
    expect(txRows).toHaveLength(2);
    const postedTx = txRows.find((t) => t.payee === "Streaming Service");
    expect(postedTx).toBeDefined();
    expect(postedTx?.amount).toBe(-1500);

    // Balance: 10,000 - 1,500 = 8,500 (NOT double-deducted)
    const [freshAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(freshAcct?.balance).toBe(8500);

    // Schedule should be advanced exactly once
    const [freshRec] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec.id));
    expect(freshRec?.nextDate).toBe("2026-08-01");
  });

  it("prevents double execution on concurrent postRecurringTransaction for one-off transactions (BUG-04)", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 10000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Repairs" });

    const rec = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Plumber",
      amount: -8000,
      frequency: "never",
      nextDate: "2026-07-01",
    });

    // Launch two simultaneous postRecurringTransaction calls
    const [res1, res2] = await Promise.allSettled([
      postRecurringTransaction(db, rec.id),
      postRecurringTransaction(db, rec.id),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "RecurringError",
      status: 400,
      message: "Recurring transaction is inactive",
    });

    // Verify exactly ONE transaction was created
    const txRows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acct.id));
    expect(txRows).toHaveLength(2);

    // Balance: 10,000 - 8,000 = 2,000
    const [freshAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(freshAcct?.balance).toBe(2000);

    // Rec should now be inactive
    const [freshRec] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec.id));
    expect(freshRec?.active).toBe(false);
  });

  it("rejects postRecurringTransaction on inactive recurring rows (BUG-04)", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 10000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Gym" });

    const rec = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Old Gym",
      amount: -3000,
      frequency: "monthly",
      nextDate: "2026-07-01",
      active: false,
    });

    await expect(
      postRecurringTransaction(db, rec.id)
    ).rejects.toMatchObject({
      name: "RecurringError",
      message: "Recurring transaction is inactive",
      status: 400,
    });

    // Verify no transaction was created
    const txRows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acct.id));
    // Only starting balance row
    expect(txRows).toHaveLength(1);
    expect(txRows[0]?.payee).toBe("Starting Balance");
  });

  it("isolates failures per item during autoPostDueRecurringTransactions (BUG-01) so valid items post and invalid items are deactivated", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 50000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Services" });

    // Item 1: Valid
    const rec1 = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Valid Bill 1",
      amount: -1000,
      frequency: "monthly",
      nextDate: "2026-07-01",
    });

    // Item 2: Invalid (corrupted: transfer destination is same as source)
    const [rec2] = await db
      .insert(schema.recurring)
      .values({
        accountId: acct.id,
        categoryId: null,
        payee: "Invalid Transfer",
        memo: "",
        amount: -2000,
        frequency: "monthly",
        nextDate: "2026-07-01",
        anchorDay: 1,
        active: true,
        transferAccountId: acct.id, // invalid: same account
      })
      .returning();

    // Item 3: Valid
    const rec3 = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Valid Bill 3",
      amount: -3000,
      frequency: "monthly",
      nextDate: "2026-07-01",
    });

    // Auto-posting due items should succeed without throwing
    const posted = await autoPostDueRecurringTransactions(db, "2026-07-05");

    // Valid items (rec1 and rec3) posted successfully
    expect(posted).toHaveLength(2);
    expect((posted as any).failures).toHaveLength(1);
    expect((posted as any).failures[0]?.id).toBe(rec2!.id);

    // Verify transactions in the account (starting balance + rec1 + rec3 = 3 rows)
    const txRows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acct.id));
    expect(txRows).toHaveLength(3);

    // Account balance reflects valid items: 50000 - 1000 - 3000 = 46000
    const [freshAcct] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acct.id));
    expect(freshAcct?.balance).toBe(46000);

    // Schedules of rec1 and rec3 were advanced to 2026-08-01
    const [freshRec1] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec1.id));
    expect(freshRec1?.nextDate).toBe("2026-08-01");
    const [freshRec3] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec3.id));
    expect(freshRec3?.nextDate).toBe("2026-08-01");

    // Corrupted rule rec2 was deactivated
    const [freshRec2] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec2!.id));
    expect(freshRec2?.active).toBe(false);
  });

  it("BUG-04: concurrent autoPostDueRecurringTransactions on same due rule keeps active=true and posts only once", async () => {
    const acct = await createAccount(db, { name: "Checking", balance: 100000, onBudget: true });
    const grp = await createCategoryGroup(db, { name: "Bills" });
    const cat = await createCategory(db, { groupId: grp.id, name: "Rent" });

    const rec = await createRecurringTransaction(db, {
      accountId: acct.id,
      categoryId: cat.id,
      payee: "Monthly Rent",
      amount: -50000,
      frequency: "monthly",
      nextDate: "2026-08-01",
    });

    // Fire two concurrent auto-post calls simulating two browser tabs
    const results = await Promise.allSettled([
      autoPostDueRecurringTransactions(db, "2026-08-15"),
      autoPostDueRecurringTransactions(db, "2026-08-15"),
    ]);

    // Both calls should succeed (no unhandled rejection)
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    // Exactly one transaction was posted (not two)
    const txRows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acct.id));
    // Starting balance + one rent transaction = 2 rows
    expect(txRows).toHaveLength(2);

    // Rule is still active
    const [freshRec] = await db.select().from(schema.recurring).where(eq(schema.recurring.id, rec.id));
    expect(freshRec?.active).toBe(true);

    // Rule's nextDate was advanced
    expect(freshRec?.nextDate).toBe("2026-09-01");

    // Combined posted count is exactly 1
    const totalPosted = results.reduce(
      (sum, r) => sum + (r.status === "fulfilled" ? (r.value as any[]).length : 0),
      0
    );
    expect(totalPosted).toBe(1);

    // At most one failure recorded (the loser's 409)
    const totalFailures = results.reduce(
      (sum, r) =>
        sum +
        (r.status === "fulfilled" ? ((r.value as any).failures || []).length : 0),
      0
    );
    expect(totalFailures).toBeLessThanOrEqual(1);
  });
});

