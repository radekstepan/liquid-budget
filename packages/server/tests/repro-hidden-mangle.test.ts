/**
 * Regression: hidden mangled-name linkage survives YNAB4 import.
 *
 * Pins YNAB4 (MangledHiddenNameComponents.as:21-35,
 * MasterCategoryList.as:449-495): a hidden sub-category stores its original
 * home as a mangled name "OldMaster ` Sub ` MasterCategory/<oldMasterEntityId>"
 * plus the sub's own entityId. Unhide parses oldMaster/sub/entityId
 * components and restores the category to its original master. The importer
 * parses the components (import-ynab4.ts), stores oldMasterEntityId
 * (schema.ts), and demangles the display name.
 *
 * Fix commit: b4edec5 (g-hidden-mangle).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

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

const MANGLED = "OldMaster ` Sub ` MasterCategory/abc123";

function hiddenFixture() {
  return {
    accounts: [],
    payees: [],
    masterCategories: [
      {
        entityId: "MasterCategory/__Hidden__",
        name: "Hidden Categories",
        type: "OUTFLOW",
        subCategories: [{ entityId: "Category/abc123", name: MANGLED }],
      },
    ],
    transactions: [],
    monthlyBudgets: [],
    scheduledTransactions: [],
  };
}

describe("ynab4 parity: hidden mangle linkage survives import", () => {
  it("preserves parsed oldMasterEntityId so unhide can restore the master", async () => {
    const db = openMigratedDb();
    await importYnab4(db, hiddenFixture());
    const cats = await db.select().from(schema.categories);
    expect(cats).toHaveLength(1);
    const row = cats[0]! as Record<string, unknown>;
    // Linkage must survive the import: original master entity id parsed
    // from the mangled name, not just the verbatim display string.
    expect(row).toHaveProperty("oldMasterEntityId", "MasterCategory/abc123");
    // And the display name must be demangled (unhide restores "Sub"
    // under "OldMaster"), not the verbatim mangled string.
    expect(row["name"]).toBe("Sub");
  });
});
