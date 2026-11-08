/**
 * Regression: scheduled posting vs YNAB4.
 *
 * 1. Deterministic posted ids / `dateEnteredFromSchedule`
 *    (`ScheduledTransaction.as:184-196`): YNAB4 mints the posted row id via
 *    `idCreator.createTransactionIdForEnteredScheduledTransaction(
 *      scheduleEntityId, date)` and stamps `dateEnteredFromSchedule`, so
 *    re-entering the same occurrence yields the SAME row (idempotent).
 *    Fix commit: 3a91b83 (g-sched-post-ids).
 *
 * 2. Scheduled unbalanced splits (import-ynab4.ts): when the file's
 *    scheduled parent amount disagrees with the children sum, the file value
 *    is preserved and a repair warning is recorded.
 *    Fix commit: 6d25403 (g-sched-split).
 *
 * 3. Catch-up posting is unbounded like YNAB4's `enterDueOccurrences`
 *    (`ScheduledTransaction.as:175-179`): all due occurrences post
 *    (no 5-per-rule cap parked in `capped`).
 *    Fix commit: 6d25403 (g-sched-split).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  autoPostDueRecurringTransactions,
  createRecurring,
  postRecurringTransaction,
  updateRecurring,
} from "../src/queries/recurring.js";
import { deleteTransaction } from "../src/queries/transactions.js";
import { importYnab4 } from "../src/import-ynab4.js";

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

async function seedAccount(db: Db) {
  const [acct] = await db
    .insert(schema.accounts)
    .values({ name: "Checking", kind: "liquid", groupLabel: "Budget", balance: 0 })
    .returning();
  return acct!;
}

describe("ynab4 parity: scheduled post has deterministic posted id (YNAB4 dateEnteredFromSchedule)", () => {
  it("re-posting the same occurrence after delete yields the same row id", async () => {
    const db = openMigratedDb();
    const acct = await seedAccount(db);
    const rule = await createRecurring(db, {
      accountId: acct.id,
      categoryId: null,
      payee: "Rent",
      amount: -10000,
      frequency: "monthly",
      nextDate: "2026-03-01",
    });

    const first = await postRecurringTransaction(db, rule!.id);
    const firstId = (first.transaction as { id: number }).id;
    await deleteTransaction(db, firstId);

    // Rewind to the same occurrence and post it again.
    await updateRecurring(db, rule!.id, { nextDate: "2026-03-01" });
    const second = await postRecurringTransaction(db, rule!.id);
    const secondId = (second.transaction as { id: number }).id;

    // YNAB4: idCreator.createTransactionIdForEnteredScheduledTransaction
    // (scheduleId, date) — same occurrence, same id.
    expect(secondId).toBe(firstId);
  });
});

function unbalancedSplitFixture() {
  return {
    accounts: [
      { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
    ],
    payees: [{ entityId: "p1", name: "Grocery Store" }],
    masterCategories: [
      {
        entityId: "mc1",
        name: "Everyday",
        type: "OUTFLOW",
        subCategories: [{ entityId: "sc1", name: "Groceries" }],
      },
    ],
    transactions: [],
    monthlyBudgets: [],
    scheduledTransactions: [
      {
        entityId: "sched-unbalanced",
        accountId: "acc1",
        date: "2026-07-01",
        // $100.00 parent vs $60 + $30 children: off by $10.
        amount: 100,
        frequency: "monthly",
        payeeId: "p1",
        categoryId: "Category/__Split__",
        subTransactions: [
          { categoryId: "sc1", amount: 60 },
          { categoryId: "sc1", amount: 30 },
        ],
      },
    ],
  };
}

describe("ynab4 parity: unbalanced scheduled split preserved on import", () => {
  it("preserves the file's scheduled parent amount (10000c) instead of rebasing to the children sum", async () => {
    const db = openMigratedDb();
    await importYnab4(db, unbalancedSplitFixture());
    const rows = await db.select().from(schema.recurring);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount)).toBe(10000);
  });

  it("emits a repair warning when a scheduled split is rebalanced", async () => {
    const db = openMigratedDb();
    const result = await importYnab4(db, unbalancedSplitFixture());
    expect(result.warnings.join("\n")).toMatch(/repair|rebalanc|split.*sum|sum.*split/i);
  });
});

describe("ynab4 parity: catch-up posting is unbounded (YNAB4 while-loop)", () => {
  it("posts all 10 due daily occurrences, not just the first 5", async () => {
    const db = openMigratedDb();
    const acct = await seedAccount(db);
    await createRecurring(db, {
      accountId: acct.id,
      categoryId: null,
      payee: "Daily",
      amount: -100,
      frequency: "daily",
      nextDate: "2026-01-01",
    });

    const result = await autoPostDueRecurringTransactions(db, "2026-01-10");

    // YNAB4 enterDueOccurrences posts every due occurrence (10 here).
    expect(result.posted).toHaveLength(10);
  });
});
