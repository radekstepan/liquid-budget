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
import { importYnab4, importYnab4FromArchive, extractYnab4DataFromZip, MAX_YNAB4_UPLOAD_BYTES, MAX_ZIP_ENTRIES } from "../src/import-ynab4.js";
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
      fileMetaData: { budgetDataVersion: "4.2.0" },
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
    expect(result.warnings).toEqual([]);
  });

  it("throws a descriptive error if no .ynab4 entry exists in the zip", () => {
    const zip = new AdmZip();
    zip.addFile("random.txt", Buffer.from("hello world", "utf-8"));

    expect(() => extractYnab4DataFromZip(zip.toBuffer())).toThrow(
      "Could not find .ynab4 data file inside the zip archive"
    );
  });

  it("rejects uploads larger than 50MB before inflate", () => {
    expect(() => extractYnab4DataFromZip(Buffer.alloc(MAX_YNAB4_UPLOAD_BYTES + 1))).toThrow(
      /exceeds the 50MB/
    );
  });

  it("rejects archives with too many entries (zip-bomb guard)", () => {
    const zip = new AdmZip();
    for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i++) {
      zip.addFile(`filler-${i}.txt`, Buffer.from("x", "utf-8"));
    }
    expect(() => extractYnab4DataFromZip(zip.toBuffer())).toThrow(/too many entries/);
  });
});

describe("importYnab4FromArchive: single-call upload entry point", () => {
  function buildZip(payload: unknown): Buffer {
    const zip = new AdmZip();
    zip.addFile("budget.ynab4", Buffer.from(JSON.stringify(payload), "utf-8"));
    return zip.toBuffer();
  }

  it("extracts and imports archive bytes in one call", async () => {
    const payload = {
      fileMetaData: { budgetDataVersion: "4.2.0" },
      accounts: [
        {
          entityId: "acc-1",
          accountName: "Checking",
          accountType: "Checking",
          onBudget: true,
          sortableIndex: 0,
        },
      ],
      payees: [],
      masterCategories: [],
      transactions: [],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };
    const db = openMigratedDb();
    const summary = await importYnab4FromArchive(db, buildZip(payload));
    expect(summary.accounts).toBe(1);
    const data = await getBudgetData(db);
    expect(data.accounts.map((a) => a.name)).toContain("Checking");
  });

  it("propagates extraction failures instead of wiping the ledger", async () => {
    const zip = new AdmZip();
    zip.addFile("random.txt", Buffer.from("hello", "utf-8"));
    const db = openMigratedDb();
    await db.insert(schema.accounts).values({
      name: "Keep Me",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 123,
    });
    await expect(importYnab4FromArchive(db, zip.toBuffer())).rejects.toThrow(
      /Could not find .ynab4 data file/
    );
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Keep Me");
  });
});

describe("Stage 2: 2-stage import with comprehensive synthetic YNAB4 data", () => {
  const syntheticYnab4Data = {
    fileMetaData: { budgetDataVersion: "4.2.0" },
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
    expect(summary.warnings).toEqual([]); // current data version: no notices

    const data = await getBudgetData(db);
    const byName = new Map(data.accounts.map((a) => [a.name, a]));

    // 4. Verify Account Balances (in cents)
    // Checking native sum:
    // +5000 (salary) - 1500 (rent) - 300 (transfer to CC) - 150 (groceries split) - 50 (old car split) - 800 (savings transfer split) - 200 (util split)
    // = 5000 - 1500 - 300 - 150 - 50 - 800 - 200 = $2000.00 -> 200000 cents
    expect(Number(byName.get("Main Chequing")!.balance)).toBe(200000);

    // Savings native sum:
    // +800 (from split transfer) = $800.00 -> 80000 cents
    expect(Number(byName.get("High Interest Savings")!.balance)).toBe(80000);

    // Credit Card native sum:
    // +300 (bill payment from Checking) - 120 (groceries charge) = $180.00 -> 18000 cents
    expect(Number(byName.get("Rewards Visa")!.balance)).toBe(18000);

    // Investment (no tx) = 0 cents
    expect(Number(byName.get("Index Fund TFSA")!.balance)).toBe(0);

    // 5. Verify Metadata and Sort Order
    const checkingAcc = byName.get("Main Chequing")!;
    expect(checkingAcc.sort).toBe(0); // lowest sortableIndex (-1000)
    expect(checkingAcc.lastReconciledAt).toBe("2026-01-15");
    expect(Number(checkingAcc.lastReconciledBalance)).toBe(500050);

    // 6. Verify Transfer De-duplication in DB
    // Regular transfer (tx-transfer-cc-source & tx-transfer-cc-dest) should only produce 1 row
    const ccTransfers = data.transactions.filter(
      (t) => t.payee === "Transfer : Rewards Visa"
    );
    expect(ccTransfers).toHaveLength(1);
    expect(Number(ccTransfers[0]!.amount)).toBe(-30000);

    const savingsTransfer = data.transactions.filter(
      (t) => t.payee === "Transfer : High Interest Savings"
    );
    expect(savingsTransfer).toHaveLength(1);
    expect(Number(savingsTransfer[0]!.amount)).toBe(-80000);
    expect(savingsTransfer[0]!.transferAccountId).toBe(byName.get("High Interest Savings")!.id);

    // 7. Verify Hidden Categories Mapping
    const hiddenCarCat = data.categories.find((c) => c.name === "Old Car Maintenance");
    expect(hiddenCarCat).toBeDefined();

    // Verify split transaction child linked to hidden category
    const carTx = data.transactions.find((t) => t.categoryId === hiddenCarCat!.id);
    expect(carTx).toBeDefined();
    expect(Number(carTx!.amount)).toBe(-5000);

    // 8. Verify Scheduled Transaction Frequencies
    const frequencies = data.recurring.map((r) => r.frequency);
    expect(frequencies).toContain("monthly");
    expect(frequencies).toContain("twiceamonth");
    expect(frequencies).toContain("everyothermonth");
  });
});

describe("G-01: budgetDataVersion gate and package-entry warnings", () => {
  function buildZip(payload: unknown, extraEntries: Record<string, string> = {}): Buffer {
    const zip = new AdmZip();
    zip.addFile("budget.ynab4", Buffer.from(JSON.stringify(payload), "utf-8"));
    for (const [name, content] of Object.entries(extraEntries)) {
      zip.addFile(name, Buffer.from(content, "utf-8"));
    }
    return zip.toBuffer();
  }

  function minimalPayload(fileMetaData?: unknown): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      accounts: [],
      payees: [],
      masterCategories: [],
      transactions: [],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };
    if (fileMetaData !== undefined) payload.fileMetaData = fileMetaData;
    return payload;
  }

  it("rejects a backup with no fileMetaData instead of misparsing it", () => {
    expect(() => extractYnab4DataFromZip(buildZip(minimalPayload()))).toThrow(
      /missing fileMetaData\.budgetDataVersion/
    );
  });

  it("rejects a backup with an unparseable budgetDataVersion", () => {
    const payload = minimalPayload({ budgetDataVersion: "not-a-version" });
    expect(() => extractYnab4DataFromZip(buildZip(payload))).toThrow(
      /missing fileMetaData\.budgetDataVersion/
    );
  });

  it("rejects a pre-2.6 backup with a clear minimum-version error", () => {
    const payload = minimalPayload({ budgetDataVersion: "2.5" });
    expect(() => extractYnab4DataFromZip(buildZip(payload))).toThrow(
      /minimum supported version is 2\.6/
    );
  });

  it("accepts the 2.6 floor with an older-version warning", () => {
    const extracted = extractYnab4DataFromZip(buildZip(minimalPayload({ budgetDataVersion: "2.6" })));
    expect(extracted.ynabData).toBeDefined();
    expect(extracted.warnings).toHaveLength(1);
    expect(extracted.warnings[0]).toMatch(/older than 4\.2\.0/);
  });

  it("warns (but imports) when the version is older than 4.2.0", async () => {
    const payload = minimalPayload({ budgetDataVersion: "4.1.1" });
    const extracted = extractYnab4DataFromZip(buildZip(payload));
    expect(extracted.warnings).toHaveLength(1);
    expect(extracted.warnings[0]).toMatch(/older than 4\.2\.0/);

    const db = openMigratedDb();
    const summary = await importYnab4(db, extracted.ynabData, undefined, {
      warnings: extracted.warnings,
    });
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings![0]).toMatch(/older than 4\.2\.0/);
  });

  it("warns when the archive carries devices/ or Snapshots/ sync state", () => {
    const payload = minimalPayload({ budgetDataVersion: "4.2.0" });
    const extracted = extractYnab4DataFromZip(
      buildZip(payload, {
        "devices/A1234/device.knowledge": "knowledge-data",
        "Snapshots/Budget.2026-01-01.ymeta": "snapshot-pointer",
      })
    );
    expect(extracted.ynabData).toBeDefined();
    expect(extracted.warnings).toHaveLength(2);
    expect(extracted.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/devices\//),
        expect.stringMatching(/Snapshots\//),
      ])
    );
  });

  it("rejects versioned pre-2.6 data in importYnab4 before wiping the ledger", async () => {
    const db = openMigratedDb();
    await db.insert(schema.accounts).values({
      name: "Keep Me",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 123,
    });

    const payload = minimalPayload({ budgetDataVersion: "2.5" });
    await expect(importYnab4(db, payload)).rejects.toThrow(/minimum supported version is 2\.6/);

    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Keep Me");
  });

  it("tolerates programmatic data without fileMetaData (zip boundary enforces it)", async () => {
    const db = openMigratedDb();
    const summary = await importYnab4(db, minimalPayload());
    expect(summary.accounts).toBe(0);
    expect(summary.warnings).toEqual([]);
  });
});

describe("G-03: account notes survive import", () => {
  it("maps acc.note into accounts.notes, including InvestmentAccount", async () => {
    const payload = {
      fileMetaData: { budgetDataVersion: "4.2.0" },
      accounts: [
        {
          entityId: "acc-invest",
          accountName: "Index Fund",
          accountType: "InvestmentAccount",
          onBudget: false,
          sortableIndex: 0,
          note: "Retirement stash — do not touch",
        },
        {
          entityId: "acc-checking",
          accountName: "Checking",
          accountType: "Checking",
          onBudget: true,
          sortableIndex: 1000,
        },
      ],
      payees: [],
      masterCategories: [],
      transactions: [],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    const db = openMigratedDb();
    const summary = await importYnab4(db, payload);
    expect(summary.accounts).toBe(2);

    const rows = await db.select().from(schema.accounts);
    const byName = new Map(rows.map((a) => [a.name, a]));
    expect(byName.get("Index Fund")!.notes).toBe("Retirement stash — do not touch");
    expect(byName.get("Checking")!.notes).toBe("");
  });
});
