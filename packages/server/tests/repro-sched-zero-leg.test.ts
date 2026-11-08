/**
 * REPRO ONLY — G-06 (scheduled half): scheduled splits still filter zero legs.
 *
 * What diverges/is lost: regular (register) splits import every live leg
 * verbatim, including 0-amount legs — only a parent with literally no
 * non-tombstone children is skipped. Scheduled splits still filter legs
 * through `nonZeroSubs`, so a scheduled split containing a 0-amount leg
 * loses the leg; a 2-leg split with one 0 leg further collapses to a plain
 * recurring row ("single-child"), destroying the split structure YNAB4
 * would show.
 *
 * YNAB4 refs (read-only):
 * - ynabData/vo/ScheduledTransactionVO.as:9-11 (frequency/twiceAMonthStartDay
 *   + all Matchable fields); splits are full SubTransactionVO children
 *   (vo/SubTransactionVO.as, parentTransactionId)
 *
 * Our side: packages/server/src/import-ynab4.ts:2161 (nonZeroSubs filter),
 * :2182-2204 (single-nonzero-child collapse), :2315 (legs inserted from
 * nonZeroSubs only) vs regular splits verbatim at :1060-1081.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
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

/** Balanced scheduled split: parent -100 = legs -100 + 0. */
function backupWithZeroLegSchedSplit() {
  return {
    fileMetaData: { budgetDataVersion: "4.2.0" },
    accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
    payees: [{ entityId: "p1", name: "Store" }],
    masterCategories: [
      {
        entityId: "mc1",
        name: "Bills",
        type: "OUTFLOW",
        subCategories: [
          { entityId: "sc-a", masterCategoryId: "mc1", name: "Groceries", type: "OUTFLOW" },
          { entityId: "sc-b", masterCategoryId: "mc1", name: "Household", type: "OUTFLOW" },
        ],
      },
    ],
    transactions: [],
    scheduledTransactions: [
      {
        entityId: "sched-split",
        accountId: "acc1",
        date: "2026-03-01",
        amount: -100,
        frequency: "Monthly",
        payeeId: "p1",
        categoryId: "Category/__Split__",
        subTransactions: [
          { entityId: "ss-1", amount: -100, categoryId: "sc-a" },
          { entityId: "ss-2", amount: 0, categoryId: "sc-b" },
        ],
      },
    ],
    monthlyBudgets: [],
  };
}

describe("G-06 repro: scheduled split zero leg imports verbatim", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("keeps the 0-amount leg as a recurring child row", async () => {
    await importYnab4(db, backupWithZeroLegSchedSplit());
    const rows = await db.select().from(schema.recurring);
    expect(rows).toHaveLength(1);
    const kids = await db.select().from(schema.recurringSubTransactions);
    // FAILS today: nonZeroSubs (:2161) drops the 0 leg, the split collapses
    // to a plain row (:2182-2204), and zero child legs import.
    expect(kids).toHaveLength(2);
    expect(kids.map((k) => Number(k.amount)).sort((a, b) => a - b)).toEqual([-10000, 0]);
  });

  it("does not collapse the split into a plain recurring row", async () => {
    const summary = await importYnab4(db, backupWithZeroLegSchedSplit());
    const kids = await db.select().from(schema.recurringSubTransactions);
    // FAILS today: same filter — the single-nonzero-child collapse fires
    // and the summary reports a collapsed split.
    expect(kids.length).toBeGreaterThan(0);
    expect((summary.warnings ?? []).join("\n")).not.toMatch(/Collapsed .* single-child/);
  });
});
