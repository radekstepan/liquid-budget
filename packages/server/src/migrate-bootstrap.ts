/**
 * migrate-bootstrap.ts
 *
 * One-time upgrade helper. Existing databases created by the legacy
 * hand-rolled schema code in `seed.ts` have the same schema as
 * migration 0000 but no `__drizzle_migrations` row. When drizzle's
 * `migrate()` runs against such a DB, it tries to re-apply 0000 and
 * fails with "table already exists".
 *
 * `bootstrapMigrationJournal` detects that case — the `accounts`
 * table exists but `__drizzle_migrations` has no row whose hash
 * matches migration 0000 — and inserts the missing row so drizzle's
 * migration loop becomes a no-op.
 *
 * The hash is computed the same way drizzle-kit does it
 * (sha256 of the raw .sql file content) so it stays in sync with
 * the migration's own hash.
 *
 * Safe to call on every server boot: no-op for new installs and
 * for already-migrated DBs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

const MIGRATIONS_FOLDER = join(__dirname, "migrations");
const MIGRATIONS_TABLE = "__drizzle_migrations";

export type BootstrapResult = "bootstrapped" | "noop";

/**
 * If the app tables exist but `__drizzle_migrations` is missing the
 * row for migration 0000, insert it. Returns `"bootstrapped"` if a
 * row was added, `"noop"` otherwise.
 */
export function bootstrapMigrationJournal(db: Db): BootstrapResult {
  // 1. Does the `accounts` table exist? (Indicator of an existing
  //    pre-migration-schema DB. Fresh installs don't have it.)
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`
  );
  if (tables.length === 0) {
    // Fresh install — let `migrate()` create everything from scratch.
    return "noop";
  }

  // 2. Ensure the `__drizzle_migrations` table exists so we can inspect
  //    and populate it if necessary.
  db.run(
    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(
      MIGRATIONS_TABLE
    )} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
  );

  // 3. Read every migration's hash from the journal. If any hash
  //    is already recorded, the DB has been migrated. Otherwise
  //    we're in the upgrade-from-legacy-schema case.
  const migrations = readMigrationsWithHashes();
  const recordedHashes = new Set(
    db.all<{ hash: string }>(
      sql`SELECT hash FROM ${sql.raw(MIGRATIONS_TABLE)}`
    ).map((r) => r.hash)
  );
  if (recordedHashes.size > 0) {
    return "noop";
  }

  const m0 = migrations[0];
  if (m0) {
    db.run(
      sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE)} (hash, created_at) VALUES (${
        m0.hash
      }, ${m0.folderMillis})`
    );
    return "bootstrapped";
  }
  return "noop";
}

/** Mirror of drizzle's internal `readMigrationFiles`. */
function readMigrationsWithHashes(): Array<{ hash: string; folderMillis: number }> {
  const journalPath = join(MIGRATIONS_FOLDER, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries.map((entry) => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf-8");
    return {
      hash: createHash("sha256").update(sql).digest("hex"),
      folderMillis: entry.when,
    };
  });
}
