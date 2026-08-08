/**
 * client.test.ts
 *
 * The DB client helpers were only covered by `typeof` assertions in
 * index.test.ts. These exercise the real behavior: `openDb` sets the
 * required pragmas, `getDefaultDb` is a cached singleton that applies
 * migrations on first open, and the `db` proxy lazily binds to the
 * default connection.
 *
 * `DATABASE_URL` is stubbed to `:memory:` *before* importing the client
 * module (it computes the default path at import time), so the tests
 * never touch the repo's real `budget.db`.
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("client", () => {
  let client: typeof import("../src/client.js");

  beforeAll(async () => {
    client = await import("../src/client.js");
  });

  describe("openDb", () => {
    it("enables foreign keys on the connection", () => {
      const db = client.openDb(":memory:");
      const fk = (db.$client.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]!;
      expect(fk.foreign_keys).toBe(1);
      db.$client.close();
    });

    it("returns a usable drizzle handle", () => {
      const db = client.openDb(":memory:");
      const rows = db.all<{ one: number }>(sql`select 1 as one`);
      expect(rows[0]!.one).toBe(1);
      db.$client.close();
    });
  });

  describe("getDefaultDb", () => {
    it("opens, migrates, and caches the default connection", () => {
      const db1 = client.getDefaultDb();
      const db2 = client.getDefaultDb();
      expect(db1).toBe(db2);
      // Migrations ran on first open — the accounts table exists.
      const tables = db1.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`
      );
      expect(tables).toHaveLength(1);
    });
  });

  describe("db proxy", () => {
    it("lazily binds methods to the default connection", () => {
      const tables = client.db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`
      );
      expect(tables).toHaveLength(1);
    });

    it("exposes createDb as an alias for openDb", () => {
      expect(client.createDb).toBe(client.openDb);
    });
  });
});
