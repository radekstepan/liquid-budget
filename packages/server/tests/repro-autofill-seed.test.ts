/**
 * REPRO ONLY — G-04 (autofill half): payee autoFillMemo/autoFillAmount dropped.
 *
 * What diverges/is lost: YNAB4 keeps one AutoFillData per payee, seeded from
 * `payee.autoFillCategoryId/autoFillMemo/autoFillAmount` and refreshed on
 * every save (`getSettingsFromTransaction` overwrites memo+amount
 * unconditionally, last write wins); typing a known payee on a blank row
 * proposes amount + memo + category. Our importer resolves
 * autoFillCategoryId (plus a history-majority fallback) but drops
 * autoFillMemo/autoFillAmount with a bare count warning — so a payee whose
 * ONLY autofill signal is the entity default (zero transaction history)
 * proposes nothing.
 *
 * YNAB4 refs (read-only):
 * - ynabData/vo/PayeeVO.as:24-28 (autoFillCategoryId/autoFillMemo/autoFillAmount)
 * - src/scripts/data/AutoFillData.as:110-118 (getSettingsFromTransaction),
 *   :133-164 (applyToNew); data/PayeeManager.as (updateAutoFillSettings)
 *
 * Our side: packages/server/src/import-ynab4.ts:1919-1921 (no autofill
 * target), :1939-1943 (counts them as dropped), :1994-1998 (aggregate
 * warning); packages/logic/src/payee-autofill.ts (suggestAutofillForPayee
 * derives proposals from history only — nothing seeds it).
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import { suggestAutofillForPayee } from "@ynab/logic";
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

/** Payee carrying entity-level autofill defaults but zero transaction history. */
function backupWithAutofillOnlyPayee() {
  return {
    fileMetaData: { budgetDataVersion: "4.2.0" },
    accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
    payees: [
      {
        entityId: "p1",
        name: "Corner Store",
        autoFillMemo: "weekly groceries",
        autoFillAmount: 25,
      },
    ],
    masterCategories: [],
    transactions: [],
    scheduledTransactions: [],
    monthlyBudgets: [],
  };
}

async function historyFor(db: Db, payeeName: string) {
  const rows = await db.select().from(schema.transactions);
  return rows
    .filter((t) => t.payee === payeeName)
    .map((t) => ({
      id: t.id,
      payee: t.payee,
      amount: t.amount,
      memo: t.memo,
      categoryId: t.categoryId,
      date: t.date,
    }));
}

describe("G-04 repro: autoFillMemo/autoFillAmount seed autofill", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  /**
   * Integrated path: the import persists the YNAB4 entity defaults on
   * the payee row, and the caller hands them to the pure helper (which
   * has no DB access of its own). History always wins once rows exist;
   * with zero history the stored defaults seed the proposal.
   */
  async function suggestionFor(payeeName: string) {
    const payeeRow = db
      .select()
      .from(schema.payees)
      .where(eq(schema.payees.name, payeeName))
      .get();
    return suggestAutofillForPayee(await historyFor(db, payeeName), payeeName, {
      defaultMemo: payeeRow?.autoMemo ?? null,
      defaultAmount: payeeRow?.autoAmount ?? null,
    });
  }

  it("entity autoFillMemo seeds the memo proposal with no history", async () => {
    await importYnab4(db, backupWithAutofillOnlyPayee());
    const suggestion = await suggestionFor("Corner Store");
    // FAILS today: history is empty and the entity default was dropped,
    // so the payee proposes nothing instead of "weekly groceries".
    expect(suggestion).not.toBeNull();
    expect(suggestion!.memo).toBe("weekly groceries");
  });

  it("entity autoFillAmount seeds the amount proposal with no history", async () => {
    await importYnab4(db, backupWithAutofillOnlyPayee());
    const suggestion = await suggestionFor("Corner Store");
    // FAILS today: same root cause — the amount default never reaches the
    // payee-autofill path or any stored column.
    expect(suggestion).not.toBeNull();
    expect(suggestion!.amount).not.toBeNull();
  });
});
