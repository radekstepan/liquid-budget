import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema.js";
import {
  getReconcileState,
  reconcileAccount,
  unreconcileAccount,
} from "../src/queries/reconcile.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

const STATEMENT_DATE = "2026-08-15";

describe("reconcileAccount idempotency (P1 reconcile-idempotency)", () => {
  function openMigratedDb(): Db {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  async function seedAccount(db: Db, balance = 0): Promise<number> {
    const [a] = await db
      .insert(schema.accounts)
      .values({ name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance, onBudget: true, sort: 0 })
      .returning();
    return a!.id;
  }

  async function seedCategory(db: Db): Promise<number> {
    const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
    const [cat] = await db.insert(schema.categories).values({ groupId: group!.id, name: "Groceries", sort: 0 }).returning();
    return cat!.id;
  }

  async function seedCleared(db: Db, accountId: number, amounts: number[]) {
    for (const [i, amount] of amounts.entries()) {
      await db.insert(schema.transactions).values({
        accountId,
        date: `2026-08-0${i + 1}`,
        payee: `Store ${i}`,
        amount,
        status: "c",
      });
    }
  }

  async function roundCount(db: Db): Promise<number> {
    return (await db.select({ id: schema.reconciliations.id }).from(schema.reconciliations)).length;
  }

  it("replayed submit with no changes mints no second row", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedCleared(db, accountId, [-1000, -2000]);

    const first = await reconcileAccount(db, { accountId, statementBalance: -3000, statementDate: STATEMENT_DATE });
    expect(first.reconciledCount).toBe(2);
    expect(first.adjustmentTransactionId).toBeNull();
    expect(await roundCount(db)).toBe(1);

    const replay = await reconcileAccount(db, { accountId, statementBalance: -3000, statementDate: STATEMENT_DATE });
    expect(replay).toEqual({
      reconciledCount: 0,
      adjustmentTransactionId: null,
      finalDiff: 0,
      lastReconciledAt: first.lastReconciledAt,
    });
    expect(await roundCount(db)).toBe(1);
  });

  it("one unreconcile undoes the real round after a replayed double", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedCleared(db, accountId, [-1000, -2000]);

    await reconcileAccount(db, { accountId, statementBalance: -3000, statementDate: STATEMENT_DATE });
    await reconcileAccount(db, { accountId, statementBalance: -3000, statementDate: STATEMENT_DATE });

    const undone = await unreconcileAccount(db, accountId);
    expect(undone.flipped).toBe(2);
    expect(await roundCount(db)).toBe(0);
    const state = await getReconcileState(db, accountId, STATEMENT_DATE);
    expect(state.clearedCount).toBe(2);
    expect(state.lastReconciledAt).toBeNull();
  });

  it("adjustment rounds replay without a second adjustment transaction", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const categoryId = await seedCategory(db);
    await seedCleared(db, accountId, [-3000]);

    const first = await reconcileAccount(db, {
      accountId,
      statementBalance: -3500,
      statementDate: STATEMENT_DATE,
      adjustmentCategoryId: categoryId,
    });
    expect(first.adjustmentTransactionId).not.toBeNull();
    expect(await roundCount(db)).toBe(1);

    const replay = await reconcileAccount(db, {
      accountId,
      statementBalance: -3500,
      statementDate: STATEMENT_DATE,
      adjustmentCategoryId: categoryId,
    });
    expect(replay.adjustmentTransactionId).toBeNull();
    expect(replay.reconciledCount).toBe(0);
    expect(await roundCount(db)).toBe(1);
    const adjustments = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.payee, "Reconciliation balance"));
    expect(adjustments).toHaveLength(1);
  });

  it("first-time reconcile on an empty account still records a round", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const result = await reconcileAccount(db, { accountId, statementBalance: 0, statementDate: STATEMENT_DATE });
    expect(result.reconciledCount).toBe(0);
    expect(await roundCount(db)).toBe(1);
  });

  it("new cleared activity after a round proceeds as a new round", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedCleared(db, accountId, [-1000]);

    await reconcileAccount(db, { accountId, statementBalance: -1000, statementDate: STATEMENT_DATE });
    await seedCleared(db, accountId, [-500]);
    const second = await reconcileAccount(db, { accountId, statementBalance: -1500, statementDate: STATEMENT_DATE });
    expect(second.reconciledCount).toBe(1);
    expect(await roundCount(db)).toBe(2);
  });
});
