/**
 * import-ynab4-zip.test.ts
 *
 * Fully self-contained tests for:
 * 1. Stage 1: extractYnab4DataFromZip (zip parsing in-memory)
 * 2. Stage 2: importYnab4 on synthetic comprehensive YNAB4 dataset
 *
 * Does NOT depend on any external files or local backup.y4backup file.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import AdmZip from "adm-zip";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4, extractYnab4DataFromZip } from "../src/import-ynab4.js";
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

describe("Stage 1: extractYnab4DataFromZip", () => {
  it("extracts ynabData and settingsXml from an in-memory zip archive", () => {
    const zip = new AdmZip();
    const mockJson = {
      budgetMetaData: { currencyLocale: "en_CA" },
      accounts: [{ entityId: "acc1", accountName: "Checking" }],
      transactions: [],
    };
    const mockXml = "<budgetSettings><lastSelectedMonth>2026-06-01</lastSelectedMonth></budgetSettings>";

    zip.addFile("data-12345.ynab4", Buffer.from(JSON.stringify(mockJson), "utf-8"));
    zip.addFile("budgetSettings.ybsettings", Buffer.from(mockXml, "utf-8"));

    const zipBuffer = zip.toBuffer();
    const result = extractYnab4DataFromZip(zipBuffer);

    expect(result.ynabData).toEqual(mockJson);
    expect(result.settingsXml).toBe(mockXml);
  });

  it("throws a descriptive error if no .ynab4 entry exists in the zip", () => {
    const zip = new AdmZip();
    zip.addFile("random.txt", Buffer.from("hello world", "utf-8"));

    expect(() => extractYnab4DataFromZip(zip.toBuffer())).toThrow(
      "Could not find .ynab4 data file inside the zip archive"
    );
  });
});

describe("Stage 2: 2-stage import with comprehensive synthetic YNAB4 data", () => {
  const syntheticYnab4Data = {
    budgetMetaData: {
      currencyLocale: "en_CA",
      dateLocale: "en_CA",
    },
    accounts: [
      {
        entityId: "acc-checking",
        accountName: "Main Chequing",
        accountType: "Checking",
        onBudget: true,
        sortableIndex: -1000,
        lastReconciledDate: "2026-01-15",
        lastReconciledBalance: 5000.5,
      },
      {
        entityId: "acc-savings",
        accountName: "High Interest Savings",
        accountType: "Savings",
        onBudget: true,
        sortableIndex: 0,
        lastReconciledDate: "2026-02-01",
        lastReconciledBalance: 20000.0,
      },
      {
        entityId: "acc-credit",
        accountName: "Rewards Visa",
        accountType: "CreditCard",
        onBudget: true,
        sortableIndex: 500,
        lastReconciledDate: "2026-02-10",
        lastReconciledBalance: -450.75,
      },
      {
        entityId: "acc-invest",
        accountName: "Index Fund TFSA",
        accountType: "InvestmentAccount",
        onBudget: false,
        sortableIndex: 1000,
      },
      {
        entityId: "acc-deleted",
        accountName: "Old Closed Account",
        accountType: "Checking",
        onBudget: true,
        isTombstone: true,
      },
    ],
    payees: [
      { entityId: "payee-employer", name: "Acme Corp" },
      { entityId: "payee-supermarket", name: "Supermarket" },
      { entityId: "payee-landlord", name: "Landlord" },
    ],
    masterCategories: [
      {
        entityId: "mc-housing",
        name: "Housing",
        type: "OUTFLOW",
        sortableIndex: -500,
        subCategories: [
          { entityId: "sc-rent", name: "Rent", sortableIndex: 0 },
          { entityId: "sc-utilities", name: "Utilities", sortableIndex: 100 },
        ],
      },
      {
        entityId: "mc-daily",
        name: "Daily Expenses",
        type: "OUTFLOW",
        sortableIndex: 0,
        subCategories: [
          { entityId: "sc-groceries", name: "Groceries", sortableIndex: 0 },
        ],
      },
      {
        entityId: "MasterCategory/__Hidden__",
        name: "Hidden Categories",
        type: "OUTFLOW",
        sortableIndex: 10000,
        subCategories: [
          { entityId: "sc-old-car", name: "Old Car Maintenance", sortableIndex: 0 },
        ],
      },
      {
        entityId: "MasterCategory/__Income__",
        name: "Income",
        type: "INFLOW",
      },
    ],
    transactions: [
      // 1. Initial Salary into Checking (+5000)
      {
        entityId: "tx-income-1",
        accountId: "acc-checking",
        date: "2026-01-01",
        amount: 5000,
        cleared: "Reconciled",
        payeeId: "payee-employer",
        categoryId: "Category/__ImmediateIncome__",
      },
      // 2. Rent Outflow from Checking (-1500)
      {
        entityId: "tx-rent-1",
        accountId: "acc-checking",
        date: "2026-01-02",
        amount: -1500,
        cleared: "Cleared",
        payeeId: "payee-landlord",
        categoryId: "sc-rent",
      },
      // 3. Regular transfer pair between Checking and Credit Card (Paying card bill: -300 from Checking, +300 on Visa)
      {
        entityId: "tx-transfer-cc-source",
        accountId: "acc-checking",
        date: "2026-01-05",
        amount: -300,
        cleared: "Cleared",
        payeeId: "Payee/Transfer:acc-credit",
        targetAccountId: "acc-credit",
        transferTransactionId: "tx-transfer-cc-dest",
        categoryId: null,
      },
      {
        entityId: "tx-transfer-cc-dest",
        accountId: "acc-credit",
        date: "2026-01-05",
        amount: 300,
        cleared: "Cleared",
        payeeId: "Payee/Transfer:acc-checking",
        targetAccountId: "acc-checking",
        transferTransactionId: "tx-transfer-cc-source",
        categoryId: null,
      },
      // 4. Regular spending on Credit Card (-120 groceries)
      {
        entityId: "tx-groceries-cc",
        accountId: "acc-credit",
        date: "2026-01-06",
        amount: -120,
        cleared: "Uncleared",
        payeeId: "payee-supermarket",
        categoryId: "sc-groceries",
      },
      // 5. Split transaction on Checking (-200 total: -150 groceries + -50 hidden car category)
      {
        entityId: "tx-split-parent-1",
        accountId: "acc-checking",
        date: "2026-01-10",
        amount: -200,
        cleared: "Cleared",
        payeeId: "payee-supermarket",
        categoryId: "Category/__Split__",
        subTransactions: [
          { entityId: "st-split-1", amount: -150, categoryId: "sc-groceries" },
          { entityId: "st-split-2", amount: -50, categoryId: "sc-old-car" },
        ],
      },
      // 6. Split transaction with a transfer child (Checking: -1000 total -> -200 Utilities + -800 Transfer to Savings)
      {
        entityId: "tx-split-parent-transfer",
        accountId: "acc-checking",
        date: "2026-01-15",
        amount: -1000,
        cleared: "Cleared",
        payeeId: "payee-supermarket",
        categoryId: "Category/__Split__",
        subTransactions: [
          { entityId: "st-transfer-sub", amount: -800, targetAccountId: "acc-savings", transferTransactionId: "tx-savings-standalone" },
          { entityId: "st-util-sub", amount: -200, categoryId: "sc-utilities" },
        ],
      },
      // Standalone counterpart on Savings account (+800)
      {
        entityId: "tx-savings-standalone",
        accountId: "acc-savings",
        date: "2026-01-15",
        amount: 800,
        cleared: "Cleared",
        payeeId: "Payee/Transfer:acc-checking",
        targetAccountId: "acc-checking",
        transferTransactionId: "st-transfer-sub",
        categoryId: null,
      },
    ],
    scheduledTransactions: [
      {
        entityId: "sched-1",
        accountId: "acc-checking",
        date: "2026-02-01",
        amount: -1500,
        frequency: "Monthly",
        payeeId: "payee-landlord",
        categoryId: "sc-rent",
      },
      {
        entityId: "sched-2",
        accountId: "acc-checking",
        date: "2026-02-15",
        amount: -250,
        frequency: "TwiceAMonth",
        twiceAMonthStartDay: 15,
        payeeId: "payee-supermarket",
        categoryId: "sc-groceries",
      },
      {
        entityId: "sched-3",
        accountId: "acc-checking",
        date: "2026-03-01",
        amount: -100,
        frequency: "EveryOtherMonth",
        payeeId: "payee-supermarket",
        categoryId: "sc-utilities",
      },
    ],
    monthlyBudgets: [
      {
        month: "2026-01-01",
        monthlySubCategoryBudgets: [
          { categoryId: "sc-rent", budgeted: 1500 },
          { categoryId: "sc-groceries", budgeted: 500 },
          { categoryId: "sc-old-car", budgeted: 50 },
        ],
      },
    ],
  };

  it("extracts from zip and imports cleanly with 100% accurate balances and mappings", async () => {
    // 1. Pack synthetic data into an in-memory zip
    const zip = new AdmZip();
    zip.addFile("test-budget.ynab4", Buffer.from(JSON.stringify(syntheticYnab4Data), "utf-8"));
    const zipBuffer = zip.toBuffer();

    // 2. Stage 1: Extract data
    const { ynabData } = extractYnab4DataFromZip(zipBuffer);
    expect(ynabData).toBeDefined();

    // 3. Stage 2: Import into DB
    const db = openMigratedDb();
    const summary = await importYnab4(db, ynabData);

    expect(summary.accounts).toBe(4); // 4 active, 1 tombstone dropped
    expect(summary.categoryGroups).toBe(4); // Housing, Daily Expenses, Hidden Categories, Credit Card Payments
    expect(summary.categories).toBe(4); // Rent, Utilities, Groceries, Old Car Maintenance

    const data = await getBudgetData(db);
    const byName = new Map(data.accounts.map((a) => [a.name, a]));

    // 4. Verify Account Balances
    // Checking native sum:
    // +5000 (salary) - 1500 (rent) - 300 (transfer to CC) - 150 (groceries split) - 50 (old car split) - 800 (savings transfer split) - 200 (util split)
    // = 5000 - 1500 - 300 - 150 - 50 - 800 - 200 = 2000.00
    expect(Number(byName.get("Main Chequing")!.balance)).toBeCloseTo(2000.0, 2);

    // Savings native sum:
    // +800 (from split transfer) = 800.00
    expect(Number(byName.get("High Interest Savings")!.balance)).toBeCloseTo(800.0, 2);

    // Credit Card native sum:
    // +300 (bill payment from Checking) - 120 (groceries charge) = 180.00
    expect(Number(byName.get("Rewards Visa")!.balance)).toBeCloseTo(180.0, 2);

    // Investment (no tx) = 0.00
    expect(Number(byName.get("Index Fund TFSA")!.balance)).toBeCloseTo(0.0, 2);

    // 5. Verify Metadata and Sort Order
    const checkingAcc = byName.get("Main Chequing")!;
    expect(checkingAcc.sort).toBe(0); // lowest sortableIndex (-1000)
    expect(checkingAcc.lastReconciledAt).toBe("2026-01-15");
    expect(Number(checkingAcc.lastReconciledBalance)).toBeCloseTo(5000.5, 2);

    // 6. Verify Transfer De-duplication in DB
    // Regular transfer (tx-transfer-cc-source & tx-transfer-cc-dest) should only produce 1 row
    const ccTransfers = data.transactions.filter(
      (t) => t.payee === "Transfer : Rewards Visa"
    );
    expect(ccTransfers).toHaveLength(1);
    expect(Number(ccTransfers[0]!.amount)).toBe(-300);

    const savingsTransfer = data.transactions.filter(
      (t) => t.payee === "Transfer : Main Chequing"
    );
    expect(savingsTransfer).toHaveLength(1);
    expect(Number(savingsTransfer[0]!.amount)).toBe(800);

    // 7. Verify Hidden Categories Mapping
    const hiddenCarCat = data.categories.find((c) => c.name === "Old Car Maintenance");
    expect(hiddenCarCat).toBeDefined();

    // Verify split transaction child linked to hidden category
    const carTx = data.transactions.find((t) => t.categoryId === hiddenCarCat!.id);
    expect(carTx).toBeDefined();
    expect(Number(carTx!.amount)).toBe(-50);

    // 8. Verify Scheduled Transaction Frequencies
    const frequencies = data.recurring.map((r) => r.frequency);
    expect(frequencies).toContain("monthly");
    expect(frequencies).toContain("twiceamonth");
    expect(frequencies).toContain("everyothermonth");
  });
});
