#!/usr/bin/env node
/**
 * db-reset.ts
 *
 * CLI script: wipe all budget data and re-seed with demo data.
 * Run via:  yarn workspace @ynab/server db:reset
 *           yarn db:reset
 *
 * Reads DATABASE_URL from the environment (defaults to ./budget.db).
 */
import { openDb, resetAndSeedDatabase } from "./index.js";

const DB_PATH = process.env.DATABASE_URL ?? "../../budget.db";
const db = openDb(DB_PATH);

try {
  // Note: CLI entry point — output goes through process.stdout/stderr
  // directly. `console.*` is banned in code under test (every Vitest config
  // throws on it via onConsoleLog), so these scripts never use it.
  process.stdout.write("⟳  Resetting and re-seeding database…\n");
  await resetAndSeedDatabase(db);
  process.stdout.write("✓  Seed complete. Ready to go.\n");
} catch (err) {
  process.stderr.write(`✗  Reset failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
