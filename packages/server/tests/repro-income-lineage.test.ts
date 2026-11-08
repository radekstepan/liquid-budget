/**
 * Regression: income attribution and transfer lineage preservation.
 *
 * YNAB4 references: MonthlyBudget.as:516-552,473-502 (first-inflow-child-wins
 * per offset); CategoryConstants.as:10-40 (sentinel income categories).
 *
 * Pins three behaviors:
 * 1. Income split attribution: YNAB4 first-inflow-child-wins per offset —
 *    only the first inflow child of a split counts as income
 *    (import-ynab4.ts).
 * 2. Sentinels __SupplementalIncome__/__PrimaryIncome__ survive as income
 *    with a warning, and round-trip through export with the sentinel
 *    category intact.
 * 3. Dest-leg transfer lineage (memo/FITID/checkNumber) survives the
 *    import+export round-trip instead of being dropped on import and
 *    overwritten with the source leg's lineage on export.
 *
 * Fix commit: fa08d90 (g-income-lineage).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { exportYnab4 } from "../src/export-ynab4.js";
import { importYnab4 } from "../src/import-ynab4.js";
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

const baseAccounts = [
  { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
  { entityId: "acc2", accountName: "Savings", accountType: "Savings", onBudget: true },
];
const basePayees = [{ entityId: "p1", name: "Employer" }];

describe("ynab4 parity: split income attribution is first-inflow-child-wins, not sum-all", () => {
  it("only the first inflow child counts (Deferred +10000, Immediate +5000 => supplemental 0)", async () => {
    const db = openMigratedDb();
    // Milliunits: 100000 -> 10000c, 50000 -> 5000c.
    await importYnab4(
      db,
      {
        accounts: baseAccounts,
        payees: basePayees,
        masterCategories: [],
        transactions: [
          {
            entityId: "t-inc-split",
            accountId: "acc1",
            date: "2026-06-01",
            amount: 150000,
            cleared: "Cleared",
            payeeId: "p1",
            categoryId: "Category/__Split__",
            subTransactions: [
              { entityId: "st-deferred", amount: 100000, categoryId: "Category/__DeferredIncome__" },
              { entityId: "st-immediate", amount: 50000, categoryId: "Category/__ImmediateIncome__" },
            ],
          },
        ],
        monthlyBudgets: [],
        scheduledTransactions: [],
      },
      ""
    );
    const rows = await db.select().from(schema.transactions);
    const parent = rows.find((r) => r.entityId === "t-inc-split");
    const kids = rows.filter((r) => r.parentId === parent!.id);
    expect(kids).toHaveLength(2);
    const incomeKids = kids.filter((k) => k.isIncome);
    // YNAB4: first inflow child wins the offset => exactly one income child.
    expect(incomeKids.map((k) => k.entityId)).toEqual(["st-deferred"]);
    // YNAB4 supplemental for this split is 0; summed income must be 10000c, not 15000c.
    const incomeSum = incomeKids.reduce((s, k) => s + Number(k.amount), 0);
    expect(incomeSum).toBe(10000);
  });
});

describe("ynab4 parity: sentinel __SupplementalIncome__ survives as income with a warning", () => {
  it("regular txn with Category/__SupplementalIncome__ +5000 keeps income + warns", async () => {
    const db = openMigratedDb();
    const summary = await importYnab4(
      db,
      {
        accounts: baseAccounts,
        payees: basePayees,
        masterCategories: [],
        transactions: [
          {
            entityId: "t-supp",
            accountId: "acc1",
            date: "2026-06-01",
            amount: 50000,
            cleared: "Cleared",
            payeeId: "p1",
            categoryId: "Category/__SupplementalIncome__",
          },
        ],
        monthlyBudgets: [],
        scheduledTransactions: [],
      },
      ""
    );
    const rows = await db.select().from(schema.transactions);
    const row = rows.find((r) => r.entityId === "t-supp");
    expect(row).toBeDefined();
    // Income must not be lost.
    expect(row!.isIncome).toBe(true);
    // The unmapped sentinel must surface as a warning, never silently.
    expect(summary.warnings.some((w) => /SupplementalIncome/.test(w))).toBe(true);
    // Round-trip must preserve the sentinel category, not collapse to Immediate.
    const { ynabData: out } = await exportYnab4(db);
    const outTx = out.transactions.find((t: any) => t.entityId === "t-supp");
    expect(outTx).toBeDefined();
    expect(outTx.categoryId).toBe("Category/__SupplementalIncome__");
  });
});

describe("ynab4 parity: dest-leg transfer lineage survives import+export", () => {
  it("paired transfer preserves distinct dest FITID/memo through import+export", async () => {
    const db = openMigratedDb();
    await importYnab4(
      db,
      {
        accounts: baseAccounts,
        payees: basePayees,
        masterCategories: [],
        transactions: [
          {
            entityId: "tx-src",
            accountId: "acc1",
            date: "2026-06-01",
            amount: -100000,
            cleared: "Cleared",
            memo: "source memo",
            FITID: "FIT-SRC",
            checkNumber: "111",
            transferTransactionId: "tx-dest",
          },
          {
            entityId: "tx-dest",
            accountId: "acc2",
            date: "2026-06-01",
            amount: 100000,
            cleared: "Cleared",
            memo: "dest memo",
            FITID: "FIT-DEST",
            checkNumber: "222",
            transferTransactionId: "tx-src",
          },
        ],
        monthlyBudgets: [],
        scheduledTransactions: [],
      },
      ""
    );
    const rows = await db.select().from(schema.transactions);
    // Import collapses the pair to one linked row; dest entity link survives...
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transferAccountId).not.toBeNull();
    expect(rows[0]!.transferEntityId).toBe("tx-dest");

    // ...but the dest leg's own lineage must survive the round-trip, not be
    // overwritten with the source leg's lineage.
    const { ynabData: out } = await exportYnab4(db);
    const destLeg = out.transactions.find((t: any) => t.entityId === "tx-dest");
    expect(destLeg).toBeDefined();
    expect(destLeg.memo).toBe("dest memo");
    expect(destLeg.FITID).toBe("FIT-DEST");
    expect(destLeg.checkNumber).toBe("222");
  });
});
