/**
 * Regression: YNAB4 overspendingHandling import/export mapping.
 *
 * YNAB4 contract (stock reference):
 * - `OverspendingHandling` enum has exactly two members: `AffectsBuffer`
 *   and `Confined` (com/ynab/enums/OverspendingHandling.as).
 * - It is persisted per-month on MonthlySubCategoryBudgetVO.overspendingHandling
 *   (MonthlySubCategoryBudget.populateFromVO reads subCategoryBudgetVO.overspendingHandling).
 * - Semantics: `AffectsBuffer` = overspend does NOT stay in the category
 *   (priorBalance zeroed, counted in totalCarriedOverspending against the buffer/TBB);
 *   `Confined` = negative balance carries into the category next month (red-arrow-right).
 *
 * Our model: static per-category `overspendCarriesOver` flag —
 *   false = deduct from next month's TBB, category resets to 0  (~ AffectsBuffer)
 *   true  = category starts negative, NOT deducted from TBB      (~ Confined)
 * So the pinned mapping is true <-> "Confined", false <-> "AffectsBuffer".
 * The importer reads the per-month MSBVO handling (present in stock files);
 * the exporter writes the YNAB4-known enum members.
 *
 * Fix commit: 63aff1d (g-overspend-map).
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import { exportYnab4 } from "../src/export-ynab4.js";
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

/** Stock-shaped YNAB4 backup: SubCategory carries NO handling field;
 *  the per-month MSBVO carries overspendingHandling="Confined". */
function stockConfinedBackup() {
  return {
    accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
    payees: [{ entityId: "p1", name: "Store" }],
    masterCategories: [
      {
        entityId: "mc1",
        name: "Bills",
        type: "OUTFLOW",
        subCategories: [{ entityId: "sc-groc", masterCategoryId: "mc1", name: "Groceries", type: "OUTFLOW" }],
      },
    ],
    monthlyBudgets: [
      {
        entityId: "MB/2026-05",
        month: "2026-05-01",
        monthlySubCategoryBudgets: [
          {
            entityId: "MCB/2026-05/sc-groc",
            parentMonthlyBudgetId: "MB/2026-05",
            categoryId: "sc-groc",
            budgeted: 100,
            overspendingHandling: "Confined",
          },
        ],
      },
    ],
    transactions: [
      {
        entityId: "tx1",
        accountId: "acc1",
        categoryId: "sc-groc",
        payeeId: "p1",
        date: "2026-05-10",
        amount: -150,
        memo: "",
        cleared: "Cleared",
      },
    ],
    scheduledTransactions: [],
  };
}

describe("ynab4 parity: YNAB4 overspendingHandling mapping", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("import: MSBVO overspendingHandling='Confined' sets overspendCarriesOver=true", async () => {
    await importYnab4(db, stockConfinedBackup());
    const cats = await db.select().from(schema.categories);
    const groc = cats.find((c) => c.name === "Groceries");
    expect(groc).toBeDefined();
    // The importer reads the MSBVO handling (never present as a static
    // SubCategory field in stock files).
    expect(groc!.overspendCarriesOver).toBe(true);
  });

  it("export: true maps to 'Confined', false maps to 'AffectsBuffer'", async () => {
    const [grp] = await db
      .insert(schema.categoryGroups)
      .values({ name: "G", sort: 0 })
      .returning();
    await db.insert(schema.categories).values([
      { groupId: grp!.id, name: "Carry", sort: 0, overspendCarriesOver: true },
      { groupId: grp!.id, name: "NoCarry", sort: 1, overspendCarriesOver: false },
    ]);
    const { ynabData } = await exportYnab4(db);
    const subs = ynabData.masterCategories.flatMap((mc: any) => mc.subCategories);
    const byName = new Map(subs.map((s: any) => [s.name, s]));
    // true -> "Confined", false -> "AffectsBuffer" (YNAB4-known members).
    expect(byName.get("Carry")!.overspendingHandling).toBe("Confined");
    expect(byName.get("NoCarry")!.overspendingHandling).toBe("AffectsBuffer");
  });
});
