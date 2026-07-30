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
import { openDb, resetDatabase, seedDatabase } from "./index.js";

const DB_PATH = process.env.DATABASE_URL ?? "./budget.db";
const db = openDb(DB_PATH);

try {
  console.log("⟳  Resetting database…");
  await resetDatabase(db);
  console.log("✓  All tables cleared.");

  console.log("⟳  Re-seeding with demo data…");
  await seedDatabase(db);
  console.log("✓  Seed complete. Ready to go.");
} catch (err) {
  console.error("✗  Reset failed:", err);
  process.exit(1);
}
