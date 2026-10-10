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
    expect(tableNames).toContain("reconciliations");
    expect(tableNames).toContain("rename_rules");
    expect(tableNames).toContain("duplicate_ignores");
    expect(tableNames).toContain("__drizzle_migrations");
  });

  it("creates indexes on assignments and recurring tables (UNI-31 / BUG-14)", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });
    const indexes = ctx.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("assignments_cat_month_uniq");
    expect(indexNames).toContain("recurring_account_id_idx");
    expect(indexNames).toContain("recurring_next_date_idx");
    expect(indexNames).toContain("recurring_sub_transactions_recurring_id_idx");
  });

  it("includes every column that the legacy ALTER blocks used to add", () => {
    // These were the four columns previously bolted on via
    // `db.run(ALTER TABLE …)` try/catch blocks in seed.ts. They are
    // now first-class columns in the schema and the migration.
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });

    const accountsCols = tableInfo(ctx.raw, "accounts").map((c) => c.name);
    expect(accountsCols).toContain("last_reconciled_at");
    expect(accountsCols).toContain("last_reconciled_balance");
    expect(accountsCols).toContain("archived");
    expect(accountsCols).toContain("entity_id");

    const categoryGroupsCols = tableInfo(ctx.raw, "category_groups").map((c) => c.name);
    expect(categoryGroupsCols).toContain("entity_id");

    const categoriesCols = tableInfo(ctx.raw, "categories").map((c) => c.name);
    expect(categoriesCols).toContain("entity_id");

    const payeesCols = tableInfo(ctx.raw, "payees").map((c) => c.name);
    expect(payeesCols).toContain("entity_id");

    const transactionsCols = tableInfo(ctx.raw, "transactions").map((c) => c.name);
    expect(transactionsCols).toContain("status");
    expect(transactionsCols).toContain("transfer_status");
    expect(transactionsCols).toContain("transfer_account_id");
    expect(transactionsCols).toContain("reconciliation_id");
    expect(transactionsCols).toContain("transfer_reconciliation_id");
    expect(transactionsCols).toContain("transfer_reconciled_at");
    expect(transactionsCols).toContain("entity_id");
    expect(transactionsCols).toContain("transfer_entity_id");
    expect(transactionsCols).toContain("needs_review");

    const recurringCols = tableInfo(ctx.raw, "recurring").map((c) => c.name);
    expect(recurringCols).toContain("transfer_account_id");
    expect(recurringCols).toContain("anchor_day");
    expect(recurringCols).toContain("entity_id");

    const recurringSubCols = tableInfo(ctx.raw, "recurring_sub_transactions").map((c) => c.name);
    expect(recurringSubCols).toContain("entity_id");

    const reconciliationsCols = tableInfo(ctx.raw, "reconciliations").map((c) => c.name);
    expect(reconciliationsCols).toContain("entity_id");
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
    // 10 app tables + __drizzle_migrations + sqlite_sequence (the
    // SQLite-internal bookkeeping table for AUTOINCREMENT columns).
    // No duplicates. sqlite_sequence is excluded from the count.
    const systemTables = new Set(["__drizzle_migrations", "sqlite_sequence"]);
    const appTableCount = tableNames.filter((n) => !systemTables.has(n)).length;
    expect(appTableCount).toBe(11);
  });

  it("enforces DB-level CHECK constraints (UNI-29 / BUG-12, F-19)", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });

    // accounts.kind CHECK constraint ('liquid', 'credit', 'offbudget')
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO accounts (name, kind, group_label, balance, on_budget, sort) VALUES ('Bad', 'invalid_kind', 'Group', 0, 1, 0)"
      ).run();
    }).toThrow(/CHECK constraint failed/i);

    // Valid account
    ctx.raw.prepare(
      "INSERT INTO accounts (id, name, kind, group_label, balance, on_budget, sort) VALUES (1, 'Good', 'liquid', 'Liquid', 0, 1, 0)"
    ).run();

    // transactions.status CHECK constraint ('u', 'c', 'r')
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, status) VALUES (1, '2026-06-01', 'P', '', 100, 'x')"
      ).run();
    }).toThrow(/CHECK constraint failed/i);

    // transactions.transfer_status CHECK constraint ('u', 'c', 'r')
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, status, transfer_status) VALUES (1, '2026-06-01', 'P', '', 100, 'c', 'x')"
      ).run();
    }).toThrow(/CHECK constraint failed/i);
  });

  it("enforces unique constraints on category groups and categories (UNI-30 / BUG-13)", () => {
    migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER });

    // Insert category group
    ctx.raw.prepare(
      "INSERT INTO category_groups (id, name, sort, is_credit_card_payments) VALUES (1, 'Immediate Obligations', 0, 0)"
    ).run();

    // Duplicate category group name should fail
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO category_groups (id, name, sort, is_credit_card_payments) VALUES (2, 'Immediate Obligations', 1, 0)"
      ).run();
    }).toThrow(/UNIQUE constraint failed/i);

    // Insert category under group 1
    ctx.raw.prepare(
      "INSERT INTO categories (id, group_id, name, sort, carryover) VALUES (1, 1, 'Rent', 0, 0)"
    ).run();

    // Duplicate category name in same group should fail
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO categories (id, group_id, name, sort, carryover) VALUES (2, 1, 'Rent', 1, 0)"
      ).run();
    }).toThrow(/UNIQUE constraint failed/i);

    // Same category name in different group should succeed
    ctx.raw.prepare(
      "INSERT INTO category_groups (id, name, sort, is_credit_card_payments) VALUES (3, 'Other Obligations', 2, 0)"
    ).run();
    expect(() => {
      ctx.raw.prepare(
        "INSERT INTO categories (id, group_id, name, sort, carryover) VALUES (3, 3, 'Rent', 0, 0)"
      ).run();
    }).not.toThrow();
  });
});
