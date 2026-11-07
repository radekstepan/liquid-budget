/**
 * import-ynab4-payees.test.ts (G-04)
 *
 * YNAB4 payee fidelity on import:
 *
 *   - `enabled === false` payees import as `payees.archived` (missing
 *     `enabled` defaults to enabled, mirroring YNAB4's `= true`).
 *   - `renameConditions` with operator `Is` become exact `rename_rules`
 *     rows (source = operand, target = payee name). The other three
 *     YNAB4 operators (Contains, StartsWith, EndsWith) have no
 *     equivalent in our full-match `[N]`/`[X]` engine, so those
 *     conditions — plus blank/unparseable ones — land in
 *     `ImportSummary.warnings`, never silently dropped.
 *   - `autoFillMemo`/`autoFillAmount` (no payee-autofill target here)
 *     and `locations`/`payeeLocations` (no maps feature) are dropped
 *     with aggregated warnings.
 *   - `targetAccountId` transfer payees stay skipped by design with one
 *     aggregated notice.
 *   - Export writes the flag back as YNAB4 `enabled`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { exportYnab4 } from "../src/export-ynab4.js";
import { importYnab4 } from "../src/import-ynab4.js";
import { getRenameRules } from "../src/queries/rename-rules.js";
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

const ynabData = {
  accounts: [{ entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true }],
  payees: [
    {
      entityId: "p1",
      name: "Grocery Store",
      enabled: true,
      autoFillCategoryId: null,
      renameConditions: [
        { entityId: "rc1", operator: "Is", operand: "SAFEWAY #123", parentPayeeId: "p1" },
        { entityId: "rc2", operator: "Contains", operand: "SAFEWAY", parentPayeeId: "p1" },
        { entityId: "rc3", operator: "StartsWith", operand: "SAFE", parentPayeeId: "p1" },
        { entityId: "rc4", operator: "EndsWith", operand: "123", parentPayeeId: "p1" },
        { entityId: "rc5", operator: "Bogus", operand: "NOPE", parentPayeeId: "p1" },
        { entityId: "rc6", operator: "Is", operand: "   ", parentPayeeId: "p1" },
        { entityId: "rc7", operator: "Is", operand: "TOMBSTONED", parentPayeeId: "p1", isTombstone: true },
      ],
    },
    {
      entityId: "p2",
      name: "Old Shop",
      enabled: false,
    },
    {
      entityId: "p3",
      name: "Default Enabled Shop",
    },
    {
      entityId: "p4",
      name: "Memo Autofill Cafe",
      autoFillMemo: "Large latte",
      autoFillAmount: -4500,
      locations: [{ latitude: 49.28, longitude: -123.12 }],
    },
    {
      entityId: "pt",
      name: "Transfer : Chequing",
      targetAccountId: "acc1",
    },
  ],
  payeeLocations: [{ latitude: 49.0, longitude: -123.0 }],
  masterCategories: [],
  transactions: [
    {
      entityId: "t1",
      accountId: "acc1",
      date: "2026-06-01",
      amount: -100,
      cleared: "Cleared",
      payeeId: "p2",
      categoryId: null,
    },
    {
      entityId: "t2",
      accountId: "acc1",
      date: "2026-06-02",
      amount: -200,
      cleared: "Cleared",
      payeeId: "p1",
      categoryId: null,
    },
    {
      entityId: "t3",
      accountId: "acc1",
      date: "2026-06-03",
      amount: -300,
      cleared: "Cleared",
      payeeId: "p3",
      categoryId: null,
    },
  ],
  monthlyBudgets: [],
  scheduledTransactions: [],
};

describe("G-04 payee import", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("persists enabled as archived, imports Is conditions, and warns on the rest", async () => {
    const summary = await importYnab4(db, structuredClone(ynabData));

    const payees = db.select().from(schema.payees).all();
    const byName = new Map(payees.map((p) => [p.name, p]));
    expect(byName.get("Grocery Store")?.archived).toBe(false);
    expect(byName.get("Old Shop")?.archived).toBe(true);
    expect(byName.get("Default Enabled Shop")?.archived).toBe(false);
    // Transfer payees are skipped by design (modeled via transferAccountId).
    expect(byName.has("Transfer : Chequing")).toBe(false);

    const rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      sourcePattern: "SAFEWAY #123",
      targetPayee: "Grocery Store",
    });

    const warnings = summary.warnings ?? [];
    // One notice per unmapped condition (Contains/StartsWith/EndsWith/
    // unknown operator/blank operand; tombstoned stays silent).
    expect(warnings.filter((w) => w.includes("rename condition")).length).toBe(5);
    expect(warnings.some((w) => w.includes('"Contains"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"Bogus"'))).toBe(true);
    // Aggregated notices for the deliberate drops.
    expect(warnings.some((w) => w.includes("transfer payee"))).toBe(true);
    expect(warnings.some((w) => w.includes("2 payee location"))).toBe(true);
    expect(warnings.some((w) => w.includes("memo/amount autofill"))).toBe(true);
  });

  it("round-trips the archived flag through export as enabled", async () => {
    await importYnab4(db, structuredClone(ynabData));
    const { ynabData: exported } = await exportYnab4(db);
    const byName = new Map(exported.payees.map((p: any) => [p.name, p]));
    expect(byName.get("Old Shop")?.enabled).toBe(false);
    expect(byName.get("Grocery Store")?.enabled).toBe(true);
    expect(byName.get("Default Enabled Shop")?.enabled).toBe(true);
  });

  it("rejects a transfer-like rename operand instead of learning it", async () => {
    const doc = structuredClone(ynabData);
    const grocery = doc.payees.find((p: any) => p.entityId === "p1")!;
    grocery.renameConditions = [
      { entityId: "rcx", operator: "Is", operand: "Transfer : Savings", parentPayeeId: "p1" },
    ];
    const summary = await importYnab4(db, doc);
    expect(getRenameRules(db)).toHaveLength(0);
    expect((summary.warnings ?? []).some((w) => w.includes("transfer-like"))).toBe(true);
  });
});
