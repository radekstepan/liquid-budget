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
  console.log("⟳  Opening database…");
  const db = openDb(DB_PATH);
  console.log(`✓  Opened ${DB_PATH}`);

  console.log("⟳  Bootstrapping migration journal (if needed)…");
  const result = bootstrapMigrationJournal(db);
  if (result === "bootstrapped") {
    console.log("✓  Existing schema marked as migration 0000.");
  } else {
    console.log("✓  No bootstrap needed.");
  }

  console.log("⟳  Applying migrations from " + MIGRATIONS_FOLDER + " …");
  db.$client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    db.$client.pragma("foreign_keys = ON");
  }
  console.log("✓  Migrations complete.");
} catch (err) {
  console.error("✗  Migration failed:", err);
  process.exit(1);
}
