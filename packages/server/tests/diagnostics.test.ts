import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  createAccount,
  createTransaction,
  createTransfer,
  createSplitWithChildren,
  verifyBalanceIntegrity,
  verifyBudgetIntegrity,
  recomputeAccountBalances,
  seedDatabase,
  getBudgetData,
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

describe("diagnostics queries", () => {
  let db: Db;

  beforeEach(() => {
    db = openMigratedDb();
  });

  describe("verifyBalanceIntegrity", () => {
    it("reports no issues for newly created accounts with standard transactions", async () => {
      const acct1 = await createAccount(db, { name: "Checking", kind: "liquid" });
      const acct2 = await createAccount(db, { name: "Savings", kind: "liquid" });

      await createTransaction(db, {
        accountId: acct1.id,
        categoryId: null,
        date: "2026-06-01",
        payee: "Employer",
        memo: "Direct Deposit",
        amount: 250000,
      });

      await createTransaction(db, {
        accountId: acct1.id,
        categoryId: null,
        date: "2026-06-02",
        payee: "Transfer to Savings",
        memo: "Savings transfer",
        amount: -50000,
        transferAccountId: acct2.id,
      });

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("handles split transactions correctly without double counting parent amount", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "General", sort: 0 }).returning();
      const [cat1] = await db.insert(schema.categories).values({ groupId: group.id, name: "Clothes", sort: 0 }).returning();
      const [cat2] = await db.insert(schema.categories).values({ groupId: group.id, name: "Household", sort: 1 }).returning();

      await createSplitWithChildren(
        db,
        {
          accountId: acct.id,
          date: "2026-06-01",
          payee: "Department Store",
          memo: "Clothing and Household",
          amount: -10000,
        },
        [
          { categoryId: cat1.id, amount: -6000, memo: "Clothes" },
          { categoryId: cat2.id, amount: -4000, memo: "Towels" },
        ]
      );

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("detects corrupted/drifted account balances", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });

      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-06-01",
        payee: "Deposit",
        memo: "",
        amount: 50000,
      });

      // Intentionally corrupt the account balance directly in SQLite
      await db
        .update(schema.accounts)
        .set({ balance: 99999 })
        .where(eq(schema.accounts.id, acct.id));

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        accountId: acct.id,
        accountName: "Checking",
        storedBalance: 99999,
        computedBalance: 50000,
        difference: 49999,
      });
    });

    it("reports zero issues for a freshly seeded database (BUG 6.1)", async () => {
      await seedDatabase(db);
      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });

    it("maintains balance integrity when creating accounts with starting balances (BUG 6.1)", async () => {
      const checking = await createAccount(db, { name: "Checking", kind: "liquid", balance: 100000 });
      const credit = await createAccount(db, { name: "Credit Card", kind: "credit", balance: -25000 });
      const offbudget = await createAccount(db, { name: "Investment", kind: "offbudget", balance: 500000, onBudget: false });

      expect(checking.balance).toBe(100000);
      expect(credit.balance).toBe(-25000);
      expect(offbudget.balance).toBe(500000);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });
  });

  describe("recomputeAccountBalances", () => {
    it("does not alter or destroy balances on a freshly seeded database (BUG 6.1)", async () => {
      await seedDatabase(db);
      const dataBefore = await getBudgetData(db);
      const result = await recomputeAccountBalances(db);
      expect(result.updatedCount).toBe(0);

      const dataAfter = await getBudgetData(db);
      expect(dataAfter.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })))
        .toEqual(dataBefore.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })));
    });

    it("repairs drifted balances back to computed transaction sums", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });

      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-06-01",
        payee: "Income",
        memo: "",
        amount: 120000,
      });

      // Drift the balance
      await db
        .update(schema.accounts)
        .set({ balance: 0 })
        .where(eq(schema.accounts.id, acct.id));

      let issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(1);

      const result = await recomputeAccountBalances(db);
      expect(result.updatedCount).toBe(1);

      issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);

      const [repaired] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, acct.id));
      expect(repaired?.balance).toBe(120000);
    });

    it("BUG-39: executes atomically inside a transaction and does not overwrite concurrent mutations with stale values", async () => {
      const acct = await createAccount(db, { name: "Checking", kind: "liquid" });

      await createTransaction(db, {
        accountId: acct.id,
        categoryId: null,
        date: "2026-06-01",
        payee: "Income",
        memo: "",
        amount: 50000,
      });

      // Drift the balance
      await db
        .update(schema.accounts)
        .set({ balance: 0 })
        .where(eq(schema.accounts.id, acct.id));

      // Run recomputeAccountBalances concurrently with adding a new transaction
      const [recomputeResult] = await Promise.all([
        recomputeAccountBalances(db),
        createTransaction(db, {
          accountId: acct.id,
          categoryId: null,
          date: "2026-06-02",
          payee: "Grocery",
          memo: "",
          amount: -10000,
        }),
      ]);

      expect(recomputeResult.updatedCount).toBeGreaterThanOrEqual(0);

      // Verify the final balance accurately reflects both transactions (50000 - 10000 = 40000)
      const [finalAcct] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, acct.id));
      expect(finalAcct?.balance).toBe(40000);

      const issues = await verifyBalanceIntegrity(db);
      expect(issues).toHaveLength(0);
    });
  });

  describe("verifyBudgetIntegrity", () => {
    it("maintains zero difference when transferring money from off-budget to on-budget (BUG 1.6)", async () => {
      const checking = await createAccount(db, { name: "Checking", kind: "liquid", onBudget: true });
      const brokerage = await createAccount(db, { name: "Brokerage", kind: "offbudget", onBudget: false });

      // Transfer $10,000 from off-budget Brokerage to on-budget Checking
      await createTransfer(
        db,
        {
          accountId: checking.id,
          categoryId: null,
          date: "2026-06-01",
          payee: "Transfer : Brokerage",
          memo: "Withdrawal",
          amount: 1000000,
        },
        brokerage.id
      );

      const report = await verifyBudgetIntegrity(db);
      expect(report.totalOnBudgetAccountBalance).toBe(1000000);
      expect(report.tbb).toBe(1000000);
      expect(report.totalCategoryAvailable).toBe(0);
      expect(report.difference).toBe(0);
    });

    it("does not false-positive on deferred income (BUG 6.2)", async () => {
      const checking = await createAccount(db, { name: "Checking", kind: "liquid", onBudget: true });

      // Paycheck received on 2026-08-30 deferred to 2026-09
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: null,
        date: "2026-08-30",
        payee: "Acme Corp",
        memo: "August Paycheck",
        amount: 300000,
        isIncome: true,
        incomeMonth: "2026-09",
      });

      const report = await verifyBudgetIntegrity(db);
      expect(report.totalOnBudgetAccountBalance).toBe(300000);
      expect(report.tbb).toBe(300000);
      expect(report.totalCategoryAvailable).toBe(0);
      expect(report.difference).toBe(0);
      expect(report.month >= "2026-09").toBe(true);
    });

    it("does not false-positive on future-dated transactions and assignments (BUG 6.2)", async () => {
      const checking = await createAccount(db, { name: "Checking", kind: "liquid", onBudget: true });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
      const [cat] = await db.insert(schema.categories).values({ groupId: group.id, name: "Rent", sort: 0 }).returning();

      // Opening deposit in August
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "",
        amount: 500000,
      });

      // Post-dated transaction in 2028-10
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: cat.id,
        date: "2028-10-01",
        payee: "Landlord",
        memo: "Future rent payment",
        amount: -200000,
      });

      // Future assignment in 2028-10
      await db.insert(schema.assignments).values({
        categoryId: cat.id,
        month: "2028-10",
        amount: 200000,
      });

      const report = await verifyBudgetIntegrity(db);
      expect(report.totalOnBudgetAccountBalance).toBe(300000);
      expect(report.totalCategoryAvailable).toBe(0);
      expect(report.tbb).toBe(300000);
      expect(report.difference).toBe(0);
      expect(report.month).toBe("2028-10");
    });

    it("handles explicit historical month before deferred and future-dated activity (BUG 6.2)", async () => {
      const checking = await createAccount(db, { name: "Checking", kind: "liquid", onBudget: true });
      const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
      const [cat] = await db.insert(schema.categories).values({ groupId: group.id, name: "Groceries", sort: 0 }).returning();

      // August 2026: Opening deposit of $5,000
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: null,
        date: "2026-08-01",
        payee: "Starting Balance",
        memo: "Opening balance",
        amount: 500000,
      });

      // August 2026: Assign $1,000 to Groceries
      await db.insert(schema.assignments).values({
        categoryId: cat.id,
        month: "2026-08",
        amount: 100000,
      });

      // August 2026: Paycheck received on 2026-08-30 of $3,000 deferred to 2026-09
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: null,
        date: "2026-08-30",
        payee: "Employer",
        memo: "August Paycheck",
        amount: 300000,
        isIncome: true,
        incomeMonth: "2026-09",
      });

      // Future activity: Post-dated expense in 2028-10 of -$2,000
      await createTransaction(db, {
        accountId: checking.id,
        categoryId: cat.id,
        date: "2028-10-01",
        payee: "Landlord",
        memo: "Future rent payment",
        amount: -200000,
      });

      // Future activity: Assignment in 2028-10 of $2,000
      await db.insert(schema.assignments).values({
        categoryId: cat.id,
        month: "2028-10",
        amount: 200000,
      });

      // Verify explicit historical month 2026-08
      const augReport = await verifyBudgetIntegrity(db, "2026-08");
      expect(augReport.month).toBe("2026-08");
      expect(augReport.totalOnBudgetAccountBalance).toBe(500000);
      expect(augReport.totalCategoryAvailable).toBe(100000);
      expect(augReport.tbb).toBe(400000);
      expect(augReport.difference).toBe(0);

      // Verify explicit month 2026-09 (when deferred income enters the budget)
      const sepReport = await verifyBudgetIntegrity(db, "2026-09");
      expect(sepReport.month).toBe("2026-09");
      expect(sepReport.totalOnBudgetAccountBalance).toBe(800000);
      expect(sepReport.totalCategoryAvailable).toBe(100000);
      expect(sepReport.tbb).toBe(700000);
      expect(sepReport.difference).toBe(0);

      // Verify default (latest month 2028-10)
      const latestReport = await verifyBudgetIntegrity(db);
      expect(latestReport.month).toBe("2028-10");
      expect(latestReport.totalOnBudgetAccountBalance).toBe(600000);
      expect(latestReport.totalCategoryAvailable).toBe(100000);
      expect(latestReport.tbb).toBe(500000);
      expect(latestReport.difference).toBe(0);
    });
  });
});
