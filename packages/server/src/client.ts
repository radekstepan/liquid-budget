import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as typeof globalThis & {
  __ynabPool?: Pool;
};

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

export function getDefaultPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  if (!globalForDb.__ynabPool) {
    globalForDb.__ynabPool = createPool(url);
  }
  return globalForDb.__ynabPool;
}

export function getDefaultDb(): Database {
  return createDb(getDefaultPool());
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDefaultDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as Function).bind(real) : value;
  },
});
