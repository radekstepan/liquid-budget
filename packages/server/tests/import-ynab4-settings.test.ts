/**
 * import-ynab4-settings.test.ts (G-02)
 *
 * Budget settings persistence: a non-US locale (cs_CZ, comma decimal,
 * koruna) imported from `.ybsettings` + `.ynab4` budgetMetaData must
 * land in the `settings` table, and the exporter must write the stored
 * values back instead of hardcoded en_US/Personal/TRUE.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import AdmZip from "adm-zip";
import path from "path";
import { fileURLToPath } from "url";
import {
  extractYnab4DataFromZip,
  importYnab4,
  parseYnab4BudgetMetaData,
} from "../src/import-ynab4.js";
import { exportYnab4, exportYnab4Zip } from "../src/export-ynab4.js";
import { getAllSettings } from "../src/settings.js";
import { seedDatabase } from "../src/seed.js";
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

const CS_SETTINGS_XML = `<?xml version="1.0" encoding="utf-8"?>
<budgetSettings>
  <currencySymbol>Kč</currencySymbol>
  <currencyISOSymbol>CZK</currencyISOSymbol>
  <decimalSeparator>,</decimalSeparator>
  <groupSeparator> </groupSeparator>
  <dateFormat>DD.MM.YYYY</dateFormat>
  <budgetName>Můj rozpočet</budgetName>
</budgetSettings>
`;

function csYnabData() {
  return {
    fileMetaData: { budgetDataVersion: "4.2.0" },
    budgetMetaData: {
      budgetType: "Personal",
      currencyISOSymbol: "CZK",
      currencyLocale: "cs_CZ",
      dateLocale: "cs_CZ",
      strictBudget: "TRUE",
      entityId: "budget-metadata",
      entityType: "budgetMetaData",
    },
    accounts: [
      {
        entityId: "acc1",
        accountName: "Běžný účet",
        accountType: "Checking",
        onBudget: true,
        sortableIndex: 1000,
        isTombstone: false,
        entityType: "account",
      },
    ],
    payees: [],
    masterCategories: [],
    monthlyBudgets: [],
    scheduledTransactions: [],
    transactions: [],
  };
}

describe("G-02 budget settings persistence", () => {
  it("persists .ybsettings + budgetMetaData into the settings table on import", async () => {
    const db = openMigratedDb();
    const summary = await importYnab4(db, csYnabData(), CS_SETTINGS_XML);

    const stored = await getAllSettings(db);
    expect(stored.currencySymbol).toBe("Kč");
    expect(stored.currencyISOSymbol).toBe("CZK");
    expect(stored.decimalSeparator).toBe(",");
    expect(stored.groupSeparator).toBe(" ");
    expect(stored.dateFormat).toBe("DD.MM.YYYY");
    expect(stored.budgetName).toBe("Můj rozpočet");
    expect(stored.budgetType).toBe("Personal");
    expect(stored.currencyLocale).toBe("cs_CZ");
    expect(stored.dateLocale).toBe("cs_CZ");
    expect(stored.strictBudget).toBe("TRUE");

    // The summary echoes the merged settings back to the caller.
    expect(summary.settings).toMatchObject({
      currencySymbol: "Kč",
      decimalSeparator: ",",
      budgetName: "Můj rozpočet",
      currencyLocale: "cs_CZ",
      dateLocale: "cs_CZ",
    });
  });

  it("exports stored settings instead of hardcoded en_US/Personal/TRUE", async () => {
    const db = openMigratedDb();
    await importYnab4(db, csYnabData(), CS_SETTINGS_XML);

    const { ynabData, settingsXml } = await exportYnab4(db);
    expect(ynabData.budgetMetaData.currencyLocale).toBe("cs_CZ");
    expect(ynabData.budgetMetaData.dateLocale).toBe("cs_CZ");
    expect(ynabData.budgetMetaData.strictBudget).toBe("TRUE");
    expect(ynabData.budgetMetaData.budgetType).toBe("Personal");
    expect(ynabData.budgetMetaData.currencyISOSymbol).toBe("CZK");
    expect(settingsXml).toContain("<currencySymbol>Kč</currencySymbol>");
    expect(settingsXml).toContain("<decimalSeparator>,</decimalSeparator>");
    expect(settingsXml).toContain("<dateFormat>DD.MM.YYYY</dateFormat>");
    expect(settingsXml).toContain("<budgetName>Můj rozpočet</budgetName>");
  });

  it("falls back to en_US/Personal/TRUE/USD only when nothing was stored", async () => {
    const db = openMigratedDb();
    await seedDatabase(db);

    const { ynabData, settingsXml } = await exportYnab4(db);
    expect(ynabData.budgetMetaData.currencyLocale).toBe("en_US");
    expect(ynabData.budgetMetaData.dateLocale).toBe("en_US");
    expect(ynabData.budgetMetaData.strictBudget).toBe("TRUE");
    expect(ynabData.budgetMetaData.budgetType).toBe("Personal");
    expect(ynabData.budgetMetaData.currencyISOSymbol).toBe("USD");
    expect(settingsXml).toContain("<currencySymbol>$</currencySymbol>");
  });

  it("explicit export options override stored settings", async () => {
    const db = openMigratedDb();
    await importYnab4(db, csYnabData(), CS_SETTINGS_XML);

    const { ynabData, settingsXml } = await exportYnab4(db, {
      budgetName: "Override",
      currencyLocale: "de_DE",
    });
    expect(ynabData.budgetMetaData.currencyLocale).toBe("de_DE");
    expect(ynabData.budgetMetaData.dateLocale).toBe("cs_CZ");
    expect(settingsXml).toContain("<budgetName>Override</budgetName>");
    expect(settingsXml).toContain("<currencySymbol>Kč</currencySymbol>");
  });

  it("round-trips settings through export zip -> extract -> import", async () => {
    const db1 = openMigratedDb();
    await importYnab4(db1, csYnabData(), CS_SETTINGS_XML);
    const zipBuffer = await exportYnab4Zip(db1);

    // Same path the /api/import route takes: extract, then forward
    // warnings + budgetMetaData explicitly.
    const extracted = extractYnab4DataFromZip(zipBuffer);
    expect(extracted.budgetMetaData).toMatchObject({ currencyLocale: "cs_CZ" });
    expect(extracted.settings?.currencySymbol).toBe("Kč");

    const db2 = openMigratedDb();
    await importYnab4(db2, extracted.ynabData, extracted.settingsXml, {
      warnings: extracted.warnings,
      budgetMetaData: extracted.budgetMetaData,
    });

    const stored = await getAllSettings(db2);
    expect(stored.currencyLocale).toBe("cs_CZ");
    expect(stored.currencySymbol).toBe("Kč");
    expect(stored.decimalSeparator).toBe(",");
    expect(stored.budgetName).toBe("Můj rozpočet");

    const reExported = await exportYnab4(db2);
    expect(reExported.ynabData.budgetMetaData.currencyLocale).toBe("cs_CZ");
    expect(reExported.settingsXml).toContain("<budgetName>Můj rozpočet</budgetName>");
  });

  it("re-import replaces previously stored settings (no stale keys)", async () => {
    const db = openMigratedDb();
    await importYnab4(db, csYnabData(), CS_SETTINGS_XML);

    const usData = {
      ...csYnabData(),
      budgetMetaData: {
        budgetType: "Business",
        currencyISOSymbol: "USD",
        currencyLocale: "en_US",
        dateLocale: "en_US",
        strictBudget: "FALSE",
      },
    };
    await importYnab4(db, usData);

    const stored = await getAllSettings(db);
    expect(stored.currencyLocale).toBe("en_US");
    expect(stored.budgetType).toBe("Business");
    expect(stored.strictBudget).toBe("FALSE");
    // No .ybsettings passed this time: xml-only keys are gone, not stale.
    expect(stored.budgetName).toBeUndefined();
    expect(stored.currencySymbol).toBeUndefined();
  });

  it("parseYnab4BudgetMetaData whitelists known string fields", () => {
    expect(parseYnab4BudgetMetaData(undefined)).toEqual({});
    expect(parseYnab4BudgetMetaData(null)).toEqual({});
    expect(
      parseYnab4BudgetMetaData({
        budgetType: "Personal",
        currencyLocale: "cs_CZ",
        injected: "DROP TABLE settings",
        nested: { evil: true },
        count: 42,
      })
    ).toEqual({ budgetType: "Personal", currencyLocale: "cs_CZ" });
  });
});
