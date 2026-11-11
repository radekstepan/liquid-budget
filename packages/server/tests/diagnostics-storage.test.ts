import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import { checkStorageIntegrity, parseIntegrityCheckRows } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe("checkStorageIntegrity (P2 operational)", () => {
  let db: Db;

  beforeEach(() => {
    db = openMigratedDb();
  });

  it("reports ok with no errors on a healthy migrated database", async () => {
    await expect(checkStorageIntegrity(db)).resolves.toEqual({ ok: true, errors: [] });
  });

  it("parses the object row shape better-sqlite3 returns", () => {
    expect(parseIntegrityCheckRows([{ integrity_check: "ok" }])).toEqual({
      ok: true,
      errors: [],
    });
    expect(parseIntegrityCheckRows([{ integrity_check: "OK" }])).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("parses string rows and flags corruption", () => {
    expect(parseIntegrityCheckRows(["ok"])).toEqual({ ok: true, errors: [] });
    expect(parseIntegrityCheckRows(["*** in database main ***", "Page 3 is never used"])).toEqual({
      ok: false,
      errors: ["*** in database main ***", "Page 3 is never used"],
    });
  });

  it("treats empty or non-array output as a failed check", () => {
    expect(parseIntegrityCheckRows([])).toEqual({ ok: false, errors: [] });
    expect(parseIntegrityCheckRows(undefined)).toEqual({ ok: false, errors: [] });
    expect(parseIntegrityCheckRows(null)).toEqual({ ok: false, errors: [] });
  });

  it("caps error lines and truncates long lines", () => {
    const rows = Array.from({ length: 8 }, (_, i) => `error line ${i}: ${"x".repeat(500)}`);
    const report = parseIntegrityCheckRows(rows);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(5);
    for (const line of report.errors) {
      expect(line.length).toBeLessThanOrEqual(300);
    }
    expect(report.errors[0]).toContain("error line 0");
  });
});
