import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeUnflaggedDuplicates } from "../src/queries/duplicates.js";
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

async function seedAccount(db: Db) {
  const [a] = await db
    .insert(schema.accounts)
    .values({
      name: "Chequing",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 0,
      onBudget: true,
      sort: 0,
    })
    .returning();
  return a!.id;
}

async function insertTx(db: Db, over: Partial<typeof schema.transactions.$inferInsert>) {
  const [row] = await db
    .insert(schema.transactions)
    .values({
      accountId: 1,
      date: "2026-06-01",
      payee: "Store",
      memo: "",
      amount: -1000,
      status: "c",
      flagColor: null,
      transferAccountId: null,
      parentId: null,
      ...over,
    })
    .returning();
  return row!.id;
}

describe("analyzeUnflaggedDuplicates", () => {
  let db: Db;

  beforeEach(async () => {
    db = openMigratedDb();
    await seedAccount(db);
  });

  it("marks unflagged duplicates with the internal marker and leaves manual/reconciled untouched", async () => {
    await insertTx(db, { payee: "Store" });
    await insertTx(db, { payee: "Store" });
    await insertTx(db, { payee: "Store", flagColor: "red" });
    await insertTx(db, { payee: "Store", status: "r" });

    const result = await analyzeUnflaggedDuplicates(db);
    expect(result.duplicateCount).toBe(3);
    expect(result.flaggedCount).toBe(1);
    expect(result.alreadyFlaggedCount).toBe(1);
    expect(result.lockedCount).toBe(1);
    expect(result.clearedCount).toBe(0);
    expect(result.groups).toHaveLength(1);

    const data = await getBudgetData(db);
    const cleared = data.transactions.filter((t) => t.status === "c");
    expect(new Set(cleared.map((t) => t.flagColor))).toEqual(new Set([null, "duplicate", "red"]));
    expect(data.transactions.find((t) => t.status === "r")!.flagColor).toBeNull();
    expect(data.transactions.find((t) => t.flagColor === "red")).toBeTruthy();
    expect(data.transactions.find((t) => t.flagColor === "duplicate")).toBeTruthy();
  });

  it("treats an existing manual yellow flag as user-owned (not cleared, not overridden)", async () => {
    await insertTx(db, { payee: "Store" });
    await insertTx(db, { payee: "Store", flagColor: "yellow" });

    const result = await analyzeUnflaggedDuplicates(db);
    expect(result.flaggedCount).toBe(0);
    expect(result.alreadyFlaggedCount).toBe(1);
    expect(result.clearedCount).toBe(0);

    const data = await getBudgetData(db);
    const flagged = data.transactions.filter((t) => t.flagColor != null);
    expect(flagged.map((t) => t.flagColor)).toEqual(["yellow"]);
  });

  it("is idempotent when run twice", async () => {
    await insertTx(db, { payee: "Store" });
    await insertTx(db, { payee: "Store" });

    const first = await analyzeUnflaggedDuplicates(db);
    expect(first.flaggedCount).toBe(1);

    const second = await analyzeUnflaggedDuplicates(db);
    expect(second.flaggedCount).toBe(0);
    expect(second.alreadyFlaggedCount).toBe(1);
    expect(second.clearedCount).toBe(0);
  });

  it("clears the internal marker when a transaction is no longer a duplicate", async () => {
    const keeper = await insertTx(db, { payee: "Store" });
    const dup = await insertTx(db, { payee: "Store" });

    const first = await analyzeUnflaggedDuplicates(db);
    expect(first.flaggedCount).toBe(1);

    // Remove the keeper: the remaining row no longer forms a duplicate group.
    await db.delete(schema.transactions).where(eq(schema.transactions.id, keeper));

    const second = await analyzeUnflaggedDuplicates(db);
    expect(second.flaggedCount).toBe(0);
    expect(second.clearedCount).toBe(1);
    expect(second.duplicateCount).toBe(0);

    const data = await getBudgetData(db);
    const row = data.transactions.find((t) => t.id === dup)!;
    expect(row.flagColor).toBeNull();
  });

  it("does not clear the internal marker on reconciled rows", async () => {
    const keeper = await insertTx(db, { payee: "Store" });
    const dup = await insertTx(db, { payee: "Store" });
    await analyzeUnflaggedDuplicates(db);

    // Make the duplicate reconciled, then remove the keeper so the group
    // disappears — the reconciled row must keep its marker.
    await db
      .update(schema.transactions)
      .set({ status: "r" })
      .where(eq(schema.transactions.id, dup));
    await db.delete(schema.transactions).where(eq(schema.transactions.id, keeper));

    const result = await analyzeUnflaggedDuplicates(db);
    expect(result.clearedCount).toBe(0);

    const data = await getBudgetData(db);
    expect(data.transactions.find((t) => t.id === dup)!.flagColor).toBe("duplicate");
  });

  it("ignores split parents, split children, and transfers", async () => {
    const [second] = await db
      .insert(schema.accounts)
      .values({
        name: "Visa",
        kind: "credit",
        groupLabel: "Credit Cards",
        balance: 0,
        onBudget: true,
        sort: 1,
      })
      .returning();
    const parentId = await insertTx(db, { amount: -15000 });
    await insertTx(db, { parentId, amount: -10000, memo: "child1" });
    await insertTx(db, { parentId, amount: -5000, memo: "child2" });
    // Transfer row: identical account/date/amount/payee/memo to a plain row.
    await insertTx(db, { payee: "Transfer : Visa", transferAccountId: second!.id });

    const result = await analyzeUnflaggedDuplicates(db);
    expect(result.groups).toHaveLength(0);
    expect(result.duplicateCount).toBe(0);
  });

  it("reports duplicates with account names", async () => {
    await insertTx(db, { payee: "Store" });
    await insertTx(db, { payee: "Store" });

    const result = await analyzeUnflaggedDuplicates(db);
    expect(result.groups[0]!.keeper.accountName).toBe("Chequing");
    expect(result.groups[0]!.duplicates[0]!.accountName).toBe("Chequing");
  });
});
