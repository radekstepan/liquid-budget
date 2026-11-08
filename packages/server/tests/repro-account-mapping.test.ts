/**
 * REPRO ONLY — G-10: `ynabData.accountMappings` (OFX import config) never read.
 *
 * What diverges/is lost: YNAB4 persists per-account OFX import config —
 * `fid, shortenedAccountId, hash, salt, targetYNABAccountId, dateSequence,
 * shouldFlipPayeesMemos, shouldImportMemos (=true), skipImport` — and honors
 * it on OFX/QIF/CSV import (flip payee<->memo, drop memos, skip the account).
 * Our importer counts the array and emits one aggregate warning, but no
 * preference is honored or stored, so a round-trip silently loses user
 * config and a future OFX import could not respect it.
 *
 * YNAB4 refs (read-only):
 * - vo/AccountMappingVO.as:10-26 — persisted fields incl. the three booleans
 * - src/scripts/data/AccountMapping.as, data/AccountMappingManager.as
 * - src/scripts/dataAccess/importing/ (ImportData, ImportUtilities, OFX/QIF readers)
 *
 * Our side: packages/server/src/import-ynab4.ts:2001-2021 (aggregate drop
 * warning; nothing persisted, no OFX path consults it).
 */
import { describe, expect, it, beforeEach } from "vitest";
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

/** Stock-shaped backup carrying OFX import config for one account. */
function backupWithAccountMappings() {
  return {
    fileMetaData: { budgetDataVersion: "4.2.0" },
    accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
    payees: [],
    masterCategories: [],
    transactions: [],
    scheduledTransactions: [],
    monthlyBudgets: [],
    accountMappings: [
      {
        entityId: "map1",
        fid: "12345",
        shortenedAccountId: "XXXX1234",
        hash: "abc",
        salt: "salt",
        targetYNABAccountId: "acc1",
        dateSequence: "2026-01-01",
        shouldFlipPayeesMemos: true,
        shouldImportMemos: false,
        skipImport: true,
      },
    ],
  };
}

describe("G-10 repro: accountMappings (OFX import config) dropped", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("surfaces WHICH import preferences were dropped, not just a count", async () => {
    const summary = await importYnab4(db, backupWithAccountMappings());
    const text = (summary.warnings ?? []).join("\n");
    // FAILS today: the aggregate warning names no flag, so a user cannot
    // tell that skipImport / shouldFlipPayeesMemos / shouldImportMemos
    // config was lost.
    expect(text).toMatch(/skipImport/);
    expect(text).toMatch(/shouldFlipPayeesMemos/);
    expect(text).toMatch(/shouldImportMemos/);
  });

  it("honors skipImport for the mapped account", async () => {
    const summary = await importYnab4(db, backupWithAccountMappings());
    const text = (summary.warnings ?? []).join("\n");
    // FAILS today: nothing records that "Checking" (targetYNABAccountId
    // acc1) was marked skipImport — the config is silently dropped.
    expect(text).toMatch(/acc1|Checking/);
  });
});
