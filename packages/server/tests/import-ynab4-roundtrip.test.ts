/**
 * import-ynab4-roundtrip.test.ts (G-11)
 *
 * Full fidelity loop: import a stock-shaped backup (db1) → export a
 * zip → import into a fresh ledger (db2) → diff summaries and state.
 *
 * Locked in both directions:
 * - G-01: the export stamps `fileMetaData.budgetDataVersion`, so its
 *   own zip passes the import version gate.
 * - G-02: non-US settings (both `.ybsettings` halves) persist and
 *   re-export verbatim.
 * - G-03: verbatim account types + notes round-trip; the
 *   `lastEnteredCheckNumber` drop warns once (stock only — exports
 *   write the -1 default).
 * - G-04: disabled payees (`enabled`), `autoFillCategoryId` defaults,
 *   `autoFillMemo`/`autoFillAmount` defaults, and rename conditions
 *   (`Is` exact + `Contains`/`StartsWith`/`EndsWith` substring flavours)
 *   round-trip; location/transfer-payee drops warn on the stock import
 *   only.
 * - G-05: `checkNumber` + OFX lineage round-trip; `accepted: false`
 *   / match-link / schedule-link drops warn once (exports hardcode
 *   `accepted: true` — intentional, see below).
 * - G-06: zero-amount split legs round-trip.
 * - G-07: explicit-zero budgets + per-category notes round-trip;
 *   month-level notes warn once (no home on export).
 * - G-08: `twiceAMonthStartDay` round-trips via `second_anchor_day`;
 *   unknown frequencies warn once (exports write them normalized).
 * - G-09: a stock-shaped file (no `reconciliations[]`) creates no
 *   reconciliation rows in either ledger.
 * - G-10: `accountMappings` warn (aggregate + per-account detail;
 *   exports omit them by design).
 * - G-11: in-app `[N]`-style rename rules ride as `Is` operands and
 *   restore verbatim; `accepted: true` / `isTombstone: false` /
 *   `entityVersion` stubs are asserted as intentionally emitted.
 *
 * Declared out of scope (asserted as absent after the loop, with
 * reasons in the exporter + changeset): `categories.goal_target`
 * (no YNAB4 counterpart), `transactions.needs_review` and
 * `duplicate_ignores` (local review state), `accounts.groupLabel`
 * (recomputed from kind/onBudget).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { exportYnab4Zip } from "../src/export-ynab4.js";
import { extractYnab4DataFromZip, importYnab4 } from "../src/import-ynab4.js";
import { getAllSettings } from "../src/settings.js";
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

const settingsXml = `<?xml version="1.0" encoding="utf-8"?>
<com.ynab.dataAccess.settings.MachineBudgetSettingsVO>
  <currencySymbol>Kč</currencySymbol>
  <currencyISOSymbol>CZK</currencyISOSymbol>
  <decimalSeparator>,</decimalSeparator>
  <groupSeparator> </groupSeparator>
  <dateFormat>DD.MM.YYYY</dateFormat>
  <budgetName>Round Trip Rozpočet</budgetName>
</com.ynab.dataAccess.settings.MachineBudgetSettingsVO>
`;

function stockFixture() {
  return {
    fileMetaData: { budgetDataVersion: "4.2.0" },
    budgetMetaData: {
      budgetType: "Business",
      currencyISOSymbol: "CZK",
      currencyLocale: "cs_CZ",
      dateLocale: "cs_CZ",
      strictBudget: "FALSE",
    },
    accounts: [
      {
        entityId: "acc_chk",
        accountName: "Checking",
        accountType: "Checking",
        onBudget: true,
        note: "Everyday account",
        lastEnteredCheckNumber: 7,
      },
      {
        entityId: "acc_broker",
        accountName: "Brokerage",
        accountType: "InvestmentAccount",
        onBudget: false,
        note: "Retirement stash",
      },
    ],
    // G-10: OFX import config — intentionally dropped with a warning.
    accountMappings: [
      {
        entityId: "map1",
        fid: "12345",
        shortenedAccountId: "...1234",
        hash: "hash",
        salt: "salt",
        targetYNABAccountId: "acc_chk",
        dateSequence: 3,
        shouldFlipPayeesMemos: false,
        shouldImportMemos: true,
        skipImport: false,
      },
    ],
    payees: [
      {
        entityId: "p_grocery",
        name: "Grocery Store",
        autoFillCategoryId: "sc_groc",
        renameConditions: [
          { entityId: "rc1", operator: "Is", operand: "SAFEWAY #123", parentPayeeId: "p_grocery" },
          { entityId: "rc2", operator: "Contains", operand: "SAFEWAY", parentPayeeId: "p_grocery" },
        ],
      },
      { entityId: "p_old", name: "Old Shop", enabled: false },
      {
        entityId: "p_cafe",
        name: "Memo Cafe",
        autoFillMemo: "Large latte",
        autoFillAmount: -4500,
        locations: [{ latitude: 49.28, longitude: -123.12 }],
      },
      { entityId: "pt", name: "Transfer : Checking", targetAccountId: "acc_chk" },
    ],
    payeeLocations: [{ latitude: 49.0, longitude: -123.0 }],
    masterCategories: [
      {
        entityId: "mc_everyday",
        name: "Everyday",
        type: "OUTFLOW",
        subCategories: [
          { entityId: "sc_groc", name: "Groceries" },
          { entityId: "sc_home", name: "Household" },
        ],
      },
    ],
    monthlyBudgets: [
      {
        entityId: "MB/2026-08",
        month: "2026-08-01",
        note: "Vacation month",
        entityType: "monthlyBudget",
        monthlySubCategoryBudgets: [
          { entityId: "MCB/2026-08/sc_groc", categoryId: "sc_groc", budgeted: 200000, note: "Groceries bump" },
          { entityId: "MCB/2026-08/sc_home", categoryId: "sc_home", budgeted: 0, note: "Paused" },
        ],
      },
    ],
    transactions: [
      {
        entityId: "t_line",
        accountId: "acc_chk",
        date: "2026-08-10",
        amount: -45000,
        cleared: "Cleared",
        memo: "Lineage holder",
        checkNumber: "101",
        FITID: "FIT-1",
        YNABID: "YNAB-1",
        importedPayee: "SAFEWAY #123",
        source: "OFX",
        payeeId: "p_grocery",
        categoryId: "sc_groc",
      },
      {
        entityId: "t_old",
        accountId: "acc_chk",
        date: "2026-08-11",
        amount: -12000,
        cleared: "Cleared",
        accepted: false,
        payeeId: "p_old",
        categoryId: "sc_home",
      },
      {
        entityId: "t_match",
        accountId: "acc_chk",
        date: "2026-08-12",
        amount: -8000,
        cleared: "Cleared",
        dateEnteredFromSchedule: "2026-08-02T00:00:00",
        matchedTransactions: [{ entityId: "m1" }],
        payeeId: "p_grocery",
        categoryId: "sc_groc",
      },
      {
        entityId: "t_split",
        accountId: "acc_chk",
        date: "2026-08-13",
        amount: -50000,
        cleared: "Cleared",
        payeeId: "p_grocery",
        categoryId: "Category/__Split__",
        subTransactions: [
          { entityId: "st1", categoryId: "sc_groc", amount: -50000, memo: "Food" },
          { entityId: "st2", categoryId: "sc_home", amount: 0, memo: "Free coupon" },
        ],
      },
    ],
    scheduledTransactions: [
      {
        entityId: "sched_twice",
        accountId: "acc_chk",
        date: "2026-09-05",
        amount: -30000,
        frequency: "TwiceAMonth",
        twiceAMonthStartDay: 20,
        anchorDay: 5,
        memo: "Mid-month",
        active: true,
        payeeId: "p_grocery",
        categoryId: "sc_groc",
      },
      {
        entityId: "sched_odd",
        accountId: "acc_chk",
        date: "2026-09-06",
        amount: -10000,
        frequency: "Fortnightly",
        memo: "Odd cadence",
        active: true,
        payeeId: "p_cafe",
        categoryId: "sc_home",
      },
    ],
  };
}

describe("G-11 import → export → import round-trip", () => {
  it("preserves every G-01..G-09 fix and documents the out-of-scope losses", async () => {
    const db1 = openMigratedDb();
    const summary1 = await importYnab4(db1, stockFixture(), settingsXml);

    // Stock-only constructs warn on the first import …
    for (const pattern of [
      /lastEnteredCheckNumber/,
      /account mapping/,
      /month-level budget notes/,
      /payee location/,
      /transfer payee/,
      /accepted === false/,
      /import-match links/,
      /schedule-entry links/,
      /Unknown scheduled frequency/,
    ]) {
      expect(summary1.warnings.some((w) => pattern.test(w)), `missing warning ${pattern}`).toBe(true);
    }

    // … then plant local-only state with no YNAB4 counterpart …
    const [groceries1] = await db1
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Groceries"));
    await db1.update(schema.categories).set({ goalTarget: 50000 }).where(eq(schema.categories.id, groceries1!.id));
    await db1
      .update(schema.transactions)
      .set({ needsReview: true })
      .where(eq(schema.transactions.entityId, "t_line"));
    await db1.insert(schema.duplicateIgnores).values({ fingerprint: "local-fp", createdAt: "2026-08-01" });
    await db1.insert(schema.renameRules).values({
      sourcePattern: "AMZN [N]",
      targetPayee: "Grocery Store",
      createdAt: new Date().toISOString(),
    });

    // … export through the real zip path (gate must accept our stamp) …
    const zip = await exportYnab4Zip(db1);
    const extracted = extractYnab4DataFromZip(zip);
    expect(extracted.ynabData.fileMetaData.budgetDataVersion).toBe("4.2.0");
    expect(extracted.budgetMetaData).toMatchObject({
      budgetType: "Business",
      currencyLocale: "cs_CZ",
      dateLocale: "cs_CZ",
      strictBudget: "FALSE",
    });

    // Intentional stubs: every emitted row is accepted, tombstones are
    // all false, entity versions are synthetic sync vectors.
    for (const t of extracted.ynabData.transactions) {
      expect(t.accepted).toBe(true);
    }
    for (const a of extracted.ynabData.accounts) {
      expect(a.isTombstone).toBe(false);
      expect(typeof a.entityVersion).toBe("string");
    }

    // … and import into a fresh ledger exactly like the API route does.
    const db2 = openMigratedDb();
    const summary2 = await importYnab4(db2, extracted.ynabData, extracted.settingsXml, {
      warnings: extracted.warnings,
      budgetMetaData: extracted.budgetMetaData,
    });

    // Summaries: same shape and counts …
    expect(summary2.accounts).toBe(summary1.accounts);
    expect(summary2.categoryGroups).toBe(summary1.categoryGroups);
    expect(summary2.categories).toBe(summary1.categories);
    expect(summary2.transactions).toBe(summary1.transactions);
    expect(summary2.settings).toEqual(summary1.settings);
    expect(summary2.duplicatesSkipped).toEqual([]);

    // … and the stock-only warnings are gone — everything left warned
    // about was normalized by the export. The transfer-payee notice
    // persists because the exporter re-emits transfer payees.
    expect(summary2.warnings).toHaveLength(1);
    expect(summary2.warnings[0]).toMatch(/transfer payee/);

    // Settings table round-trips verbatim (G-02).
    expect(await getAllSettings(db2)).toEqual(await getAllSettings(db1));

    // Accounts: kind/onBudget/notes/raw type/archived (G-03).
    const accs1 = await db1.select().from(schema.accounts);
    const accs2 = await db2.select().from(schema.accounts);
    expect(accs2).toHaveLength(accs1.length);
    for (const a1 of accs1) {
      const a2 = accs2.find((a) => a.name === a1.name)!;
      expect(a2).toBeDefined();
      expect(a2).toMatchObject({
        kind: a1.kind,
        onBudget: a1.onBudget,
        notes: a1.notes,
        accountTypeRaw: a1.accountTypeRaw,
        archived: a1.archived,
        groupLabel: a1.groupLabel,
        lastReconciledAt: a1.lastReconciledAt,
      });
    }

    // Payees: disabled flag + defaults (G-04).
    const payees1 = await db1.select().from(schema.payees);
    const payees2 = await db2.select().from(schema.payees);
    for (const p1 of payees1) {
      const p2 = payees2.find((p) => p.name === p1.name)!;
      expect(p2, `payee ${p1.name}`).toBeDefined();
      expect(p2.archived).toBe(p1.archived);
      const catName = async (db: Db, id: number | null) =>
        id == null ? null : (await db.select().from(schema.categories).where(eq(schema.categories.id, id)))[0]?.name ?? null;
      expect(await catName(db2, p2.autoCategoryId)).toBe(await catName(db1, p1.autoCategoryId));
      // G-04: the memo/amount autofill defaults survive the round-trip.
      expect(p2.autoMemo).toBe(p1.autoMemo);
      expect(p2.autoAmount).toBe(p1.autoAmount);
    }
    expect(payees2.find((p) => p.name === "Old Shop")?.archived).toBe(true);
    expect(payees2.find((p) => p.name === "Memo Cafe")?.autoMemo).toBe("Large latte");
    expect(payees2.find((p) => p.name === "Memo Cafe")?.autoAmount).not.toBeNull();

    // Rename rules: the YNAB4 `Is` condition, the `Contains`
    // condition, and the in-app `[N]` pattern all restore verbatim
    // (G-04/G-11) — substring rules re-export under their own
    // operator, patterns ride as literal `Is` operands.
    const rules2 = await db2.select().from(schema.renameRules);
    const pairs2 = rules2.map((r) => `${r.sourcePattern} -> ${r.targetPayee}`).sort();
    expect(pairs2).toEqual(
      ["AMZN [N] -> Grocery Store", "SAFEWAY -> Grocery Store", "SAFEWAY #123 -> Grocery Store"].sort()
    );
    expect(
      rules2.find((r) => r.sourcePattern === "SAFEWAY" && r.targetPayee === "Grocery Store")?.operator
    ).toBe("contains");

    // Assignments: explicit zeros + per-category notes (G-07).
    const assigns = async (db: Db) => {
      const rows = await db.select().from(schema.assignments);
      const cats = await db.select().from(schema.categories);
      const nameById = new Map(cats.map((c) => [c.id, c.name]));
      return rows.map((r) => `${r.month}/${nameById.get(r.categoryId)}/${Number(r.amount)}/${r.note}`).sort();
    };
    expect(await assigns(db2)).toEqual(await assigns(db1));
    expect(await assigns(db2)).toContain("2026-08/Household/0/Paused");

    // Transactions: checkNumber + OFX lineage + zero legs (G-05/G-06).
    const txs2 = await db2.select().from(schema.transactions);
    const line = txs2.find((t) => t.entityId === "t_line")!;
    expect(line).toMatchObject({
      checkNumber: "101",
      fitid: "FIT-1",
      ynabId: "YNAB-1",
      importedPayee: "SAFEWAY #123",
      source: "OFX",
      memo: "Lineage holder",
    });
    expect(Number(line.amount)).toBe(-4500);
    const coupon = txs2.find((t) => t.memo === "Free coupon")!;
    expect(Number(coupon.amount)).toBe(0);
    const parent2 = txs2.find((t) => t.entityId === "t_split")!;
    expect(Number(parent2.amount)).toBe(-5000);

    // Schedules: twice-a-month leg + normalized unknown (G-08).
    const rec2 = await db2.select().from(schema.recurring);
    const twice = rec2.find((r) => r.entityId === "sched_twice")!;
    expect(twice).toMatchObject({ frequency: "twiceamonth", anchorDay: 5, secondAnchorDay: 20, active: true });
    const odd = rec2.find((r) => r.entityId === "sched_odd")!;
    expect(odd).toMatchObject({ frequency: "monthly", secondAnchorDay: null });

    // Stock shape means no reconciliation rows in either ledger (G-09).
    expect(await db1.select().from(schema.reconciliations)).toHaveLength(0);
    expect(await db2.select().from(schema.reconciliations)).toHaveLength(0);

    // Out of scope by design: local-only state does not survive.
    const [groceries2] = await db2
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Groceries"));
    expect(groceries2?.goalTarget).toBeNull();
    const [line2] = await db2.select().from(schema.transactions).where(eq(schema.transactions.entityId, "t_line"));
    expect(line2?.needsReview).toBe(false);
    expect(await db2.select().from(schema.duplicateIgnores)).toHaveLength(0);
  });
});
