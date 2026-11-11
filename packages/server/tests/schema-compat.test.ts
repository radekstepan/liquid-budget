/**
 * schema-compat.test.ts (schema-hygiene)
 *
 * Pins the YNAB4 compat convention documented at the top of
 * src/schema.ts: every compat column (nullable round-trip lineage)
 * stays nullable so in-app rows never require YNAB4 lineage, while
 * app-generated identity stays NOT NULL. Adding a compat column means
 * updating the banner in schema.ts AND this registry.
 */
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../src/schema.js";

// Table key -> compat columns living under a `--- YNAB4 compat ---` banner.
const COMPAT: Record<string, string[]> = {
  accounts: ["entityId", "accountTypeRaw"],
  categoryGroups: ["entityId"],
  categories: ["entityId", "oldMasterName", "oldMasterEntityId"],
  payees: ["entityId", "autoMemo", "autoAmount"],
  transactions: [
    "entityId",
    "transferEntityId",
    "checkNumber",
    "fitid",
    "ynabId",
    "importedPayee",
    "source",
    "incomeCategoryRaw",
    "transferMemo",
    "transferCheckNumber",
    "transferFitid",
    "transferYnabId",
    "transferImportedPayee",
    "transferSource",
  ],
  reconciliations: ["entityId"],
  recurring: ["entityId"],
  recurringSubTransactions: ["entityId"],
};

describe("YNAB4 compat columns stay nullable", () => {
  for (const [tableKey, columns] of Object.entries(COMPAT)) {
    it(`${tableKey}: ${columns.join(", ")} accept NULL`, () => {
      const table = (schema as Record<string, unknown>)[tableKey];
      expect(table, `missing table export ${tableKey}`).toBeDefined();
      const cols = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
      for (const name of columns) {
        expect(cols, `missing column map for ${tableKey}`).toHaveProperty(name);
        expect(cols[name]!.notNull, `${tableKey}.${name} must stay nullable`).toBe(false);
      }
    });
  }

  it("app-generated identity stays NOT NULL (scheduledPostings.entityId)", () => {
    const cols = getTableColumns(schema.scheduledPostings);
    expect(cols["entityId"]!.notNull).toBe(true);
  });
});
