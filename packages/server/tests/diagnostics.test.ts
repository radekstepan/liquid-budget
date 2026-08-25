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
  });
});
