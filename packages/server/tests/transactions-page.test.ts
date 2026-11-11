import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { TransactionError, TransactionResponseSchema } from "@ynab/logic";
import * as schema from "../src/schema.js";
import { getBudgetData } from "../src/queries/budget.js";
import {
  decodeTransactionCursor,
  encodeTransactionCursor,
  listTransactionsPage,
} from "../src/queries/transactions/list.js";

describe("listTransactionsPage (P1 pagination)", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

  type TestDb = ReturnType<typeof openMigratedDb>;

  function openMigratedDb() {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  /** Direct inserts (no balance side-effects); ids grow in insertion order. */
  async function seedTransactions(
    db: TestDb,
    accountId: number,
    rows: { date: string; payee: string; amount?: number }[]
  ) {
    for (const r of rows) {
      await db.insert(schema.transactions).values({
        accountId,
        date: r.date,
        payee: r.payee,
        amount: r.amount ?? -100,
      });
    }
  }

  async function seedAccount(db: TestDb, name: string): Promise<number> {
    const [account] = await db
      .insert(schema.accounts)
      .values({ name, kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort: 0 })
      .returning();
    return account!.id;
  }

  async function walkAll(db: TestDb, limit: number, accountId?: number) {
    const seen: { id: number; date: string }[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listTransactionsPage(db, { accountId, before, limit });
      for (const t of page.transactions) seen.push({ id: t.id, date: t.date });
      pages++;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      before = page.nextCursor!;
      if (pages > 50) throw new Error("pagination did not terminate");
    }
    return seen;
  }

  it("walks every row in (date DESC, id DESC) order with no dupes or skips", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db, "Checking");
    await seedTransactions(db, accountId, [
      { date: "2026-08-03", payee: "newest" },
      { date: "2026-08-01", payee: "old-a" },
      { date: "2026-08-02", payee: "mid" },
      { date: "2026-08-01", payee: "old-b" },
      { date: "2026-08-01", payee: "old-c" },
    ]);

    const walked = await walkAll(db, 2);
    const expected = await db
      .select({ id: schema.transactions.id, date: schema.transactions.date })
      .from(schema.transactions)
      .orderBy(desc(schema.transactions.date), desc(schema.transactions.id));

    expect(walked).toEqual(expected.map((r) => ({ id: r.id, date: r.date })));
    // Same-date ties break on id DESC: old-c, old-b, old-a.
    expect(walked.slice(-3).map((r) => r.id)).toEqual(
      [...walked.slice(-3)].sort((a, b) => b.id - a.id).map((r) => r.id)
    );
  });

  it("matches the getBudgetData row shape exactly (no drift)", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db, "Checking");
    await seedTransactions(db, accountId, [
      { date: "2026-08-02", payee: "b" },
      { date: "2026-08-01", payee: "a" },
    ]);

    const walked = await walkAll(db, 1);
    const data = await getBudgetData(db);
    expect(data.transactions.map((t) => ({ id: t.id, date: t.date }))).toEqual(walked);
    for (const t of data.transactions) {
      expect(() => TransactionResponseSchema.parse(t)).not.toThrow();
    }
  });

  it("filters by accountId", async () => {
    const db = openMigratedDb();
    const checking = await seedAccount(db, "Checking");
    const savings = await seedAccount(db, "Savings");
    await seedTransactions(db, checking, [
      { date: "2026-08-01", payee: "c1" },
      { date: "2026-08-02", payee: "c2" },
    ]);
    await seedTransactions(db, savings, [{ date: "2026-08-03", payee: "s1" }]);

    const page = await listTransactionsPage(db, { accountId: savings });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]!.payee).toBe("s1");
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("a newer insert after the first page lands earlier, never duped or skipped", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db, "Checking");
    await seedTransactions(db, accountId, [
      { date: "2026-08-01", payee: "old" },
      { date: "2026-08-02", payee: "mid" },
    ]);

    const first = await listTransactionsPage(db, { limit: 1 });
    expect(first.transactions[0]!.payee).toBe("mid");

    await seedTransactions(db, accountId, [{ date: "2026-08-05", payee: "brand-new" }]);
    const second = await listTransactionsPage(db, { limit: 1, before: first.nextCursor! });
    expect(second.transactions.map((t) => t.payee)).toEqual(["old"]);
    expect(second.hasMore).toBe(false);
  });

  it("rejects malformed cursors and bad limits with 400", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db, "Checking");
    await seedTransactions(db, accountId, [{ date: "2026-08-01", payee: "x" }]);

    for (const before of ["garbage", "!!!", encodeTransactionCursor("not-a-date", 1), encodeTransactionCursor("2026-08-01", -3)]) {
      await expect(listTransactionsPage(db, { before })).rejects.toMatchObject({
        name: "TransactionError",
        status: 400,
      });
    }
    await expect(listTransactionsPage(db, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(listTransactionsPage(db, { accountId: -2 })).rejects.toMatchObject({ status: 400 });
  });

  it("clamps oversized limits instead of building an unbounded SELECT", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db, "Checking");
    await seedTransactions(
      db,
      accountId,
      Array.from({ length: 10 }, (_, i) => ({ date: "2026-08-01", payee: `t${i}` }))
    );
    const page = await listTransactionsPage(db, { limit: 100000 });
    expect(page.transactions).toHaveLength(10);
    expect(page.hasMore).toBe(false);
  });

  it("cursor encode/decode round-trips and rejects tampering", () => {
    const cursor = encodeTransactionCursor("2026-08-15", 42);
    expect(decodeTransactionCursor(cursor)).toEqual({ date: "2026-08-15", id: 42 });
    expect(() => decodeTransactionCursor("")).toThrow(TransactionError);
    expect(() => decodeTransactionCursor(cursor.slice(0, -2))).toThrow(TransactionError);
  });
});
