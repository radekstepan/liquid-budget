#!/usr/bin/env node
/**
 * migrate.ts
 *
 * CLI: apply any pending Drizzle migrations to the SQLite database.
 * Run via:  yarn workspace @ynab/server db:migrate
 *
 * Idempotent — drizzle tracks which migrations have been applied in
 * `__drizzle_migrations`, so re-running on an already-migrated DB is
 * a no-op.
 *
 * One-time bootstrap for upgrades: a DB created by the legacy
 * hand-rolled `ensureTables` + ALTER-block code path has the same
 * schema as migration 0000 but no `__drizzle_migrations` row, so
 * drizzle would try to re-apply 0000 and fail with "table already
 * exists". `bootstrapMigrationJournal` detects this and inserts the
 * missing row.
 */
import path from "path";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "./index.js";
import { bootstrapMigrationJournal } from "./migrate-bootstrap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATABASE_URL ?? path.resolve(__dirname, "../../..", "budget.db");
const MIGRATIONS_FOLDER = path.resolve(__dirname, "migrations");

try {
  // Note: CLI entry point — output goes through process.stdout/stderr
  // directly. `console.*` is banned in code under test (every Vitest config
  // throws on it via onConsoleLog), so these scripts never use it.
  process.stdout.write("⟳  Opening database…\n");
  const db = openDb(DB_PATH);
  process.stdout.write(`✓  Opened ${DB_PATH}\n`);

  process.stdout.write("⟳  Bootstrapping migration journal (if needed)…\n");
  const result = bootstrapMigrationJournal(db);
  if (result === "bootstrapped") {
    process.stdout.write("✓  Existing schema marked as migration 0000.\n");
  } else {
    process.stdout.write("✓  No bootstrap needed.\n");
  }

  process.stdout.write("⟳  Applying migrations from " + MIGRATIONS_FOLDER + " …\n");
  db.$client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    db.$client.pragma("foreign_keys = ON");
  }
  process.stdout.write("✓  Migrations complete.\n");
} catch (err) {
  process.stderr.write(`✗  Migration failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
