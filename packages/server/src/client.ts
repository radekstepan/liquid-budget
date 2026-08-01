import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { ensureTables } from "./seed.js";
import { fileURLToPath } from "url";
import path from "path";

export type Db = BetterSQLite3Database<typeof schema>;

// Re-export as `Database` for backward compat with existing call sites.
export type { Db as Database };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB_PATH =
  process.env.DATABASE_URL ?? path.resolve(__dirname, "../../..", "budget.db");

const globalForDb = globalThis as typeof globalThis & {
  __ynabDb?: Db;
};

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  // Enable WAL mode and foreign keys for every connection.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function getDefaultDb(): Db {
  if (!globalForDb.__ynabDb) {
    const db = openDb(DEFAULT_DB_PATH);
    // Safety net: create schema on first access. CREATE TABLE IF NOT EXISTS
    // is idempotent, so this is a no-op on a fully-migrated DB and rescues
    // any code path that touches the DB before the seed/reset endpoints run.
    ensureTables(db);
    globalForDb.__ynabDb = db;
  }
  return globalForDb.__ynabDb;
}

// Kept for backward compat with db-reset.ts (was createPool / createDb).
export { openDb as createDb };
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDefaultDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as Function).bind(real) : value;
  },
});
