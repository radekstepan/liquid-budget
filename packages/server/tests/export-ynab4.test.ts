import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { exportYnab4, exportYnab4Zip } from "../src/export-ynab4.js";
import { extractYnab4DataFromZip, importYnab4, recomputeAccountBalances } from "../src/import-ynab4.js";
import { seedDatabase } from "../src/seed.js";
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

describe("exportYnab4 & exportYnab4Zip", () => {
  it("exports seeded database into valid YNAB4 structure", async () => {
    const db = openMigratedDb();
    await seedDatabase(db);

    const { ynabData, settingsXml } = await exportYnab4(db, {
      budgetName: "Test Export Budget",
      currencySymbol: "$",
      currencyISOSymbol: "USD",
    });

    expect(ynabData).toBeDefined();
    expect(ynabData.budgetMetaData).toBeDefined();
    expect(ynabData.accounts.length).toBeGreaterThan(0);
    expect(ynabData.masterCategories.length).toBeGreaterThan(0);
    expect(ynabData.transactions.length).toBeGreaterThan(0);
    expect(ynabData.payees.length).toBeGreaterThan(0);

    // Verify settings XML
    expect(settingsXml).toContain("<budgetName>Test Export Budget</budgetName>");
    expect(settingsXml).toContain("<currencySymbol>$</currencySymbol>");
    expect(settingsXml).toContain("<currencyISOSymbol>USD</currencyISOSymbol>");
  });

  it("exports as zip buffer and is extractable with extractYnab4DataFromZip", async () => {
    const db = openMigratedDb();
    await seedDatabase(db);

    const zipBuffer = await exportYnab4Zip(db, { budgetName: "Zip Test Budget" });
    expect(Buffer.isBuffer(zipBuffer)).toBe(true);
    expect(zipBuffer.byteLength).toBeGreaterThan(100);

    const extracted = extractYnab4DataFromZip(zipBuffer);
    expect(extracted.ynabData).toBeDefined();
    expect(extracted.settingsXml).toBeDefined();
    expect(extracted.settings?.budgetName).toBe("Zip Test Budget");
  });

  it("performs a flawless round-trip: DB1 -> export YNAB4 zip -> import into DB2 -> identical budget state", async () => {
    const db1 = openMigratedDb();
    await seedDatabase(db1);

    // Also add a custom split transaction with transfer child and an overspending category
    const [grp] = await db1.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.isCreditCardPayments, false)).limit(1);
    const [cat] = await db1.insert(schema.categories).values({
      groupId: grp!.id,
      name: "Special Projects",
      sort: 99,
      carryover: 0,
      overspendCarriesOver: true,
    }).returning();

    const [accChecking] = await db1.select().from(schema.accounts).where(eq(schema.accounts.kind, "liquid")).limit(1);
    const [accSavings] = await db1.select().from(schema.accounts).where(eq(schema.accounts.kind, "liquid")).offset(1).limit(1);

    // Insert assignment
    await db1.insert(schema.assignments).values({
      categoryId: cat!.id,
      month: "2026-05",
      amount: 15000,
    });

    // Insert split transaction: -200 total -> -50 Special Projects + -150 transfer to Savings
    const [parentTx] = await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: null,
      date: "2026-05-10",
      payee: "Hardware Store",
      memo: "Split parent memo",
      amount: -20000,
      status: "c",
      flagColor: "blue",
      parentId: null,
    }).returning();

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-05-10",
      payee: "Hardware Store",
      memo: "Materials",
      amount: -5000,
      status: "c",
      parentId: parentTx!.id,
    });

    if (accSavings) {
      await db1.insert(schema.transactions).values({
        accountId: accChecking!.id,
        categoryId: null,
        transferAccountId: accSavings.id,
        date: "2026-05-10",
        payee: `Transfer : ${accSavings.name}`,
        memo: "Transfer part",
        amount: -15000,
        status: "c",
        parentId: parentTx!.id,
      });
    }

    await recomputeAccountBalances(db1);

    const initialData1 = await getBudgetData(db1);

    // Export DB1 to zip
    const zipBuffer = await exportYnab4Zip(db1, { budgetName: "Round Trip Budget" });

    // Import into fresh DB2
    const db2 = openMigratedDb();
    const { ynabData, settingsXml } = extractYnab4DataFromZip(zipBuffer);
    const importSummary = await importYnab4(db2, ynabData, settingsXml);

    expect(importSummary.accounts).toBe(initialData1.accounts.length);

    const data2 = await getBudgetData(db2);

    // 1. Accounts comparison
    expect(data2.accounts.length).toBe(initialData1.accounts.length);
    for (const a1 of initialData1.accounts) {
      const a2 = data2.accounts.find((a) => a.name === a1.name);
      expect(a2).toBeDefined();
      expect(a2!.kind).toBe(a1.kind);
      expect(a2!.onBudget).toBe(a1.onBudget);
      expect(Number(a2!.balance)).toBe(Number(a1.balance));
    }

    // 2. Categories & Overspending handling
    const roundTripCat = data2.categories.find((c) => c.name === "Special Projects");
    expect(roundTripCat).toBeDefined();
    expect(roundTripCat!.overspendCarriesOver).toBe(true);

    // 3. Assignments comparison
    const a2Assignment = data2.assignments.find((a) => a.categoryId === roundTripCat!.id && a.month === "2026-05");
    expect(a2Assignment).toBeDefined();
    expect(Number(a2Assignment!.amount)).toBe(15000);

    // 4. Split transaction parent & children
    const rParent = data2.transactions.find((t) => t.memo === "Split parent memo");
    expect(rParent).toBeDefined();
    expect(Number(rParent!.amount)).toBe(-20000);
    expect(rParent!.flagColor).toBe("blue");

    const rChildren = data2.transactions.filter((t) => t.parentId === rParent!.id);
    expect(rChildren.length).toBe(accSavings ? 2 : 1);
  });
});
