import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { detectMilliunitScale, importYnab4 } from "../src/import-ynab4.js";
import { getBudgetData } from "../src/queries/budget.js";
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

describe("BUG-04: detectMilliunitScale and import scaling", () => {
  describe("detectMilliunitScale heuristic", () => {
    it("detects decimal dollars when fractional amounts exist", () => {
      const data = {
        transactions: [
          { amount: 45.25 },
          { amount: 100 },
        ],
      };
      expect(detectMilliunitScale(data)).toBe(false);
    });

    it("detects decimal dollars for whole-dollar budget containing everyday dollar amounts alongside large amounts", () => {
      const data = {
        budgetMetaData: { entityId: "budget-metadata" },
        accounts: [{ entityId: "acc-1", entityVersion: "acc-v-1", accountName: "Checking" }],
        transactions: [
          { amount: 15000 }, // $15,000 house repair
          { amount: 2000 },  // $2,000 rent
          { amount: 45 },    // $45 groceries
        ],
      };
      expect(detectMilliunitScale(data)).toBe(false);
    });

    it("detects milliunits for app export signature with milliunit amounts (BUG-05)", () => {
      const data = {
        budgetMetaData: { entityId: "budget-metadata" },
        accounts: [{ entityId: "acc-1", entityVersion: "acc-v-1", accountName: "Checking" }],
        transactions: [
          { amount: 150000 }, // $150.00 in milliunits
          { amount: 20000 },  // $20.00 in milliunits
        ],
      };
      expect(detectMilliunitScale(data)).toBe(true);
    });

    it("detects decimal dollars for whole-dollar budget containing everyday dollar amounts (< 1000)", () => {
      const data = {
        transactions: [
          { amount: 15 }, // $15 lunch
          { amount: 45 }, // $45 groceries
          { amount: 120 }, // $120 utility
          { amount: 15000 }, // $15,000 house downpayment
        ],
      };
      // In milliunits, 15 and 45 would be 1.5 cents and 4.5 cents.
      expect(detectMilliunitScale(data)).toBe(false);
    });

    it("detects milliunits for stock YNAB4 backup where all amounts are under $1,000", () => {
      const data = {
        accounts: [{ entityId: "acc1", lastReconciledBalance: 500000 }], // $500.00
        transactions: [
          { amount: -45000 },  // -$45.00 dinner
          { amount: -12500 },  // -$12.50 lunch
          { amount: -3990 },   // -$3.99 coffee/snack
          { amount: 300000 },  // $300.00 small paycheck
        ],
        monthlyBudgets: [
          {
            monthlySubCategoryBudgets: [
              { budgeted: 50000 }, // $50.00 budgeted
            ],
          },
        ],
      };
      expect(detectMilliunitScale(data)).toBe(true);
    });

    it("detects milliunits for standard stock YNAB4 backup with large amounts", () => {
      const data = {
        transactions: [
          { amount: -45250 },   // -$45.25
          { amount: 2500000 },  // $2,500.00
          { amount: -120000 },  // -$120.00
        ],
      };
      expect(detectMilliunitScale(data)).toBe(true);
    });
  });

  describe("importYnab4 integration scaling", () => {
    let db: Db;
    beforeEach(() => {
      db = openMigratedDb();
    });

    it("correctly imports small-amount stock YNAB4 backup without 100x magnification", async () => {
      const stockSmallBackup = {
        accounts: [
          { entityId: "acc-1", accountName: "Checking", accountType: "Checking", onBudget: true },
        ],
        payees: [
          { entityId: "p-1", name: "Restaurant" },
          { entityId: "p-2", name: "Job" },
        ],
        masterCategories: [
          {
            entityId: "mc-1",
            name: "Living",
            type: "OUTFLOW",
            subCategories: [{ entityId: "sc-1", name: "Dining" }],
          },
        ],
        transactions: [
          {
            entityId: "t-1",
            accountId: "acc-1",
            date: "2026-06-01",
            amount: 500000, // $500.00 income in milliunits
            cleared: "Cleared",
            payeeId: "p-2",
            categoryId: "Category/__ImmediateIncome__",
          },
          {
            entityId: "t-2",
            accountId: "acc-1",
            date: "2026-06-02",
            amount: -45000, // -$45.00 dinner in milliunits
            cleared: "Cleared",
            payeeId: "p-1",
            categoryId: "sc-1",
          },
        ],
        monthlyBudgets: [
          {
            month: "2026-06-01",
            monthlySubCategoryBudgets: [
              { categoryId: "sc-1", budgeted: 100000 }, // $100.00 in milliunits
            ],
          },
        ],
      };

      await importYnab4(db, stockSmallBackup);
      const budget = await getBudgetData(db);

      // Income was $500.00 = 50000 cents (not $50,000.00 = 5000000 cents)
      const incomeTx = budget.transactions.find((t) => t.payee === "Job");
      expect(Number(incomeTx?.amount)).toBe(50000);

      // Dining was -$45.00 = -4500 cents (not -$4,500.00 = -450000 cents)
      const diningTx = budget.transactions.find((t) => t.payee === "Restaurant");
      expect(Number(diningTx?.amount)).toBe(-4500);

      // Account balance = $500 - $45 = $455.00 = 45500 cents
      const checking = budget.accounts.find((a) => a.name === "Checking");
      expect(Number(checking?.balance)).toBe(45500);

      // Assignment = $100.00 = 10000 cents
      expect(budget.assignments).toHaveLength(1);
      expect(Number(budget.assignments[0]?.amount)).toBe(10000);
    });

    it("correctly imports whole-dollar decimal budget containing small amounts", async () => {
      const decimalBackup = {
        budgetMetaData: { entityId: "budget-metadata" },
        accounts: [
          { entityId: "acc-1", entityVersion: "acc-v-1", accountName: "Checking", accountType: "Checking", onBudget: true },
        ],
        payees: [
          { entityId: "p-1", name: "Downpayment" },
          { entityId: "p-2", name: "Lunch" },
        ],
        masterCategories: [
          {
            entityId: "mc-1",
            name: "Housing",
            type: "OUTFLOW",
            subCategories: [{ entityId: "sc-1", name: "House" }, { entityId: "sc-2", name: "Food" }],
          },
        ],
        transactions: [
          {
            entityId: "t-1",
            accountId: "acc-1",
            date: "2026-06-01",
            amount: 25000, // $25,000.00 in decimal dollars
            cleared: "Cleared",
            payeeId: "p-1",
            categoryId: "sc-1",
          },
          {
            entityId: "t-2",
            accountId: "acc-1",
            date: "2026-06-02",
            amount: 15, // $15.00 lunch (identifies file as decimal dollars)
            cleared: "Cleared",
            payeeId: "p-2",
            categoryId: "sc-2",
          },
        ],
        monthlyBudgets: [
          {
            month: "2026-06-01",
            monthlySubCategoryBudgets: [
              { categoryId: "sc-1", budgeted: 25000 }, // $25,000.00 in decimal dollars
              { categoryId: "sc-2", budgeted: 15 },
            ],
          },
        ],
      };

      await importYnab4(db, decimalBackup);
      const budget = await getBudgetData(db);

      // Transaction amount = $25,000.00 = 2,500,000 cents
      const tx = budget.transactions.find((t) => t.payee === "Downpayment");
      expect(Number(tx?.amount)).toBe(2500000);

      const tx2 = budget.transactions.find((t) => t.payee === "Lunch");
      expect(Number(tx2?.amount)).toBe(1500);

      // Assignment amount = $25,000.00 = 2,500,000 cents
      const assign = budget.assignments.find((a) => Number(a.amount) === 2500000);
      expect(assign).toBeDefined();
    });
  });
});
