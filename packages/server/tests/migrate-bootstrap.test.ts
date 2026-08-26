/**
 * migrate-bootstrap.test.ts
 *
 * Covers the legacy-DB upgrade path that `migrate.test.ts` cannot: a
 * database whose app tables were created by the legacy hand-rolled
 * schema code (same shape as migration 0000, but no
 * `__drizzle_migrations` row). `bootstrapMigrationJournal` must insert
 * a synthetic journal row so drizzle's `migrate()` skips migration
 * 0000 instead of failing with "table already exists".
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { bootstrapMigrationJournal } from "../src/migrate-bootstrap.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openRaw(): { db: Db; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  return { db: drizzle(raw, { schema }), raw };
}

function expectedHash0000(): string {
  const file = readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf-8");
  const tag = (JSON.parse(file) as { entries: Array<{ tag: string }> }).entries[0]!.tag;
  const sql = readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf-8");
  return createHash("sha256").update(sql).digest("hex");
}

function initLegacyTables(raw: Database.Database) {
  const file = readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf-8");
  const tag = (JSON.parse(file) as { entries: Array<{ tag: string }> }).entries[0]!.tag;
  const sql = readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf-8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    raw.exec(stmt);
  }
}

describe("bootstrapMigrationJournal", () => {
  it("is a no-op on a fresh database", () => {
    const { db } = openRaw();
    expect(bootstrapMigrationJournal(db)).toBe("noop");
    // And the normal migration path still works from scratch.
    expect(() => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();
  });

  it("bootstraps a legacy database when __drizzle_migrations is absent and allows migrate() to succeed", () => {
    const { db, raw } = openRaw();
    initLegacyTables(raw);

    // Legacy database has tables (e.g. accounts) but __drizzle_migrations does not exist yet.
    expect(bootstrapMigrationJournal(db)).toBe("bootstrapped");

    const rows = raw.prepare("SELECT hash, created_at FROM __drizzle_migrations").all() as Array<{
      hash: string;
      created_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe(expectedHash0000());
    expect(typeof rows[0]!.created_at).toBe("number");

    // With the row in place, migrate() no longer tries to re-apply 0000.
    expect(() => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();

    // And a second bootstrap call is a no-op.
    expect(bootstrapMigrationJournal(db)).toBe("noop");
  });

  it("bootstraps and preserves data in a populated legacy database", () => {
    const { db, raw } = openRaw();
    initLegacyTables(raw);

    // Insert legacy user data before migration
    raw.prepare(
      "INSERT INTO accounts (id, name, kind, group_label, balance, on_budget, sort) VALUES (1, 'Legacy Checking', 'liquid', 'Checking', 50000, 1, 0)"
    ).run();
    raw.prepare(
      "INSERT INTO transactions (id, account_id, date, payee, memo, amount, status) VALUES (1, 1, '2026-01-01', 'Opening Balance', '', 50000, 'c')"
    ).run();

    // Bootstrap and migrate
    expect(bootstrapMigrationJournal(db)).toBe("bootstrapped");
    raw.pragma("foreign_keys = OFF");
    try {
      expect(() => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();
    } finally {
      raw.pragma("foreign_keys = ON");
    }

    // Verify data is completely intact and accessible
    const accounts = raw.prepare("SELECT * FROM accounts WHERE id = 1").all() as Array<{ name: string; balance: number }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe("Legacy Checking");
    expect(accounts[0]!.balance).toBe(50000);

    const txs = raw.prepare("SELECT * FROM transactions WHERE id = 1").all() as Array<{ payee: string; amount: number }>;
    expect(txs).toHaveLength(1);
    expect(txs[0]!.payee).toBe("Opening Balance");
    expect(txs[0]!.amount).toBe(50000);
  });

  it("is a no-op when the migration hash is already recorded", () => {
    const { db, raw } = openRaw();
    initLegacyTables(raw);
    raw.exec(
      `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)`
    );
    raw.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      expectedHash0000(),
      1
    );
    expect(bootstrapMigrationJournal(db)).toBe("noop");
    const rows = raw.prepare("SELECT * FROM __drizzle_migrations").all();
    expect(rows).toHaveLength(1);
  });
});
