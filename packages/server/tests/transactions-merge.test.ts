import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import {
  createSplitWithChildren,
  createTransaction,
  createTransfer,
  mergeTransactions,
  TransactionError,
} from "../src/queries/transactions.js";
import * as schema from "../src/schema.js";

describe("mergeTransactions", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

  function openMigratedDb() {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  async function seedTestData(db: ReturnType<typeof openMigratedDb>) {
    const [account] = await db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 0,
        onBudget: true,
        sort: 0,
      })
      .returning();

    const [savings] = await db
      .insert(schema.accounts)
      .values({
        name: "Savings",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 0,
        onBudget: true,
        sort: 1,
      })
      .returning();

    const [group] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday Expenses", sort: 0 })
      .returning();

    const [groceries] = await db
      .insert(schema.categories)
      .values({ name: "Groceries", groupId: group!.id, sort: 0 })
      .returning();

    return { accountId: account!.id, savingsId: savings!.id, groceriesId: groceries!.id };
  }

  async function balanceOf(db: ReturnType<typeof openMigratedDb>, accountId: number) {
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
    return row?.balance ?? null;
  }

  /** Mark a row as a freshly imported (CSV-style) transaction: uncleared + needs review. */
  async function markImported(db: ReturnType<typeof openMigratedDb>, id: number) {
    await db
      .update(schema.transactions)
      .set({ status: "u", needsReview: true })
      .where(eq(schema.transactions.id, id));
  }

  it("merges a manual + imported duplicate with imported data winning", async () => {
    const db = openMigratedDb();
    const { accountId, groceriesId } = await seedTestData(db);

    const manual = await createTransaction(db, {
      accountId,
      categoryId: groceriesId,
      date: "2026-08-02",
      payee: "Whole Foods",
      memo: "weekly shop",
      amount: -4999,
      status: "c",
      flagColor: "red",
    });
    const imported = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "WHOLE FOODS #24",
      amount: -5000,
      status: "c",
    });
    await markImported(db, imported.id);
    expect(await balanceOf(db, accountId)).toBe(-9999);

    const { merged, deletedId } = await mergeTransactions(db, [manual.id, imported.id]);

    // The imported row survives; the manual duplicate is deleted.
    expect(merged.id).toBe(imported.id);
    expect(deletedId).toBe(manual.id);

    // Imported bank data wins...
    expect(merged.date).toBe("2026-08-01");
    expect(merged.amount).toBe(-5000);
    expect(merged.payee).toBe("WHOLE FOODS #24");
    expect(merged.status).toBe("u");
    expect(merged.needsReview).toBe(true);
    // ...while manual curation fills gaps the import left empty.
    expect(merged.categoryId).toBe(groceriesId);
    expect(merged.memo).toBe("weekly shop");
    expect(merged.flagColor).toBe("red");

    const remaining = await db.select().from(schema.transactions);
    expect(remaining).toHaveLength(1);
    expect(await balanceOf(db, accountId)).toBe(-5000);
  });

  it("prefers the imported row even when it has the lower id (order-independent)", async () => {
    const db = openMigratedDb();
    const { accountId } = await seedTestData(db);

    const imported = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "WHOLE FOODS #24",
      amount: -5000,
      status: "c",
    });
    await markImported(db, imported.id);
    const manual = await createTransaction(db, {
      accountId,
      date: "2026-08-02",
      payee: "Whole Foods",
      amount: -5000,
      status: "c",
    });

    const { merged, deletedId } = await mergeTransactions(db, [manual.id, imported.id]);
    expect(merged.id).toBe(imported.id);
    expect(deletedId).toBe(manual.id);
    expect(await balanceOf(db, accountId)).toBe(-5000);
  });

  it("merges two manual rows with the lower id surviving", async () => {
    const db = openMigratedDb();
    const { accountId, groceriesId } = await seedTestData(db);

    const first = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "Cafe",
      amount: -300,
      status: "c",
    });
    const second = await createTransaction(db, {
      accountId,
      categoryId: groceriesId,
      date: "2026-08-02",
      payee: "Cafe Nero",
      memo: "latte",
      amount: -350,
      status: "c",
    });

    const { merged, deletedId } = await mergeTransactions(db, [second.id, first.id]);
    expect(merged.id).toBe(first.id);
    expect(deletedId).toBe(second.id);
    expect(merged.payee).toBe("Cafe");
    expect(merged.amount).toBe(-300);
    expect(merged.categoryId).toBe(groceriesId);
    expect(merged.memo).toBe("latte");
    expect(await balanceOf(db, accountId)).toBe(-300);
  });

  it("merges two transfers and keeps both account balances correct", async () => {
    const db = openMigratedDb();
    const { accountId, savingsId } = await seedTestData(db);

    const first = await createTransfer(
      db,
      {
        accountId,
        date: "2026-08-01",
        payee: "",
        amount: -10000,
        status: "c",
      },
      savingsId
    );
    const second = await createTransfer(
      db,
      {
        accountId,
        date: "2026-08-01",
        payee: "",
        amount: -10000,
        status: "c",
      },
      savingsId
    );
    expect(await balanceOf(db, accountId)).toBe(-20000);
    expect(await balanceOf(db, savingsId)).toBe(20000);

    const { merged } = await mergeTransactions(db, [first.id, second.id]);
    expect(merged.transferAccountId).toBe(savingsId);
    expect(await balanceOf(db, accountId)).toBe(-10000);
    expect(await balanceOf(db, savingsId)).toBe(10000);
  });

  it("rejects anything but exactly two distinct ids", async () => {
    const db = openMigratedDb();
    const { accountId } = await seedTestData(db);
    const one = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "A",
      amount: -100,
    });
    const two = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "B",
      amount: -100,
    });

    await expect(mergeTransactions(db, [one.id])).rejects.toThrow(TransactionError);
    await expect(mergeTransactions(db, [one.id, two.id, one.id])).rejects.toThrow(TransactionError);
    await expect(mergeTransactions(db, [one.id, one.id])).rejects.toThrow(TransactionError);
  });

  it("returns 404 when either transaction is missing", async () => {
    const db = openMigratedDb();
    const { accountId } = await seedTestData(db);
    const one = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "A",
      amount: -100,
    });

    const err = await mergeTransactions(db, [one.id, 9999]).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.status).toBe(404);
  });

  it("refuses to merge reconciled (locked) transactions", async () => {
    const db = openMigratedDb();
    const { accountId } = await seedTestData(db);
    const one = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "A",
      amount: -100,
    });
    const two = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "B",
      amount: -100,
    });
    await db
      .update(schema.transactions)
      .set({ status: "r" })
      .where(eq(schema.transactions.id, two.id));

    const err = await mergeTransactions(db, [one.id, two.id]).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.status).toBe(422);
  });

  it("refuses to merge split parents and split children", async () => {
    const db = openMigratedDb();
    const { accountId, groceriesId } = await seedTestData(db);
    const split = await createSplitWithChildren(
      db,
      { accountId, date: "2026-08-01", payee: "Costco", memo: "", amount: -10000 },
      [
        { categoryId: groceriesId, amount: -6000 },
        { categoryId: groceriesId, amount: -4000 },
      ]
    );
    const plain = await createTransaction(db, {
      accountId,
      date: "2026-08-01",
      payee: "Cafe",
      amount: -300,
    });

    await expect(mergeTransactions(db, [split.parent.id, plain.id])).rejects.toThrow(
      /split/i
    );
    await expect(
      mergeTransactions(db, [split.children[0]!.id, plain.id])
    ).rejects.toThrow(/split/i);
  });
});
