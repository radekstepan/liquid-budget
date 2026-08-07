/**
 * migrate.test.ts
 *
 * Integration test for the Drizzle migration system. Opens an in-memory
 * SQLite DB, applies the migration folder, then asserts every table and
 * the unique index exist with the right columns.
 *
 * This is the test counterpart to the "Implement standard Drizzle
 * migrations instead of try/catch table alters" refactor (replaces the
 * hand-rolled `ensureTables` function and its try/catch ALTER blocks
 * in `seed.ts`).
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";

type Db = BetterSQLite3Database<typeof schema>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openInMemoryDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  return { db, raw };
}

function tableInfo(raw: Database.Database, table: string): Array<{ name: string; type: string; notnull: number; pk: number }> {
  return raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
}

describe("Drizzle migrations", () => {
  let ctx: { db: Db; raw: Database.Database };
  beforeEach(() => {
    ctx = openInMemoryDb();
  });

  it("creates every table in the schema", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });
    const tables = ctx.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    // All 7 app tables. `__drizzle_migrations` is the bookkeeping table
    // drizzle creates; we expect it too.
    expect(tableNames).toContain("accounts");
    expect(tableNames).toContain("category_groups");
    expect(tableNames).toContain("categories");
    expect(tableNames).toContain("assignments");
    expect(tableNames).toContain("transactions");
    expect(tableNames).toContain("recurring");
    expect(tableNames).toContain("recurring_sub_transactions");
    expect(tableNames).toContain("__drizzle_migrations");
  });

  it("creates the assignments unique index", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });
    const indexes = ctx.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='assignments'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("assignments_cat_month_uniq");
  });

  it("includes every column that the legacy ALTER blocks used to add", () => {
    // These were the four columns previously bolted on via
    // `db.run(ALTER TABLE …)` try/catch blocks in seed.ts. They are
    // now first-class columns in the schema and the migration.
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });

    const accountsCols = tableInfo(ctx.raw, "accounts").map((c) => c.name);
    expect(accountsCols).toContain("last_reconciled_at");
    expect(accountsCols).toContain("last_reconciled_balance");

    const transactionsCols = tableInfo(ctx.raw, "transactions").map((c) => c.name);
    expect(transactionsCols).toContain("status");
    expect(transactionsCols).toContain("transfer_account_id");

    const recurringCols = tableInfo(ctx.raw, "recurring").map((c) => c.name);
    expect(recurringCols).toContain("transfer_account_id");
  });

  it("is idempotent — running twice does not fail or duplicate", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });
    // Re-running is the hot path on every server boot. drizzle tracks
    // applied migrations in `__drizzle_migrations` and skips them.
    expect(() => migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();
    const tables = ctx.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    // 7 app tables + __drizzle_migrations + sqlite_sequence (the
    // SQLite-internal bookkeeping table for AUTOINCREMENT columns).
    // No duplicates. sqlite_sequence is excluded from the count.
    const systemTables = new Set(["__drizzle_migrations", "sqlite_sequence"]);
    const appTableCount = tableNames.filter((n) => !systemTables.has(n)).length;
    expect(appTableCount).toBe(7);
  });
});
