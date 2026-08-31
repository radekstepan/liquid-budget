import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, isNotNull } from "drizzle-orm";
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
      flagColor: "red",
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
        flagColor: "green",
        parentId: parentTx!.id,
      });
    }

    // Insert deferred income transactions (BUG-18):
    // 1. Regular transaction dated June with income deferred to September (3 months out)
    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: null,
      date: "2026-06-15",
      payee: "Quarterly Bonus",
      memo: "Deferred 3 months",
      amount: 75000,
      status: "c",
      isIncome: true,
      incomeMonth: "2026-09",
    });

    // 2. Split transaction with a child deferred to October (BUG-18)
    const [splitIncomeParent] = await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: null,
      date: "2026-06-20",
      payee: "Consulting LLC",
      memo: "Split consulting payout",
      amount: 50000,
      status: "c",
    }).returning();

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: null,
      date: "2026-06-20",
      payee: "Consulting LLC",
      memo: "October portion",
      amount: 30000,
      status: "c",
      parentId: splitIncomeParent!.id,
      isIncome: true,
      incomeMonth: "2026-10",
    });

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-06-20",
      payee: "Consulting LLC",
      memo: "Reimbursed supplies",
      amount: 20000,
      status: "c",
      parentId: splitIncomeParent!.id,
    });

    // Insert scheduled transactions (BUG-17):
    // 1. Paused / inactive scheduled transaction with memo, flag, and 'never' frequency
    await db1.insert(schema.recurring).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      payee: "Paused Subscription",
      memo: "Gym pause for summer",
      flagColor: "red",
      amount: -4500,
      frequency: "never",
      nextDate: "2026-09-01",
      anchorDay: 1,
      active: false,
    });

    // 2. Active scheduled transaction with 'never' frequency, memo, and flag
    await db1.insert(schema.recurring).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      payee: "One-Off Future Tax",
      memo: "Estimated payment",
      flagColor: "orange",
      amount: -120000,
      frequency: "never",
      nextDate: "2026-09-15",
      anchorDay: 15,
      active: true,
    });

    // BUG-17: CC Payment category assignment & carryover
    const [ccCat] = await db1.select().from(schema.categories).where(isNotNull(schema.categories.linkedAccountId)).limit(1);
    if (ccCat) {
      await db1.update(schema.categories).set({ carryover: 50000 }).where(eq(schema.categories.id, ccCat.id));
      await db1.insert(schema.assignments).values({
        categoryId: ccCat.id,
        month: "2026-05",
        amount: 25000,
      });
    }

    // BUG-17: Cross-boundary transfer with category
    const [accOffBudget] = await db1.insert(schema.accounts).values({
      name: "Investment Portfolio",
      kind: "offbudget",
      groupLabel: "Tracking Accounts",
      onBudget: false,
      balance: 500000,
    }).returning();

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      transferAccountId: accOffBudget!.id,
      date: "2026-05-18",
      payee: `Transfer : ${accOffBudget!.name}`,
      memo: "Contribution to investments",
      amount: -10000,
      status: "c",
    });

    // BUG-17: Multiple reconciliation rounds and transaction links
    const [rec1] = await db1.insert(schema.reconciliations).values({
      accountId: accChecking!.id,
      reconciledAt: "2026-04-30",
      statementDate: "2026-04-30",
      statementBalance: 100000,
    }).returning();

    const [rec2] = await db1.insert(schema.reconciliations).values({
      accountId: accChecking!.id,
      reconciledAt: "2026-05-31",
      statementDate: "2026-05-31",
      statementBalance: 150000,
    }).returning();

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-04-25",
      payee: "April Reconciled Vendor",
      memo: "Round 1 tx",
      amount: -2500,
      status: "r",
      reconciliationId: rec1!.id,
      reconciledAt: "2026-04-30",
    });

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-05-25",
      payee: "May Reconciled Vendor",
      memo: "Round 2 tx",
      amount: -3500,
      status: "r",
      reconciliationId: rec2!.id,
      reconciledAt: "2026-05-31",
    });

    // BUG-17: Split child with distinct child payees
    const [multiPayeeSplitParent] = await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: null,
      date: "2026-05-28",
      payee: "Department Store Parent",
      memo: "Shopping mall spree",
      amount: -10000,
      status: "c",
    }).returning();

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-05-28",
      payee: "Electronics Boutique",
      memo: "Headphones",
      amount: -4000,
      status: "c",
      parentId: multiPayeeSplitParent!.id,
    });

    await db1.insert(schema.transactions).values({
      accountId: accChecking!.id,
      categoryId: cat!.id,
      date: "2026-05-28",
      payee: "Clothing Outlet",
      memo: "Shirt",
      amount: -6000,
      status: "c",
      parentId: multiPayeeSplitParent!.id,
    });

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

    // BUG-17: CC Payment category assignment & carryover preserved
    if (ccCat) {
      const roundTripCcCat = data2.categories.find((c) => c.linkedAccountId != null);
      expect(roundTripCcCat).toBeDefined();
      expect(Number(roundTripCcCat!.carryover)).toBe(50000);
      const ccAssignment2 = data2.assignments.find((a) => a.categoryId === roundTripCcCat!.id && a.month === "2026-05");
      expect(ccAssignment2).toBeDefined();
      expect(Number(ccAssignment2!.amount)).toBe(25000);
    }

    // BUG-17: Cross-boundary transfer category preserved
    const boundaryTransfer2 = data2.transactions.find((t) => t.memo === "Contribution to investments");
    expect(boundaryTransfer2).toBeDefined();
    expect(boundaryTransfer2!.categoryId).toBe(roundTripCat!.id);

    // BUG-17: Reconciliations roundtrip and transaction links preserved
    const db2Reconciliations = await db2.select().from(schema.reconciliations);
    expect(db2Reconciliations.length).toBeGreaterThanOrEqual(2);
    const round1Tx = data2.transactions.find((t) => t.memo === "Round 1 tx");
    const round2Tx = data2.transactions.find((t) => t.memo === "Round 2 tx");
    expect(round1Tx).toBeDefined();
    expect(round1Tx!.status).toBe("r");
    expect(round1Tx!.reconciliationId).toBeDefined();
    expect(round2Tx).toBeDefined();
    expect(round2Tx!.status).toBe("r");
    expect(round2Tx!.reconciliationId).toBeDefined();
    expect(round1Tx!.reconciliationId).not.toBe(round2Tx!.reconciliationId);

    // BUG-17: Split child payees preserved
    const mallParent = data2.transactions.find((t) => t.memo === "Shopping mall spree");
    expect(mallParent).toBeDefined();
    const mallChildren = data2.transactions.filter((t) => t.parentId === mallParent!.id);
    expect(mallChildren).toHaveLength(2);
    const elecChild = mallChildren.find((c) => c.memo === "Headphones");
    const clothChild = mallChildren.find((c) => c.memo === "Shirt");
    expect(elecChild).toBeDefined();
    expect(elecChild!.payee).toBe("Electronics Boutique");
    expect(clothChild).toBeDefined();
    expect(clothChild!.payee).toBe("Clothing Outlet");

    // 4. Split transaction parent & children
    const rParent = data2.transactions.find((t) => t.memo === "Split parent memo");
    expect(rParent).toBeDefined();
    expect(Number(rParent!.amount)).toBe(-20000);
    expect(rParent!.flagColor).toBe("blue");

    const rChildren = data2.transactions.filter((t) => t.parentId === rParent!.id);
    expect(rChildren.length).toBe(accSavings ? 2 : 1);
    const rChild1 = rChildren.find((t) => t.memo === "Materials");
    expect(rChild1).toBeDefined();
    expect(rChild1!.flagColor).toBe("red");
    if (accSavings) {
      const rChildTransfer = rChildren.find((t) => t.memo === "Transfer part");
      expect(rChildTransfer).toBeDefined();
      expect(rChildTransfer!.flagColor).toBe("green");
    }

    // 5. Deferred income preservation (BUG-18)
    const rDeferredTx = data2.transactions.find((t) => t.payee === "Quarterly Bonus");
    expect(rDeferredTx).toBeDefined();
    expect(rDeferredTx!.isIncome).toBe(true);
    expect(rDeferredTx!.date).toBe("2026-06-15");
    expect(rDeferredTx!.incomeMonth).toBe("2026-09");
    expect(Number(rDeferredTx!.amount)).toBe(75000);
    expect(rDeferredTx!.memo).toBe("Deferred 3 months");

    const rSplitChildDeferred = data2.transactions.find((t) => t.memo === "October portion");
    expect(rSplitChildDeferred).toBeDefined();
    expect(rSplitChildDeferred!.isIncome).toBe(true);
    expect(rSplitChildDeferred!.incomeMonth).toBe("2026-10");
    expect(Number(rSplitChildDeferred!.amount)).toBe(30000);

    // 6. Scheduled transaction metadata & inactive state preservation (BUG-17)
    const rPausedSched = data2.recurring.find((r) => r.payee === "Paused Subscription");
    expect(rPausedSched).toBeDefined();
    expect(rPausedSched!.active).toBe(false);
    expect(rPausedSched!.memo).toBe("Gym pause for summer");
    expect(rPausedSched!.flagColor).toBe("red");
    expect(rPausedSched!.frequency).toBe("never");
    expect(rPausedSched!.nextDate).toBe("2026-09-01");
    expect(rPausedSched!.anchorDay).toBe(1);
    expect(Number(rPausedSched!.amount)).toBe(-4500);

    const rActiveOneOff = data2.recurring.find((r) => r.payee === "One-Off Future Tax");
    expect(rActiveOneOff).toBeDefined();
    expect(rActiveOneOff!.active).toBe(true);
    expect(rActiveOneOff!.memo).toBe("Estimated payment");
    expect(rActiveOneOff!.flagColor).toBe("orange");
    expect(rActiveOneOff!.frequency).toBe("never");
    expect(rActiveOneOff!.nextDate).toBe("2026-09-15");
    expect(rActiveOneOff!.anchorDay).toBe(15);
    expect(Number(rActiveOneOff!.amount)).toBe(-120000);
  });

  it("exports scheduled transaction fields with correct format and metadata (BUG-17)", async () => {
    const db = openMigratedDb();
    const [acc] = await db.insert(schema.accounts).values({
      name: "Checking",
      kind: "liquid",
      groupLabel: "Cash",
      balance: 100000,
    }).returning();

    await db.insert(schema.recurring).values({
      accountId: acc!.id,
      payee: "One-Off Electrician",
      memo: "Fix breaker panel",
      flagColor: "purple",
      amount: -15000,
      frequency: "never",
      nextDate: "2026-09-20",
      anchorDay: 20,
      active: false,
    });

    const { ynabData } = await exportYnab4(db);
    expect(ynabData.scheduledTransactions).toHaveLength(1);
    const sched = ynabData.scheduledTransactions[0];
    expect(sched.frequency).toBe("Never");
    expect(sched.memo).toBe("Fix breaker panel");
    expect(sched.flag).toBe("Purple");
    expect(sched.isTombstone).toBe(false);
    expect(sched.active).toBe(false);
    expect(sched.anchorDay).toBe(20);
    expect(sched.amount).toBe(-150);
  });

  it("falls back to next month for legacy YNAB4 backups missing incomeMonth (BUG-18)", async () => {
    const db = openMigratedDb();
    const legacyYnabData = {
      accounts: [
        { entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true },
      ],
      payees: [],
      masterCategories: [],
      monthlyBudgets: [],
      scheduledTransactions: [],
      transactions: [
        {
          entityId: "t-legacy",
          accountId: "acc1",
          date: "2026-06-15",
          amount: 500,
          cleared: "Cleared",
          categoryId: "Category/__DeferredIncome__",
          memo: "Legacy deferred income without incomeMonth property",
        },
      ],
    };

    await importYnab4(db, legacyYnabData);
    const budget = await getBudgetData(db);
    expect(budget.transactions).toHaveLength(1);
    const t = budget.transactions[0]!;
    expect(t.isIncome).toBe(true);
    expect(t.incomeMonth).toBe("2026-07"); // Reconstructed as nextMonthKey(2026-06)
  });

  it("escapes special characters in XML and unescapes them properly on import (BUG-49)", async () => {
    const db = openMigratedDb();
    const specialBudgetName = `A & B < C > "D" 'E'`;
    const { settingsXml } = await exportYnab4(db, {
      budgetName: specialBudgetName,
      currencySymbol: "£ & €",
    });

    // Check XML string contains escaped entities
    expect(settingsXml).toContain("<budgetName>A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;</budgetName>");
    expect(settingsXml).toContain("<currencySymbol>£ &amp; €</currencySymbol>");

    // Check round-trip zip export/import preserves original values without entity corruption
    const zipBuf = await exportYnab4Zip(db, {
      budgetName: specialBudgetName,
      currencySymbol: "£ & €",
    });
    const extracted = extractYnab4DataFromZip(zipBuf);
    expect(extracted.settings?.budgetName).toBe(specialBudgetName);
    expect(extracted.settings?.currencySymbol).toBe("£ & €");
  });

  it("exports live engine-computed available balance as cachedBalance and preserves live CC balances (BUG-15)", async () => {
    const db1 = openMigratedDb();

    // 1. Create checking and credit card accounts
    const [accChecking] = await db1.insert(schema.accounts).values({
      name: "Checking",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 100000,
      onBudget: true,
      sort: 0,
    }).returning();

    const [accCredit] = await db1.insert(schema.accounts).values({
      name: "Credit Card",
      kind: "credit",
      groupLabel: "Credit Cards",
      balance: -5000,
      onBudget: true,
      sort: 1,
    }).returning();

    // 2. Create category group and categories (including CC Payment category)
    const [grpGeneral] = await db1.insert(schema.categoryGroups).values({
      name: "Everyday Expenses",
      sort: 0,
      isCreditCardPayments: false,
    }).returning();

    const [grpCC] = await db1.insert(schema.categoryGroups).values({
      name: "Credit Card Payments",
      sort: 1,
      isCreditCardPayments: true,
    }).returning();

    const [catGroceries] = await db1.insert(schema.categories).values({
      groupId: grpGeneral!.id,
      name: "Groceries",
      sort: 0,
      carryover: 0,
    }).returning();

    // CC payment category starts with 0 seed carryover
    const [catCcPayment] = await db1.insert(schema.categories).values({
      groupId: grpCC!.id,
      name: "Credit Card",
      sort: 0,
      carryover: 0,
      linkedAccountId: accCredit!.id,
    }).returning();

    // 3. Assign funds to Groceries in 2026-05
    await db1.insert(schema.assignments).values({
      categoryId: catGroceries!.id,
      month: "2026-05",
      amount: 20000, // $200.00 budgeted
    });

    // 4. Spend $50 on credit card for Groceries -> funded CC spending moves $50 to CC Payment category
    await db1.insert(schema.transactions).values({
      accountId: accCredit!.id,
      categoryId: catGroceries!.id,
      date: "2026-05-10",
      payee: "Supermarket",
      amount: -5000, // -$50.00
      status: "c",
    });

    await recomputeAccountBalances(db1);

    // Verify DB1 engine-computed available:
    // Groceries available: $200 - $50 = $150.00
    // CC Payment available: $0 + $50 = $50.00
    const initialData1 = await getBudgetData(db1);
    const { ynabData } = await exportYnab4(db1);

    const exportedCcGroup = ynabData.masterCategories.find((mc: any) => mc.isCreditCardPayments);
    expect(exportedCcGroup).toBeDefined();
    const exportedCcSub = exportedCcGroup.subCategories.find((sc: any) => sc.name === "Credit Card");
    expect(exportedCcSub).toBeDefined();

    // cachedBalance must reflect live engine available ($50.00), not the static seed carryover ($0)
    expect(exportedCcSub.cachedBalance).toBe(50.0);
    expect(exportedCcSub.carryover).toBe(0.0);

    const exportedGenGroup = ynabData.masterCategories.find((mc: any) => mc.name === "Everyday Expenses");
    const exportedGrocSub = exportedGenGroup.subCategories.find((sc: any) => sc.name === "Groceries");
    expect(exportedGrocSub.cachedBalance).toBe(150.0);

    // Roundtrip test: export to zip and import into DB2
    const zipBuf = await exportYnab4Zip(db1);
    const db2 = openMigratedDb();
    const extracted = extractYnab4DataFromZip(zipBuf);
    await importYnab4(db2, extracted.ynabData, extracted.settingsXml);

    const data2 = await getBudgetData(db2);
    // In DB2, the CC payment category and Groceries available balances match DB1 perfectly
    const db1CcCat = initialData1.categories.find((c) => c.linkedAccountId === accCredit!.id);
    const db2CcCat = data2.categories.find((c) => c.linkedAccountId != null);
    expect(db2CcCat).toBeDefined();

    // Both initial and imported budgets produce identical account balances and transaction totals
    expect(Number(data2.accounts.find((a) => a.name === "Credit Card")?.balance)).toBe(-5000);
    expect(data2.transactions).toHaveLength(1);
  });
});
